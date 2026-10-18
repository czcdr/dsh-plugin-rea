#!/usr/bin/env node
/**
 * bundle setup — provision everything a fresh machine needs so that the
 * `mcp-rea` row works, then record the result in <bundle root>/bundle.json.
 *
 * Design rules:
 *  - Idempotent: every stage skips work whose result already verifies.
 *  - Resumable: archives are fetched to a cache and reused; a killed run
 *    continues instead of restarting.
 *  - Honest: a checksum the vendor does not publish is recorded on first fetch
 *    (TOFU) and enforced afterwards; it is never invented.
 *  - Non-destructive: nothing outside the bundle root, the cache, and
 *    bundle.json is written. Existing REA/Ghidra/JDK installs are adopted with
 *    --reuse rather than duplicated.
 *
 * Usage:
 *   node scripts/setup.mjs [options]
 *     --root <dir>        bundle root (default <DSH_HOME>/plugins/rea-bundle)
 *     --cache <dir>       download cache (default <root>/cache)
 *     --reuse             adopt existing node/ghidra/jdk found on this machine
 *     --dry-run           print the plan; download nothing
 *     --json              machine-readable result on stdout
 *     --only <a,b,c>      restrict to named components
 *     --yes               never prompt (implied; this script has no prompts)
 *     --offline           refuse network; only satisfy from cache/reuse
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

/** Windows treats two spellings of one path as equal; the mirror checks must too. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/* ------------------------------------------------------------------ options */

/**
 * DSH home, by the same rule bin/rea-shim.mjs and the published patch use:
 * the environment first, then the conventional location. Both checks are
 * trim-based, because `??` treats an empty variable as a value: with
 * DSH_HOME="" the old expression built the relative root
 * "plugins/rea-bundle", and the shim would then look for bundle.json in the
 * harness's cwd instead of the home the rest of the system agrees on.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homedir(), ".dsh");
}

/** Bundle root: explicit override first, then <DSH_HOME>/plugins/rea-bundle. */
function defaultBundleRoot() {
  const override = process.env.REA_BUNDLE_ROOT;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(dshHome(), "plugins", "rea-bundle");
}

/**
 * A numeric environment override, or the default.
 *
 * `Number("abc")` is NaN, and NaN does not stay local: `REA_BUNDLE_FETCH_RETRIES=abc`
 * produced "gave up after NaN attempt(s)", and a NaN socket timeout behaves as 0
 * (immediate expiry) rather than as "no override". Anything that is not a positive
 * finite number is therefore ignored, and the effective values are logged below so
 * an override is never invisible.
 */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseArgs(argv) {
  const options = {
    root: defaultBundleRoot(),
    cache: null,
    reuse: false,
    dryRun: false,
    json: false,
    only: null,
    offline: false,
    // Two different clocks, because one number cannot serve both: a route must
    // be declared dead quickly when the socket never opens, but a slow-but-alive
    // transfer must not be killed for taking long overall (measured here:
    // 0.35–0.54 MiB/s, where 570 MB legitimately takes ~30 minutes).
    connectTimeoutMs: envNumber("REA_BUNDLE_CONNECT_TIMEOUT_MS", 15000),
    idleTimeoutMs: envNumber("REA_BUNDLE_IDLE_TIMEOUT_MS", 120000),
    retries: envNumber("REA_BUNDLE_FETCH_RETRIES", 4),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i] ?? "";
    else if (arg === "--cache") options.cache = argv[++i] ?? "";
    else if (arg === "--reuse") options.reuse = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--yes") continue;
    else if (arg === "--only") options.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  // Absolute, always. bundle.json records these paths and the shim resolves them
  // against whatever cwd the harness happens to have, so a relative --root would
  // make every recorded component look deleted — the shim reports "the recorded
  // Node runtime is gone" and starts provisioning again, on every single start.
  if (String(options.root).trim() === "") throw new Error("--root needs a directory");
  options.root = path.resolve(options.root);
  if (!options.cache || String(options.cache).trim() === "") options.cache = path.join(options.root, "cache");
  options.cache = path.resolve(options.cache);
  return options;
}

/* -------------------------------------------------------------------- output */

const state = { log: [], steps: [] };

/**
 * Log file. When the shim starts provisioning detached, stdio is discarded, so
 * this file is the only progress channel — and the shim tells the operator
 * exactly this path. Resolved lazily: this module-level helper is defined before
 * the options are parsed.
 */
function logFilePath() {
  return path.join(options.root, "logs", "setup.log");
}
function appendLog(line) {
  try {
    const file = logFilePath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, line + "\n");
  } catch {
    /* logging must never be fatal */
  }
}

function log(message) {
  state.log.push(message);
  appendLog(message);
  if (!options.json) process.stdout.write(message + "\n");
}
function step(name, status, detail) {
  state.steps.push({ name, status, detail });
  const mark = status === "ok" ? "ok  " : status === "skip" ? "skip" : status === "plan" ? "plan" : "FAIL";
  log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}

/* ------------------------------------------------------------------- hashing */

/**
 * Hash a file with a stream. Reading it whole would allocate the file's size
 * (the Ghidra archive is 570 MB) and could not be resumed across a short read.
 */
function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/* ------------------------------------------------------------ proxy support */

/**
 * Where the network expects us to go through a proxy. Resolved once and cached:
 * the Windows lookup spawns reg.exe twice, and doing that per download was
 * pointless work on the same answer.
 *
 * This matters more than it looks: Node's global fetch ignores the system proxy
 * settings entirely, while .NET/PowerShell honour them. On a machine with
 * WinINET's ProxyEnable=1 (here: 127.0.0.1:7890) `Invoke-WebRequest` reaches
 * github.com fine and Node gets ECONNRESET/timeout on the very same URL — which
 * is exactly the failure this function exists to remove.
 *
 * Order: explicit environment first (standard names, either case), then the
 * Windows registry, then NO_PROXY handling.
 */
let proxyResolution;
function resolveProxy() {
  if (proxyResolution !== undefined) return proxyResolution;
  const fromEnv =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy ??
    process.env.ALL_PROXY ?? process.env.all_proxy ?? "";
  let server = fromEnv.trim();

  if (!server && IS_WINDOWS) {
    const result = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8" },
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(result.stdout ?? "");
    if (enabled) {
      const value = spawnSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
        { encoding: "utf8" },
      );
      const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(value.stdout ?? "");
      if (match) server = match[1].trim();
    }
  }
  if (!server) return null;

  // A registry value may be a per-scheme list: "http=host:port;https=host:port".
  if (server.includes("=")) {
    const parts = Object.fromEntries(
      server.split(";").filter(Boolean).map((entry) => {
        const [scheme, target] = entry.split("=");
        return [scheme.trim().toLowerCase(), (target ?? "").trim()];
      }),
    );
    server = parts.https ?? parts.http ?? "";
  }
  if (!server) {
    proxyResolution = null;
    return null;
  }
  if (!/^[a-z]+:\/\//i.test(server)) server = `http://${server}`;

  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    proxyResolution = null;
    return null;
  }
  const bypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  proxyResolution = {
    host: parsed.hostname,
    port: Number(parsed.port || 8080),
    auth: parsed.username
      ? "Basic " + Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")
      : null,
    bypass,
    display: `${parsed.hostname}:${parsed.port || 8080}`,
  };
  return proxyResolution;
}

function bypassesProxy(proxy, target) {
  if (!proxy) return false;
  const host = target.hostname.toLowerCase();
  return proxy.bypass.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern === "*") return true;
    const bare = pattern.replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/**
 * Candidate routes for one URL, in the order they should be tried.
 *
 * Neither route is universally right, and "a proxy is configured" does not mean
 * "a proxy is needed": on the machine this was written for, the local proxy
 * answers github.com correctly but returns 403 for nodejs.org and 404 for
 * dl.google.com, while both are fine directly. The reverse also happens
 * (github.com reset by the network, fine through the proxy). So the direct
 * route is tried first and the proxy is a fallback — with the winner logged, so
 * the behaviour is visible instead of mysterious.
 */
function candidateRoutes(proxy, target) {
  const routes = [{ proxy: null, label: "direct" }];
  if (proxy && !bypassesProxy(proxy, target)) {
    routes.push({ proxy, label: `proxy ${proxy.display}` });
  }
  return routes;
}

/**
 * One HTTPS GET, returning { status, headers, stream, via }. Goes through a
 * CONNECT tunnel when `proxy` is given, otherwise connects directly.
 */
function openGet(url, { proxy, headers, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const useProxy = Boolean(proxy);
    const requestHeaders = { "user-agent": "dsh-plugin-rea-bundle", accept: "*/*", ...headers };
    const connectTimeout = connectTimeoutMs;
    const idleTimeout = options.idleTimeoutMs;
    // Idle, not total: every received chunk pushes the deadline out, so a slow
    // but healthy transfer survives while a stalled one is cut.
    const touch = (socket) => () => socket.setTimeout(idleTimeout);
    const done = (res, via) => {
      res.on("data", touch(res.socket));
      resolve({ status: res.statusCode, headers: res.headers, stream: res, via });
    };

    if (!useProxy) {
      const req = httpsRequest(
        {
          host: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: "GET",
          headers: requestHeaders,
          timeout: connectTimeout,
        },
        (res) => done(res, "direct"),
      );
      let connected = false;
      req.on("socket", (socket) => {
        socket.setTimeout(connectTimeout);
        socket.once("connect", () => {
          connected = true;
          socket.setTimeout(idleTimeout);
        });
      });
      // The socket carries the connect deadline until it connects and the idle
      // deadline afterwards. Reporting the idle number for a connection that never
      // happened sent the reader after the wrong setting.
      req.on("timeout", () =>
        req.destroy(new Error(connected ? `no data within ${idleTimeout}ms` : `no connection within ${connectTimeout}ms`)),
      );
      req.on("error", reject);
      req.end();
      return;
    }

    // Establish a tunnel with CONNECT, then run TLS inside it.
    const connectHeaders = { host: `${target.hostname}:${target.port || 443}` };
    if (proxy.auth) connectHeaders["proxy-authorization"] = proxy.auth;
    const tunnel = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: connectHeaders,
      timeout: connectTimeout,
    });
    tunnel.on("timeout", () => tunnel.destroy(new Error(`proxy CONNECT timeout after ${connectTimeout}ms`)));
    tunnel.on("error", reject);
    tunnel.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT refused with ${res.statusCode}`));
        return;
      }
      const inner = httpsRequest(
        {
          socket,
          agent: false,
          servername: target.hostname,
          path: target.pathname + target.search,
          method: "GET",
          headers: requestHeaders,
          timeout: idleTimeout,
        },
        (response) => done(response, `proxy ${proxy.display}`),
      );
      inner.on("timeout", () => inner.destroy(new Error(`no data within ${idleTimeout}ms`)));
      inner.on("error", reject);
      inner.end();
    });
    tunnel.end();
  });
}

/* ------------------------------------------------------------ download + unzip */

/** The cache file name a URL maps to; used in messages before a download runs. */
function archiveNameFor(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return url;
  }
}

/**
 * Fetch one URL to `destination`, verifying size and checksum.
 *
 * Transfers retry with backoff, resume a partial file through a Range request,
 * and go through the proxy when one applies (see resolveProxy for why that
 * matters). A server that ignores Range is handled by restarting the file.
 */
async function download(url, destination, expected, label) {
  const temporary = destination + ".part";
  const connectTimeoutMs = options.connectTimeoutMs;
  const attempts = Math.max(1, options.retries);
  const proxy = resolveProxy();

  // Resume an interrupted run: a partial file plus a Range request continues
  // where the last attempt stopped instead of paying for the bytes twice.
  let have = existsSync(temporary) ? statSync(temporary).size : 0;
  if (have > 0 && expected.size && have > expected.size) {
    rmSync(temporary, { force: true });
    have = 0;
  }
  // A `.part` already holding every expected byte is finished work, not a resume
  // point: a crash between the last write and the rename leaves exactly this
  // shape. Resuming it sends `Range: bytes=<size>-`, which servers answer with
  // 416, so four attempts later a complete download was reported failed (and on
  // Windows the "resume" simply deleted it and fetched 570 MB again). Verify it
  // and finish the rename instead.
  if (have > 0 && expected.size && have === expected.size) {
    const digest = sha256File(temporary);
    const matches = !expected.sha256 || expected.sha256 === "unverified" || digest === expected.sha256;
    if (matches) {
      log(`       ${label}: partial file was already complete; verified and kept`);
      rmSync(destination, { force: true });
      renameSync(temporary, destination);
      return { sha256: digest, size: have, tofu: !expected.sha256 || expected.sha256 === "unverified" };
    }
    log(`       ${label}: partial file is complete but the checksum does not match; starting over`);
    rmSync(temporary, { force: true });
    have = 0;
  }
  if (have > 0) log(`       downloading ${label} (resuming at ${(have / 1048576).toFixed(1)} MiB)`);
  else log(`       downloading ${label}`);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // --offline is a promise, not a hint: nothing network-facing may run, so
      // the refusal happens before either route is attempted rather than after
      // the first one fails.
      if (options.offline) {
        throw new Error(`${label} is not in the cache (${archiveNameFor(url)}) and --offline forbids fetching it`);
      }
      // Route order differs by design. On Windows the .NET stack is tried first:
      // it honours the system proxy and follows GitHub's release-asset redirect
      // to release-assets.githubusercontent.com correctly, which is exactly what
      // the Node routes fail at here (direct = reset/timeout, proxy = a 301 loop
      // rewriting back to github.com). It also completed nodejs.org's 37 MB zip
      // where the Node route was truncated by 860 bytes on every attempt
      // (nodejs.org advertises no accept-ranges, so a resume can never close
      // that gap). Verified by the same size + checksum gate either way.
      let via = null;
      let nodeFailure = null;
      const tryPowerShellFirst = IS_WINDOWS;
      const viaPowerShell = async () => {
        // Resume through the .NET route as well: it is the Windows default, it
        // honours the system proxy, and the 570 MB Ghidra archive is the transfer
        // that matters. Deleting the partial file first — what this used to do —
        // made every retry a full re-download, the opposite of the resumable
        // behaviour this module promises. downloadViaPowerShell appends only when
        // the server answers 206.
        const written = downloadViaPowerShell(url, temporary, have);
        log(`       ${label}: via powershell (${(written / 1048576).toFixed(1)} MiB)`);
        return "powershell";
      };
      const viaNode = async () => {
        // Both routes write into the same .part. Trusting the `have` captured
        // before this attempt appended a full 200 response onto the bytes the
        // failed route had already written, producing a file that could only fail
        // the size gate on the way out. Read the file's real length instead.
        have = existsSync(temporary) ? statSync(temporary).size : 0;
        const response = await openViaBestRoute(url, { connectTimeoutMs, have });
        await writeBody(response.stream, response.headers, temporary, have, response.status, label);
        return response.via;
      };
      const first = tryPowerShellFirst ? viaPowerShell : viaNode;
      const second = tryPowerShellFirst ? viaNode : viaPowerShell;

      try {
        via = await first();
      } catch (primaryFailure) {
        log(`       ${label}: first route failed (${String(primaryFailure?.message ?? primaryFailure).slice(0, 140)})`);
        nodeFailure = primaryFailure;
        via = await second();
      }
      if (attempt === 1 && via) log(`       ${label}: route ${via}`);
      const produced = statSync(temporary).size;

      if (expected.size && produced !== expected.size) {
        if (produced < expected.size) {
          // A few bytes missing at the tail is this network's signature (860 and
          // 15875 bytes observed on otherwise complete transfers). Asking for
          // the exact remainder is cheaper than re-fetching 37 MB, so the next
          // attempt resumes from `produced`; a fresh start is forced once the
          // attempts run out, so a marginal short read cannot accumulate.
          if (attempt < attempts) {
            log(`       attempt ${attempt}/${attempts} ended short by ${expected.size - produced} byte(s); resuming`);
            have = produced;
            continue;
          }
        }
        rmSync(temporary, { force: true });
        throw new Error(`size mismatch: got ${produced}, expected ${expected.size}`);
      }
      const digest = sha256File(temporary);
      if (expected.sha256 && expected.sha256 !== "unverified" && digest !== expected.sha256) {
        // A bad body is re-downloaded from scratch rather than resumed onto.
        rmSync(temporary, { force: true });
        throw new Error(`sha256 mismatch: got ${digest}, expected ${expected.sha256}`);
      }
      rmSync(destination, { force: true });
      renameSync(temporary, destination);
      return { sha256: digest, size: produced, tofu: !expected.sha256 || expected.sha256 === "unverified" };
    } catch (error) {
      if (attempt < attempts) {
        const wait = 2000 * attempt;
        log(`       attempt ${attempt}/${attempts} failed (${String(error?.message ?? error)}); retrying in ${wait / 1000}s`);
        have = existsSync(temporary) ? statSync(temporary).size : 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      throw new Error(`${url} failed after ${attempts} attempt(s) — ${String(error?.message ?? error)}`);
    }
  }
  throw new Error(`download gave up after ${attempts} attempt(s): ${url}`);
}

/**
 * The PowerShell/.NET route: on Windows this is the **primary** route (see
 * `tryPowerShellFirst` in download()), and everywhere else it exists only as the
 * last-resort fallback.
 *
 * Measured here, it is not redundant with the Node routes. The local proxy
 * rewrites GitHub's release-asset redirect back to itself (an infinite 301
 * loop), while a direct Node connection to github.com times out or is reset.
 * The .NET stack honours the system proxy, follows the redirect chain to
 * release-assets.githubusercontent.com correctly, and reports the full asset
 * length. It is slower (~0.13 MiB/s vs ~0.5 MiB/s), which is why the routes are
 * ordered per platform rather than universally, and
 * the result is verified by the same size + checksum gate as every other route.
 */
function downloadViaPowerShell(url, destination, have = 0) {
  const resume = Number.isFinite(Number(have)) && Number(have) > 0;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$url = '${url.replace(/'/g, "''")}'`,
    `$out = '${destination.replace(/'/g, "''")}'`,
    `$have = ${resume ? Math.trunc(Number(have)) : 0}`,
    "$req = [System.Net.HttpWebRequest]::Create($url)",
    "$req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-plugin-rea-bundle'",
    "$req.AllowAutoRedirect = $true",
    // The response stage. The body-copy stage needs its own deadline: with only
    // Timeout set, a stalled socket inside CopyTo hung forever (spawnSync runs
    // with no total timeout by design, because a slow-but-alive 570 MB transfer
    // is legitimate).
    "$req.Timeout = 60000",
    "$req.ReadWriteTimeout = 120000",
    // Resume instead of starting over. A server that ignores the range answers
    // 200, and the file is then rewritten from the start rather than appended to.
    "if ($have -gt 0) { $req.AddRange($have) }",
    "$resp = $req.GetResponse()",
    "$code = [int]$resp.StatusCode",
    "$stream = $resp.GetResponseStream()",
    "if ($have -gt 0 -and $code -eq 206) { $mode = [System.IO.FileMode]::Append } else { $mode = [System.IO.FileMode]::Create }",
    "$file = New-Object System.IO.FileStream($out, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)",
    "$stream.CopyTo($file)",
    "$file.Flush()",
    "$file.Close()",
    "$stream.Close()",
    "$resp.Close()",
    "Write-Output ('bytes=' + (Get-Item $out).Length)",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 0,
  });
  if (result.status !== 0) {
    throw new Error(`powershell route failed (${result.status}): ${`${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
  }
  return existsSync(destination) ? statSync(destination).size : 0;
}

/**
 * Try each candidate route until one yields a usable response. A route fails on
 * a transport error, or on an HTTP status that is not 2xx/3xx — a proxy that
 * answers 403/404 for a host is not a working route for that host.
 */
async function openViaBestRoute(url, { connectTimeoutMs, have }) {
  const proxies = proxyCache.get(url) ?? resolveProxy();
  proxyCache.set(url, proxies);
  const target = new URL(url);
  const routes = candidateRoutes(proxies, target);
  const failures = [];
  for (const route of routes) {
    try {
      const response = await openGetFollowing(url, { proxy: route.proxy, connectTimeoutMs, have });
      return { ...response, via: route.label === "direct" ? "direct" : route.label };
    } catch (error) {
      failures.push(`${route.label}: ${String(error?.message ?? error)}`);
    }
  }
  throw new Error(failures.join(" | "));
}

const proxyCache = new Map();

/** GET with redirects followed by hand (node:http does not follow them). */
async function openGetFollowing(url, { proxy, connectTimeoutMs, have, hops = 0 }) {
  if (hops > 5) throw new Error(`too many redirects starting at ${url}`);
  const response = await openGet(url, {
    proxy,
    connectTimeoutMs,
    headers: have > 0 ? { range: `bytes=${have}-` } : undefined,
  });
  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    response.stream.resume(); // drain the redirect body
    const next = new URL(response.headers.location, url).toString();
    return openGetFollowing(next, { proxy, connectTimeoutMs, have, hops: hops + 1 });
  }
  if (response.status !== 200 && response.status !== 206) {
    response.stream.resume();
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response;
}

/** Stream a response body onto the partial file, resuming or restarting. */
async function writeBody(stream, headers, temporary, have, status, label) {
  const restarted = have > 0 && status !== 206;
  if (restarted) {
    rmSync(temporary, { force: true });
    have = 0;
  }
  const length = Number(headers["content-length"] ?? headers["Content-Length"] ?? 0);
  const total = length + (restarted ? 0 : have);
  const out = createWriteStream(temporary, restarted ? {} : { flags: "a" });
  let seen = have;
  let nextMark = 0;

  // Progress is reported from the write side; pipe() owns the backpressure, so
  // a 570 MB body never accumulates in memory and a slow disk cannot stall the
  // promise. Settle on the write stream's lifecycle only: the response can end
  // while its last bytes are still buffered, and resolving from that handler
  // raced the promise and left it unsettled (setup hung after a full transfer).
  out.on("pipe", (source) => {
    source.on("data", (chunk) => {
      seen += chunk.length;
      if (total > 0 && seen >= nextMark) {
        const percent = ((seen / total) * 100).toFixed(1);
        if (!options.json) process.stdout.write(`\r       ${label}: ${percent}% (${(seen / 1048576).toFixed(1)} MiB)`);
        nextMark = seen + Math.max(total / 20, 1048576);
      }
    });
  });

  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    stream.on("error", reject);
    stream.pipe(out);
  });
  if (!options.json) process.stdout.write("\r" + " ".repeat(72) + "\r");
  return seen;
}

/** The provisioned JDK's own `jar`, when one is resolved — a guaranteed unzipper. */
function jdkJarCommand(context) {
  const jdk = context?.resolved?.jdk?.path;
  if (typeof jdk !== "string" || jdk === "") return null;
  const home = /[\\/]bin[\\/][^\\/]+$/.test(jdk) ? path.dirname(path.dirname(jdk)) : jdk;
  const candidate = path.join(home, "bin", `jar${EXE}`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Extract with whatever the host actually has.
 *
 * Ghidra ships only as a zip on every platform, so "no unzip" was a certain
 * failure on a minimal Linux image rather than an occasional one. The fallbacks
 * are `python3 -m zipfile` and — since a JDK is provisioned before Ghidra — that
 * JDK's own `jar`. Tarballs fall back to python3, whose tarfile reads xz without
 * the xz binary. A host with none of them is told which tools were tried instead
 * of getting a bare "extraction failed".
 */
function extract(archive, destination, format, context) {
  mkdirSync(destination, { recursive: true });
  const stdio = options.json ? "ignore" : "inherit";
  const attempts = [];
  if (format === "zip") {
    if (IS_WINDOWS) {
      // bsdtar ships with Windows 10+ and unpacks a zip far faster than
      // Expand-Archive's single-threaded .NET implementation — the 543 MB Ghidra
      // archive is the case that matters. A failing tar still falls through to
      // Expand-Archive.
      attempts.push({ command: "tar", args: ["-xf", archive, "-C", destination] });
      attempts.push({
        command: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
        ],
      });
    } else {
      attempts.push({ command: "unzip", args: ["-q", "-o", archive, "-d", destination] });
      attempts.push({ command: "python3", args: ["-m", "zipfile", "-e", archive, destination] });
      const jar = jdkJarCommand(context);
      // `jar xf` unpacks into the working directory, hence cwd.
      if (jar) attempts.push({ command: jar, args: ["xf", archive], cwd: destination });
    }
  } else if (format === "tar.gz" || format === "tar.xz" || format === "tar") {
    attempts.push({ command: "tar", args: ["-xf", archive, "-C", destination] });
    attempts.push({
      command: "python3",
      args: ["-c", "import sys,tarfile;tarfile.open(sys.argv[1]).extractall(sys.argv[2])", archive, destination],
    });
  } else {
    throw new Error(`unsupported archive format: ${format}`);
  }

  let anyToolRan = false;
  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args, { stdio, cwd: attempt.cwd });
    if (result.status === 0) return true;
    if (!(result.error && result.error.code === "ENOENT")) anyToolRan = true;
  }
  if (!anyToolRan) {
    log(`       no ${format === "zip" ? "zip" : "tar"} extractor available (tried ${attempts.map((attempt) => path.basename(attempt.command)).join(", ")}); install unzip or python3`);
  }
  return false;
}

/* --------------------------------------------------------------- host probing */

function hostKey() {
  return `${process.platform}-${process.arch}`;
}

/**
 * Substitute probe tokens. `{root}` is the bundle root; component tokens
 * ({node},{jdk},{ghidra},{jvm},{vendor}) resolve through the components already
 * provisioned or adopted this run, so a reused JDK is found at its real location
 * instead of a vendor path that was never created.
 */
function substituteProbe(value, context) {
  const vendor = context.vendor;
  let text = String(value);
  // A token whose component is unresolved stays literal: the probe then fails
  // with a readable ENOENT (and the component reports "unavailable") instead of
  // throwing out of path.join.
  const swap = (token, resolved) => {
    if (typeof resolved === "string" && resolved !== "") text = text.replaceAll(token, resolved);
  };
  const vendorPath = (name) => {
    const resolved = context.resolved?.[name];
    if (resolved && typeof resolved.path === "string") return resolved.path;
    // A component cannot resolve its own token before it is recorded. While
    // provisioning `node`, {node} means the interpreter already running this
    // script; while provisioning `jdk` or `ghidra`, the copy being unpacked
    // right now is the answer (and {jvm} is its bin/java). Without this the
    // component's own probe fails with a literal "{jvm}" even though the
    // extraction succeeded — which silently discarded a fully downloaded JDK
    // and a 543 MB Ghidra archive.
    if (name === "node") {
      // The component's own probe runs before it is recorded, so this is the one
      // place that must find the vendored runtime directly. {node} means the
      // interpreter, never the directory: returning vendor/node made the probe
      // spawn a folder and fail with ENOENT even though the extraction was fine.
      const installed = path.join(context.vendor, "node");
      const executables = [path.join(installed, `node${EXE}`), path.join(installed, "bin", "node")];
      return executables.find((candidate) => existsSync(candidate)) ?? process.execPath;
    }
    if (name === "jdk") return path.join(context.vendor, "jdk");
    if (name === "ghidra") return path.join(context.vendor, "ghidra");
    return null;
  };
  // Order matters. The path tokens that already carry a Windows extension
  // ({node}, {jvm}) are expanded FIRST, and {exe} LAST. Doing it the other way
  // round turned the apktool probe into
  // "<...>\jdk\bin\java.exe\bin\java.exe": {jvm} resolved to a path ending in
  // java.exe and then {exe} appended a second one.
  swap("{vendor}", vendor);
  swap("{vendorDir}", vendor);
  swap("{root}", context.root);
  swap("{node}", vendorPath("node"));
  swap("{jdk}", vendorPath("jdk"));
  swap("{ghidra}", vendorPath("ghidra"));
  const jdk = vendorPath("jdk");
  if (jdk) {
    // {jdk} resolves to the JDK's java executable (that is what `binaries`
    // records so a dependent component has something spawnable), while
    // REA_JADX_MCP_JAR-style probes want JAVA_HOME. Derive it defensively:
    // strip a trailing bin/java[.exe] if present, otherwise use the path as-is.
    const home = /[\\/]bin[\\/]java(\.exe)?$/i.test(jdk) ? path.dirname(path.dirname(jdk)) : jdk;
    swap("{jvm}", path.join(home, "bin", `java${EXE}`));
    swap("{javahome}", home);
  }
  // {exe} is replaced unconditionally: on POSIX it is the empty string, and the
  // `resolved !== ""` guard in swap() would leave a literal "adb{exe}" behind,
  // which then fails its probe with ENOENT on Linux and macOS.
  text = text.replaceAll("{exe}", EXE);
  return text.replaceAll("/", path.sep);
}

function runProbe(probe, context) {
  if (probe.file) {
    const file = substituteProbe(probe.file, context);
    if (!existsSync(file)) return { ok: false, detail: `${file} is missing` };
    // `expect` used to be ignored for file probes, which made the Ghidra probe's
    // `expect.contains: "application.version="` dead configuration: any file at
    // that path passed, including a directory or a stray placeholder. Read the
    // file — these are small metadata files — and honour the contract. The bound
    // exists so a probe can never be pointed at a 543 MB tree by accident.
    const expect = probe.expect ?? {};
    if (expect.contains || expect.regex) {
      let text = "";
      try {
        text = readFileSync(file, "utf8").slice(0, 65536);
      } catch (error) {
        return { ok: false, detail: `${file} could not be read: ${String(error && error.message)}` };
      }
      if (expect.contains && !text.includes(expect.contains)) {
        return { ok: false, detail: `${file} does not contain "${expect.contains}"` };
      }
      if (expect.regex && !new RegExp(expect.regex, "m").test(text)) {
        return { ok: false, detail: `${file} does not match /${expect.regex}/` };
      }
    }
    return { ok: true, detail: file };
  }
  if (!probe.argv) return { ok: true, detail: "no probe" };
  const argv = probe.argv.map((value) => substituteProbe(value, context));
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 120000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) return { ok: false, detail: `${String(result.error.message)} (${argv[0]})` };
  if (result.status !== 0) return { ok: false, detail: `exit ${result.status}: ${output.trim().slice(0, 200)}` };
  const expect = probe.expect ?? {};
  if (expect.contains && !output.includes(expect.contains)) return { ok: false, detail: `missing "${expect.contains}"` };
  if (expect.regex && !new RegExp(expect.regex, "m").test(output)) return { ok: false, detail: `no match for /${expect.regex}/` };
  return { ok: true, detail: output.trim().split("\n")[0].slice(0, 120) };
}

/**
 * Normalise a component's sources into an ordered list of fetch entries.
 * Two shapes exist in the manifest:
 *   sources:  { "win32-x64": {...}, all: {...} }              — one artifact
 *   entries:  { all: [...], byPlatform: { "win32-x64": [...] } } — many files
 */
function resolveEntries(component) {
  if (component.entries) {
    const key = hostKey();
    const byPlatform = component.entries.byPlatform ?? {};
    return [...(component.entries.all ?? []), ...(byPlatform[key] ?? [])];
  }
  const single = candidateSource(component);
  return single ? [single] : [];
}

function candidateSource(component) {
  const key = hostKey();
  const sources = component.sources ?? {};
  return sources[key] ?? sources.all ?? null;
}

/**
 * A reused Node must satisfy REA's engines, not merely exist.
 *
 * `manifest.components.node.probe` is the contract and its `why` says the reuse
 * path must reject an incompatible runtime *here*: adopting Node 20 recorded it
 * in bundle.json and the failure surfaced much later as an unexplained REA start
 * failure. A candidate that cannot be run at all is rejected for the same reason
 * — on Windows a `.cmd`/`.bat` wrapper fails execFile with EINVAL, so it could
 * never have launched REA either.
 */
function reusableNodeChecked(candidate) {
  const probe = manifest.components?.node?.probe ?? {};
  const argv = (probe.argv ?? []).map((token) => (token === "{node}" ? candidate : token));
  if (argv.length === 0) return { ok: true };
  const run = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (run.error || run.status !== 0) {
    return { ok: false, detail: `it could not be run (${run.error?.code ?? `exit ${run.status}`})` };
  }
  const stdout = String(run.stdout ?? "");
  const firstLine = stdout.trim().split(/\r?\n/)[0] ?? "";
  const regex = probe.expect?.regex;
  if (typeof regex === "string" && regex !== "" && !new RegExp(regex, "u").test(stdout)) {
    return { ok: false, detail: `it reports "${firstLine}", which REA's engines reject` };
  }
  return { ok: true };
}

/** Adopt an existing installation instead of downloading a duplicate. */
function reuseExisting(name, root) {
  if (!options.reuse) return null;
  const fileExists = (file) => file && existsSync(file);
  if (name === "node") {
    const candidates = [];
    const override = process.env.REA_BUNDLE_NODE ?? null;
    if (fileExists(override)) candidates.push({ path: override, how: "REA_BUNDLE_NODE" });
    // Every PATH hit is considered, not just the first: a machine with an
    // incompatible Node earlier on PATH still has a usable one later on.
    const found = spawnSync(IS_WINDOWS ? "where" : "which", ["node"], { encoding: "utf8" });
    for (const line of String(found.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      candidates.push({ path: line, how: "PATH" });
    }
    const seen = new Set();
    for (const candidate of candidates) {
      const key = path.resolve(candidate.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const checked = reusableNodeChecked(candidate.path);
      if (checked.ok) return candidate;
      step("node", "plan", `not reusing ${candidate.how} node ${candidate.path}: ${checked.detail}`);
    }
    return null;
  }
  if (name === "jdk") {
    for (const [variable, how] of [["JAVA_HOME", "JAVA_HOME"]]) {
      const home = process.env[variable];
      if (home && existsSync(path.join(home, "bin", `javac${EXE}`))) return { path: home, how };
    }
    return null;
  }
  if (name === "ghidra") {
    const install = process.env.GHIDRA_INSTALL_DIR;
    if (install && existsSync(path.join(install, "support", IS_WINDOWS ? "analyzeHeadless.bat" : "analyzeHeadless"))) {
      return { path: install, how: "GHIDRA_INSTALL_DIR" };
    }
    return null;
  }
  if (name === "browser") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = IS_WINDOWS
      ? [
          // Chrome per-user install is the common shape on Windows and is
          // missed by a Program Files-only probe.
          localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ].filter(Boolean)
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
    for (const candidate of candidates) if (existsSync(candidate)) return { path: candidate, how: "installed browser" };
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------- manifest */

/**
 * Where this run's plugin files actually live.
 *
 * Two layouts exist. Normally setup runs from the plugin checkout and
 * PLUGIN_ROOT is the truth. But the row launches the *mirrored* copy at
 * <bundle>/bin/rea-shim.mjs, whose remediation text tells the operator to run
 * <bundle>/scripts/setup.mjs — and in that layout PLUGIN_ROOT *is* the bundle
 * root, so the mirror step would copy every file onto itself and loadManifest()
 * would read a manifest that only the mirror step can create.
 *
 * setup therefore records the real checkout in <bundle>/mirror.json and a
 * mirrored run reads it back. The record is advisory: it is honoured only while
 * that directory still holds a manifest, so a moved or deleted plugin degrades
 * to the mirrored copy instead of failing.
 */
function sourceRoot() {
  const self = path.resolve(PLUGIN_ROOT);
  if (!samePath(self, options.root)) return self;
  try {
    const record = JSON.parse(readFileSync(path.join(options.root, "mirror.json"), "utf8"));
    const recorded = record?.pluginRoot;
    if (typeof recorded === "string" && recorded.trim() !== "") {
      const candidate = path.resolve(recorded);
      if (existsSync(path.join(candidate, "manifest", "bundle.manifest.json"))) return candidate;
    }
  } catch {
    /* no record, or not readable: the mirrored copy is the only source left */
  }
  return self;
}

function loadManifest() {
  const file = path.join(sourceRoot(), "manifest", "bundle.manifest.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed;
}

/**
 * Read a bundle.json, tolerating one that is not valid JSON.
 *
 * A half-written file (disk full, a kill mid-write) used to throw straight out of
 * provisioning — the run died before it could replace the file it could not
 * parse, and the shim then failed on it forever. Treating it as absent lets the
 * normal path read what is usable and rewrite the record at the end.
 */
function readBundleJson(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    log(`       ${path.basename(file)} is not readable JSON (${String(error && error.message)}); ignoring it for this run`);
    return null;
  }
}

const INSTALL_ORDER = ["node", "jdk", "ghidra", "apktool", "jadxHeadlessMcp", "androidPlatformTools", "reaAgents"];

/* -------------------------------------------------------------------- stages */

async function provisionComponent(name, component, context) {
  const root = context.root;
  const vendor = path.join(root, "vendor");

  // 1) adopt an existing install first: a reused component is authoritative and
  //    makes the recorded-state check below redundant (and its message wrong).
  const reused = reuseExisting(name, root);
  if (reused) {
    // A candidate is a claim until the component's own probe agrees. Adoption
    // tested only that javac / analyzeHeadless / node exists, so a JDK 11 (Ghidra
    // 12.1 needs 21+) or a Ghidra 11 install was recorded in bundle.json and the
    // failure surfaced much later, inside REA. Run the same probe a provisioned
    // copy has to pass, with the candidate planted so the probe's own tokens
    // ({jvm}, {ghidra}) resolve to it instead of to a vendor path it never had.
    const planted = context.resolved[name];
    context.resolved[name] = { path: reused.path };
    let probe;
    try {
      probe = runProbe(component.probe ?? {}, context);
    } finally {
      if (planted === undefined) delete context.resolved[name];
      else context.resolved[name] = planted;
    }
    if (probe.ok) {
      step(name, "skip", `reusing existing ${name} from ${reused.how}: ${reused.path}`);
      return { path: reused.path, reused: true };
    }
    step(name, "plan", `not reusing ${reused.how} ${name} at ${reused.path}: ${probe.detail}`);
  }

  // 2) already present in the bundle and still verifiable?
  //
  // A recorded entry is a claim, not a fact: a previous run may have recorded a
  // component it could not provision (path null / unavailable), and files can be
  // deleted afterwards. Only a recorded path that exists AND passes the probe is
  // trusted; anything else falls through to provisioning again.
  if (existsSync(path.join(root, "bundle.json"))) {
    const current = readBundleJson(path.join(root, "bundle.json"));
    const recorded = current?.components?.[name];
    if (recorded && typeof recorded.path === "string" && existsSync(recorded.path)) {
      const probe = runProbe(component.probe ?? {}, context);
      if (probe.ok) {
        step(name, "skip", `already provisioned (${recorded.version ?? "recorded"})`);
        return recorded;
      }
      step(name, "plan", `recorded but unverifiable: ${probe.detail}`);
    } else if (recorded) {
      step(name, "plan", "recorded without a usable path; provisioning again");
    }
  }

  // 3) the browser is never downloaded
  if (name === "browser") {
    step(name, "skip", "no Chromium-family browser found; browser scenarios stay unavailable");
    return null;
  }

  if (name === "reaAgents") {
    return provisionReaAgents(component, context);
  }

  const entries = resolveEntries(component);
  if (entries.length === 0) {
    step(name, "FAIL", `no source for ${hostKey()}`);
    return null;
  }

  /* Multi-file components: fetch and place every file, then probe once. */
  if (component.kind === "multi-file" || component.kind === "file") {
    const placed = [];
    for (const entry of entries) {
      const targetDirectory = path.join(vendor, entry.moveTo ?? component.unpack?.moveTo ?? name);
      if (options.dryRun) {
        step(`${name}:${entry.id ?? "file"}`, "plan", `${entry.url} -> ${path.join(targetDirectory, entry.saveAs ?? path.basename(new URL(entry.url).pathname))}`);
        continue;
      }
      const archiveName = path.basename(new URL(entry.url).pathname);
      const archivePath = path.join(context.cache, archiveName);
      let fetched = null;
      if (existsSync(archivePath)) {
        const digest = sha256File(archivePath);
        const size = statSync(archivePath).size;
        if ((!entry.size || size === entry.size) && (entry.sha256 === "unverified" || digest === entry.sha256)) {
          fetched = { sha256: digest, tofu: !entry.sha256 || entry.sha256 === "unverified" };
          log(`       using cached ${archiveName}`);
        } else {
          rmSync(archivePath, { force: true });
        }
      }
      if (!fetched) {
        if (options.offline) {
          step(`${name}:${entry.id ?? "file"}`, "FAIL", `offline and ${archiveName} is not in the cache`);
          continue;
        }
        try {
          fetched = await download(entry.url, archivePath, entry, `${name} ${entry.version ?? ""}`);
        } catch (error) {
          step(`${name}:${entry.id ?? "file"}`, "FAIL", String(error.message));
          continue;
        }
      }
      mkdirSync(targetDirectory, { recursive: true });
      const target = path.join(targetDirectory, entry.saveAs ?? archiveName);
      copyFileSync(archivePath, target);
      // A wrapper script has to be executable. copyFileSync lands the 0644 that
      // the archive carries and nothing else in this file changes a mode, while
      // REA starts REA_APKTOOL_COMMAND through execFile/no shell — so on POSIX a
      // 0644 wrapper fails with EACCES. The component's own probe misses it
      // because it runs `java -jar` and never executes the wrapper.
      if (entry.executable === true) {
        try {
          chmodSync(target, 0o755);
        } catch {
          /* a filesystem that cannot carry the bit must not fail the component */
        }
      }
      placed.push({ target, sha256: fetched.sha256, tofu: fetched.tofu });
    }
    if (options.dryRun) return { planned: true };
    const probe = runProbe(component.probe ?? {}, context);
    if (placed.length === 0) {
      step(name, "FAIL", "nothing could be fetched");
      return null;
    }
    step(name, probe.ok ? "ok" : "FAIL", `${placed.map((item) => item.target).join(", ")}${probe.ok ? "" : " — " + probe.detail}`);
    return probe.ok
      ? {
          path: path.dirname(placed[0].target),
          jarName: path.basename(placed[0].target),
          version: entries[0].version,
          sha256: placed[0].sha256,
          tofu: placed.some((item) => item.tofu),
        }
      : null;
  }

  const source = entries[0];
  if (options.dryRun) {
    step(name, "plan", `${source.url} -> ${path.join(vendor, component.unpack?.moveTo ?? name)}`);
    return { planned: true, version: source.version };
  }

  const archiveName = path.basename(new URL(source.url).pathname);
  const archivePath = path.join(context.cache, archiveName);
  let fetched;
  if (existsSync(archivePath)) {
    const size = statSync(archivePath).size;
    const digest = sha256File(archivePath);
    const matches = (!source.size || size === source.size) && (source.sha256 === "unverified" || digest === source.sha256);
    if (matches) {
      fetched = { sha256: digest, size, cached: true };
      log(`       using cached ${archiveName}`);
    } else {
      rmSync(archivePath, { force: true });
    }
  }
  if (!fetched) {
    if (options.offline) {
      step(name, "FAIL", `offline and ${archiveName} is not in the cache`);
      return null;
    }
    try {
      fetched = await download(source.url, archivePath, source, `${name} ${source.version ?? ""}`);
    } catch (error) {
      step(name, "FAIL", String(error.message));
      return null;
    }
  }

  // single-file components
  if (source.format === "file") {
    const targetDirectory = path.join(vendor, component.unpack?.moveTo ?? name);
    mkdirSync(targetDirectory, { recursive: true });
    const target = path.join(targetDirectory, source.saveAs ?? archiveName);
    copyFileSync(archivePath, target);
    const probe = runProbe(component.probe ?? {}, context);
    step(name, probe.ok ? "ok" : "FAIL", `${target}${probe.ok ? "" : " — " + probe.detail}`);
    return probe.ok ? { path: target, version: source.version, sha256: fetched.sha256 } : null;
  }

  const target = path.join(vendor, component.unpack?.moveTo ?? name);
  rmSync(target, { recursive: true, force: true });
  const staging = target + ".staging";
  rmSync(staging, { recursive: true, force: true });
  const unpacked = extract(archivePath, staging, source.format, context);
  if (!unpacked) {
    step(name, "FAIL", `extraction failed for ${archiveName}`);
    return null;
  }
  const strip = component.unpack?.stripRootComponents ?? 0;
  let effective = staging;
  for (let level = 0; level < strip; level += 1) {
    // Descend into the archive's single root directory. If the level is not a
    // single directory (some archives are already flat), stop rather than guess.
    const entries = readdirSync(effective).filter((entry) => !entry.startsWith("."));
    if (entries.length !== 1 || !statSync(path.join(effective, entries[0])).isDirectory()) break;
    effective = path.join(effective, entries[0]);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(effective, target);
  rmSync(staging, { recursive: true, force: true });

  const probe = runProbe(component.probe ?? {}, context);
  step(name, probe.ok ? "ok" : "FAIL", `${target}${probe.ok ? "" : " — " + probe.detail}`);
  if (!probe.ok) return null;
  // A component's resolved path is a DIRECTORY, but `requires` needs something
  // spawnable: without this, {node} would resolve to vendor/node and the probe
  // for a dependent component would try to launch a directory (ENOENT).
  let resolvedPath = target;
  for (const relative of component.binaries ?? []) {
    const candidate = path.join(target, ...relative.split("/").map((part) => part.replaceAll("{exe}", EXE)));
    if (existsSync(candidate)) {
      resolvedPath = candidate;
      break;
    }
  }
  return { path: resolvedPath, root: target, version: source.version, sha256: fetched.sha256, tofu: fetched.tofu };
}

/**
 * The registry tarball for rea-agents ships NO node_modules (verified: 1161
 * entries, 0 under node_modules), so unpacking it alone yields a CLI that
 * cannot import its own dependencies. A real install is therefore required to
 * resolve the closure into the vendor directory.
 */
async function provisionReaAgents(component, context) {
  const installRoot = path.join(context.root, "vendor");
  // npm --prefix installs into <root>/node_modules, not <root>/<name>.
  const vendor = path.join(installRoot, "node_modules", "rea-agents");
  const version = component.sources.npm.version;
  const probe = () =>
    runProbe(
      { argv: ["{node}", path.join(vendor, "scripts", "rea.mjs"), "--version"], expect: { regex: `^${version.replace(/\./g, "\\.")}` } },
      context,
    );

  if (existsSync(path.join(vendor, "scripts", "rea.mjs"))) {
    const current = probe();
    if (current.ok) {
      step("reaAgents", "skip", `already vendored (${version})`);
      return { path: vendor, version };
    }
    log(`       vendored copy is unusable (${current.detail}); reinstalling`);
  }

  if (options.dryRun) {
    step("reaAgents", "plan", `npm install ${component.sources.npm.registry.replace("https://registry.npmjs.org/", "")}@${version} --prefix ${installRoot}`);
    return { planned: true, version };
  }

  // `--offline is a promise, not a hint` — and this is the one step that cannot be
  // served from the cache: it is an npm install, not a download. It used to run
  // anyway, so a machine with every archive pre-cached still went to the registry
  // (or failed there) after the flag had promised it would not.
  if (options.offline) {
    step("reaAgents", "FAIL", `--offline and the vendored REA at ${vendor} is not usable; npm install needs the registry (drop --offline or pre-install it)`);
    return null;
  }

  /*
   * A plain pack+unpack cannot work here: the published tarball carries no
   * node_modules, so the CLI would fail with ERR_MODULE_NOT_FOUND on its own
   * dependencies. A real install resolves the dependency closure.
   *
   * Lifecycle scripts are skipped on purpose. REA needs no build step, the
   * vendored copy must be byte-predictable, and pnpm/npm would otherwise be
   * free to run arbitrary package scripts during a provisioning step.
   */
  mkdirSync(installRoot, { recursive: true });

  /*
   * Resolve npm, do not assume it.
   *
   * On the machine this bundle exists for, `npm` is only on PATH because a
   * system Node happens to be installed; the bootstrap's whole job is the case
   * where it is not. A bare `spawnSync("npm", ...)` therefore dies with ENOENT
   * on exactly the target machine — and did, until this was fixed. The vendored
   * or discovered Node ships its own npm-cli.js, which is used instead.
   */
  const nodeRuntime = context.resolved.node?.path && existsSync(context.resolved.node.path)
    ? context.resolved.node.path
    : process.execPath;
  const npmCandidates = [
    // Portable Windows zip: <node>\node_modules\npm\bin\npm-cli.js
    path.join(path.dirname(nodeRuntime), "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX tarball: <node>/lib/node_modules/npm/bin/npm-cli.js
    path.join(path.dirname(nodeRuntime), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // An installed Node: <prefix>/lib/node_modules/..., also covered above.
    path.join(path.dirname(nodeRuntime), "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = npmCandidates.find((candidate) => existsSync(candidate)) ?? null;

  const installArgs = [
    "install",
    `rea-agents@${version}`,
    "--prefix", installRoot,
    "--no-save",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel", "error",
  ];
  if (!npmCli) {
    step("reaAgents", "FAIL", `no npm-cli.js next to ${nodeRuntime}; cannot resolve the dependency closure without npm`);
    return null;
  }
  log(`       ${path.relative(installRoot, npmCli) || npmCli} (vendored npm, not PATH)`);
  const install = spawnSync(nodeRuntime, [npmCli, ...installArgs], {
    cwd: installRoot,
    encoding: "utf8",
    timeout: 1800000,
  });
  if (install.status !== 0) {
    step("reaAgents", "FAIL", `npm install failed (${install.status}): ${`${install.stderr ?? ""}${install.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
    // Every other component can fall back to the proxy route this script resolves
    // itself; npm cannot, and this step is the one that fails most often on a
    // network where the registry needs a mirror.
    log("       npm reads HTTPS_PROXY/HTTP_PROXY and NPM_CONFIG_REGISTRY from the environment (this script's own proxy routing does not apply here)");
    return null;
  }

  const current = probe();
  step("reaAgents", current.ok ? "ok" : "FAIL", `${vendor}${current.ok ? "" : " — " + current.detail}`);
  return current.ok ? { path: vendor, version } : null;
}

/* ---------------------------------------------------------------------- main */

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "") + "\n");
  process.exit(0);
}

mkdirSync(options.root, { recursive: true });
mkdirSync(options.cache, { recursive: true });

log(`rea bundle setup`);
log(`  plugin   ${sourceRoot()}`);
log(`  root     ${options.root}`);
log(`  cache    ${options.cache}`);
log(`  host     ${hostKey()}  node ${process.versions.node}`);
log(`  mode     ${options.dryRun ? "dry-run " : ""}${options.reuse ? "reuse " : ""}${options.offline ? "offline" : "online"}`.trimEnd());
// Printed so an environment override is visible: a typo used to reach the socket
// layer as NaN (and as "gave up after NaN attempt(s)") with nothing to see.
log(`  limits   connect=${options.connectTimeoutMs}ms idle=${options.idleTimeoutMs}ms retries=${options.retries}`);
log("");

const manifest = loadManifest();
const context = {
  root: options.root,
  cache: options.cache,
  vendor: path.join(options.root, "vendor"),
  resolved: {},
};
const results = {};

/**
 * What a previous run recorded.
 *
 * `--only` names a subset of components, so this run's `results` describes only
 * that subset — and writing bundle.json straight from `results` erased every
 * other component: the JDK and Ghidra disappeared from `paths`, the shim stopped
 * exporting JAVA_HOME/GHIDRA_INSTALL_DIR, so `setup.mjs --only androidPlatformTools`
 * silently disabled native analysis on a fully provisioned machine, and the next
 * full run had to unpack 750 MB again. Components this run does not touch are
 * carried over instead.
 */
const previous = readBundleJson(path.join(options.root, "bundle.json"));

/** One untouched component's record, kept only while its recorded path exists. */
function carriedOver(name) {
  const record = previous?.components?.[name];
  if (!record || typeof record !== "object") return null;
  if (typeof record.path === "string" && record.path !== "") {
    if (existsSync(record.path)) return record;
    return { ...record, path: null, unavailable: true, reason: "the recorded path is gone" };
  }
  return record;
}

for (const name of INSTALL_ORDER) {
  const component = manifest.components[name];
  if (!component) continue;
  if (options.only && !options.only.includes(name)) continue;
  const missingRequirement = (component.requires ?? []).find((requirement) => !context.resolved[requirement]);
  if (missingRequirement) {
    // Under --only the requirement is not being provisioned this run, but the
    // previous run's record still answers it — and that is the same answer a full
    // run would use. Skipping the check entirely made `--only apktool` resolve
    // {jvm} to the vendor/jdk that only a full run creates and report FAIL, on a
    // machine whose JDK was recorded right next to it.
    let carried = options.only ? carriedOver(missingRequirement) : null;
    if (!carried && options.only) {
      // A requirement can also be answered by the machine instead of the record.
      // `node` always can: a Node is already running this script, and
      // provisionReaAgents falls back to exactly that interpreter — without this,
      // `--only reaAgents` on a fresh root failed on a "missing" node the run is
      // itself made of. The others are answered when the caller passed --reuse.
      if (missingRequirement === "node") {
        carried = { path: process.execPath, reused: true, how: "the interpreter running setup" };
      } else {
        const reused = reuseExisting(missingRequirement, options.root);
        if (reused) carried = { path: reused.path, reused: true, how: reused.how };
      }
    }
    if (!carried || typeof carried.path !== "string" || !existsSync(carried.path)) {
      step(name, "FAIL", `skipped: required component "${missingRequirement}" is unavailable`);
      results[name] = null;
      continue;
    }
    context.resolved[missingRequirement] = carried;
  }
  let resolvedValue = null;
  try {
    resolvedValue = await provisionComponent(name, component, context);
  } catch (error) {
    // An unexpected throw used to abort the run before it could write a summary
    // or record why its lock is still there. Report it as this component's
    // failure instead, so the exit code and the log stay truthful.
    step(name, "FAIL", `unexpected error: ${String(error?.message ?? error)}`);
    resolvedValue = null;
  }
  results[name] = resolvedValue;
  // A component satisfies another's `requires` when it has a real path — or when
  // this run only *planned* it. In dry-run every component returns
  // `{ planned: true }` with no path, so counting only real paths made each
  // dependent plan entry look like a missing dependency: on a bare machine, which
  // is exactly the machine the README tells to run `--dry-run` first, the whole
  // chain reported FAIL and the command exited 1.
  if (resolvedValue && (typeof resolvedValue.path === "string" || resolvedValue.planned === true)) {
    context.resolved[name] = resolvedValue;
  }
}

/* Components this run does not touch keep the record the previous run wrote. */
const merged = { ...results };
for (const name of INSTALL_ORDER) {
  if (Object.prototype.hasOwnProperty.call(merged, name)) continue;
  if (!manifest.components[name]) continue;
  const carried = carriedOver(name);
  if (carried) merged[name] = carried;
}

/* browser is adopted, never downloaded */
const browser = reuseExisting("browser", options.root);
if (browser) step("browser", "skip", `adopting ${browser.path}`);

/* --------------------------------------------------------------- wire + probe */

const nodePath = typeof merged.node?.path === "string" && existsSync(merged.node.path)
  ? merged.node.path
  : process.execPath;

const paths = {
  node: nodePath,
  reaEntry: path.join(options.root, "vendor", "node_modules", "rea-agents", "scripts", "rea.mjs"),
  ghidra: merged.ghidra?.path ?? null,
  jdk: merged.jdk?.path ?? null,
  adb: merged.androidPlatformTools?.path ? path.join(merged.androidPlatformTools.path, `adb${EXE}`) : null,
  apktoolCommand: merged.apktool?.path
    ? path.join(merged.apktool.path, IS_WINDOWS ? "apktool.bat" : "apktool")
    : null,
  jadxJar: merged.jadxHeadlessMcp?.path
    ? path.join(merged.jadxHeadlessMcp.path, merged.jadxHeadlessMcp.jarName ?? "")
    : null,
  browser: browser?.path ?? null,
  ilspycmd: process.env.REA_ILSPY_CMD_PATH ?? null,
};

if (!options.dryRun) {
  const bundleConfig = {
    schema: 1,
    provisionedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.versions.node },
    plugin: { name: "dsh-plugin-rea", root: sourceRoot() },
    paths,
    versions: {
      reaAgents: merged.reaAgents?.version ?? null,
      ghidra: merged.ghidra?.version ?? null,
      jdk: merged.jdk?.version ?? null,
      apktool: merged.apktool?.version ?? null,
      jadxHeadlessMcp: merged.jadxHeadlessMcp?.version ?? null,
      node: merged.node?.version ?? process.versions.node,
    },
    components: Object.fromEntries(
      Object.entries(merged).map(([name, value]) => [name, value ?? { path: null, unavailable: true }]),
    ),
    unverifiedChecksums: Object.entries(merged)
      .filter(([, value]) => value?.tofu)
      .map(([name]) => name),
  };
  writeFileSync(path.join(options.root, "bundle.json"), JSON.stringify(bundleConfig, null, 2) + "\n");
  step("wire", "ok", path.join(options.root, "bundle.json"));

  // The row launches <DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs; create it
  // before probing, so the probe exercises exactly what the row will start.
  mirrorLauncher(context);

  // Readiness probe: REA's own verdict, run through the vendored CLI.
  //
  // `rea doctor` exits non-zero when any check is unmet, and on Windows some
  // checks are unmet by upstream design (Hopper is macOS-only; IDA needs a
  // user-owned IDA). A non-zero exit is therefore NOT a provisioning failure:
  // what matters is that the CLI runs, emits parseable JSON, and reports the
  // tool catalog. Unmet checks are reported, not treated as errors.
  const reaEntry = paths.reaEntry;
  if (existsSync(reaEntry)) {
    const doctor = spawnSync(nodePath, [reaEntry, "doctor", "--json"], { encoding: "utf8", timeout: 300000 });
    const stdout = doctor.stdout ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const unmet = (parsed.checks ?? []).filter((check) => !check.ok);
      const tools = parsed.identity?.catalog?.counts?.mcp_tools ?? "?";
      step("probe", "ok", `cli=${parsed.identity?.cli_package_version ?? "?"} healthy=${parsed.healthy} tools=${tools} unmet=${unmet.length}`);
      for (const check of unmet) log(`       unmet: ${check.name} — ${check.remediation ?? check.detail ?? ""}`);
    } else {
      step(
        "probe",
        "FAIL",
        `rea doctor produced no JSON (exit ${doctor.status}): ${`${stdout}${doctor.stderr ?? ""}`.trim().slice(0, 200)}`,
      );
    }
  } else {
    step("probe", "FAIL", "vendored REA CLI is missing; the MCP row will report unprovisioned");
  }

  // The real end-to-end check: launch the exact shim the MCP row will use
  // (the mirrored copy, not the source tree) and confirm it relays the CLI.
  const mirroredShim = path.join(options.root, "bin", "rea-shim.mjs");
  if (existsSync(mirroredShim)) {
    const shim = spawnSync(process.execPath, [mirroredShim, "--version"], {
      encoding: "utf8",
      timeout: 120000,
      // Pin the bundle path: this step exists to confirm the shim relays the REA
      // THIS run provisioned. Under the default `auto` mode a machine that also
      // has a newer global REA answers with its own version, and the step would
      // report success for something this run never verified.
      env: { ...process.env, REA_BUNDLE_ROOT: options.root, REA_BUNDLE_LAUNCH: "bundle" },
    });
    const output = `${shim.stdout ?? ""}${shim.stderr ?? ""}`.trim();
    const ok = shim.status === 0 && /\d+\.\d+\.\d+/.test(output);
    step("shim", ok ? "ok" : "FAIL", ok ? `resolved to REA ${output.split(/\r?\n/)[0]}` : output.slice(0, 240));
  } else {
    step("shim", "FAIL", `the launcher the patch expects is missing: ${mirroredShim}`);
  }
} else {
  step("wire", "plan", `would write ${path.join(options.root, "bundle.json")}`);
}

/* ------------------------------------------------------------------ mirroring */

/**
 * Copy the launcher into the bundle root.
 *
 * The published patch points at `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`
 * and nothing else creates that file, so without this step the MCP row would
 * reference a path that never exists — provisioning could succeed completely and
 * the row would still fail with MODULE_NOT_FOUND. Everything the shim needs at
 * run time is mirrored next to it, because the shim derives its plugin root from
 * its own location.
 *
 * Runs before the probe so the probe tests what the row actually launches.
 */
function mirrorLauncher(context) {
  const source = sourceRoot();
  const sources = [
    ["bin/rea-shim.mjs", path.join("bin", "rea-shim.mjs")],
    ["scripts/setup.mjs", path.join("scripts", "setup.mjs")],
    // The manifest travels with the mirrored setup: that copy resolves its own
    // plugin root to the bundle root, so loadManifest() would otherwise read
    // <bundle>/manifest/bundle.manifest.json — a file only this step can create.
    // Without it, every later run of the mirror dies in loadManifest() with a
    // bare ENOENT (invisible when the shim started it detached), and the shim's
    // own remediation text sends the operator straight into that failure.
    ["manifest/bundle.manifest.json", path.join("manifest", "bundle.manifest.json")],
  ];
  const copied = [];
  for (const [from, to] of sources) {
    const origin = path.join(source, ...from.split("/"));
    if (!existsSync(origin)) {
      step("mirror", "FAIL", `cannot mirror ${from}: not found in ${source}`);
      return false;
    }
    const target = path.join(context.root, ...to.split("/"));
    if (samePath(origin, target)) {
      // Running from the mirror, with no usable record of the original checkout:
      // the file is already the one the row launches. Copying it onto itself
      // would report success while doing nothing.
      copied.push(`${to.replaceAll("\\", "/")} (in place)`);
      continue;
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(origin, target);
    } catch (error) {
      // A read-only or occupied bundle root must produce a readable step failure
      // rather than a raw stack — when the shim starts this detached, stderr is
      // discarded and the log is the only channel the operator has.
      step("mirror", "FAIL", `cannot write ${target}: ${String(error && error.message)}`);
      return false;
    }
    copied.push(to.replaceAll("\\", "/"));
  }
  writeMirrorRecord(context, source);
  step("mirror", "ok", `${path.join(context.root, "bin", "rea-shim.mjs")} (${copied.join(", ")})`);
  return true;
}

/**
 * Remember which checkout these files came from, so a later mirrored run — or a
 * plugin upgrade, which replaces the checkout but not the bundle — can go back
 * to the real source instead of copying the bundle onto itself and provisioning
 * the previous manifest forever. Advisory only; see sourceRoot().
 */
function writeMirrorRecord(context, source) {
  const record = { schema: 1, pluginRoot: source, mirroredAt: new Date().toISOString() };
  // Provenance for the self-healing check: the mirrored shim compares itself
  // with `<pluginRoot>/bin/rea-shim.mjs` and re-execs that one when the plugin
  // has moved on. These two fields are what `--shim-status` shows when the
  // comparison cannot be made (missing checkout, unreadable file).
  try {
    record.shimSha256 = createHash("sha256")
      .update(readFileSync(path.join(context.root, "bin", "rea-shim.mjs")))
      .digest("hex");
  } catch {
    /* the copy is missing or unreadable; the shim reports the comparison itself */
  }
  try {
    record.pluginVersion = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).version ?? null;
  } catch {
    record.pluginVersion = null;
  }
  try {
    mkdirSync(context.root, { recursive: true });
    writeFileSync(path.join(context.root, "mirror.json"), JSON.stringify(record, null, 2) + "\n");
  } catch (error) {
    // An unwritable root must not fail provisioning; the only cost is that a
    // mirrored run cannot find the original checkout again.
    log(`       mirror.json not written: ${String(error && error.message)}`);
  }
}

/* -------------------------------------------------------------------- summary */

/**
 * The manifest may declare a component optional (adb today: without a device
 * those tools simply report no devices). Ignoring that field made an unreachable
 * dl.google.com fail the whole run — on a machine where everything REA actually
 * needs had provisioned fine. An optional failure is reported, never hidden, and
 * it never fails the run; the component is simply left unrecorded, so the next
 * run retries it.
 *
 * A component that another component `requires` is never treated as optional,
 * whatever the manifest says: exiting 0 because a dependency "was optional"
 * would strand the dependent component with no diagnostic.
 */
const requiredByOthers = (name) =>
  INSTALL_ORDER.some((other) => other !== name && (manifest.components?.[other]?.requires ?? []).includes(name));
const optionalFailure = (entry) => {
  const component = String(entry.name).split(":")[0];
  return manifest.components?.[component]?.optional === true && !requiredByOthers(component);
};

const failures = state.steps.filter((entry) => entry.status === "FAIL");
const failed = failures.filter((entry) => !optionalFailure(entry));
const optionalUnavailable = failures.filter(optionalFailure);

/*
 * Lock bookkeeping is not presentation, and it used to sit inside the
 * non-`--json` branch: a successful `--json` run therefore left the lock behind,
 * and the shim then reported "provisioning started in the background" for six
 * hours on a fully provisioned machine. A failing run keeps the lock on purpose —
 * so a restart loop cannot re-download forever — but marks it failed, which lets
 * the shim say what actually happened instead of claiming a run is in flight.
 */
const lockFile = path.join(options.root, "setup.lock");
if (failed.length === 0) {
  rmSync(lockFile, { force: true });
} else {
  try {
    writeFileSync(lockFile, JSON.stringify({ state: "failed", pid: process.pid, at: Date.now(), exit: 1, log: logFilePath() }) + "\n");
  } catch {
    /* the lock is advisory: a read-only root must not break the report */
  }
}

if (options.json) {
  process.stdout.write(
    JSON.stringify(
      { ok: failed.length === 0, steps: state.steps, log: state.log, optionalUnavailable: optionalUnavailable.map((entry) => entry.name) },
      null,
      2,
    ) + "\n",
  );
} else {
  log("");
  log(failed.length === 0 ? "setup complete." : `setup finished with ${failed.length} unmet step(s).`);
  for (const entry of failed) log(`  unmet: ${entry.name} — ${entry.detail}`);
  if (optionalUnavailable.length > 0) {
    log("");
    log("optional component(s) unavailable — the bundle works without them:");
    for (const entry of optionalUnavailable) log(`  optional: ${entry.name} — ${entry.detail}`);
  }
  log("");
  if (failed.length === 0) {
    log("restart DSH (or reload the profile) so the MCP row reconnects.");
    // Point at the mirrored copy, not at this checkout's: the mirror resolves its
    // bundle from its own location, so this command is right for the root this run
    // actually provisioned — including a custom --root.
    log(`status: node ${path.join(options.root, "bin", "rea-shim.mjs")} --shim-status`);
  } else {
    log("some components are unmet; fix the cause and re-run this command.");
  }
  log(`log: ${logFilePath()}`);
}
process.exit(failed.length === 0 ? 0 : 1);
