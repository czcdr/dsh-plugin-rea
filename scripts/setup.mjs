#!/usr/bin/env node
/**
 * bundle setup — provision everything a fresh machine needs so that the
 * `mcp-rea` row works, then record the result in <bundle root>/bundle.json.
 *
 * Design rules:
 *  - Idempotent: every stage skips work whose result already verifies.
 *  - Resumable: archives are fetched to a cache and reused; a killed run
 *    continues instead of restarting.
 *  - Honest: a checksum the vendor does not publish is recorded from the fetch
 *    that first measured it and listed under `unverifiedChecksums`; it is never
 *    invented. A later cache hit is trusted without re-checking, because there is
 *    no pinned value to check it against — the record names the gap instead of
 *    pretending those bytes were verified.
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
 *     --skip-smoke        skip the post-wire REA/engine smoke test
 *     --allow-unlocked-npm-fallback
 *                         if `npm ci` cannot replay the audited lock, accept a
 *                         plain `npm install` with the same overrides. Off by
 *                         default: that route loses byte-reproducibility, so it
 *                         is an opt-in, not a silent downgrade.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
    skipSmoke: false,
    // Off by default on purpose: `npm ci` replaying the audited lock is the only
    // route that is byte-reproducible, and silently degrading it to a plain
    // `npm install` is the difference between "the closure the audit approved"
    // and "whatever the registry answered today". Opting in is a deliberate act.
    allowUnlockedNpm: false,
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
    else if (arg === "--skip-smoke") options.skipSmoke = true;
    else if (arg === "--allow-unlocked-npm-fallback") options.allowUnlockedNpm = true;
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

/* -------------------------------------------------------------- run locking */

/*
 * Declared up here, not next to `acquireRunLock`, because `log()` reaches for
 * them and `log()` runs before that point: a `const` is in its temporal dead zone
 * until its declaration is evaluated, and the first progress line — printed long
 * before the lock is claimed — threw `Cannot access 'runLock' before
 * initialization` out of the heartbeat. The lock functions themselves stay down
 * with the rest of the concurrency code; only the state they read lives here.
 */

/**
 * The ownership token for this run's lock.
 *
 * `bin/rea-shim.mjs` creates `setup.lock`, spawns this script detached, and hands
 * the token over in `REA_BUNDLE_LOCK_TOKEN`. A hand-run `node scripts/setup.mjs`
 * makes its own, so the field is always populated and a lock that carries it can
 * be recognised as this run's own.
 */
const RUN_TOKEN = (() => {
  const inherited = process.env.REA_BUNDLE_LOCK_TOKEN;
  return typeof inherited === "string" && inherited.trim() !== "" ? inherited.trim() : randomUUID();
})();

/** The run lock this process holds; `held` stays false until one is claimed. */
const runLock = { file: null, held: false, lastTouch: 0 };

/**
 * How often a long run refreshes the lock's `at`.
 *
 * `at` used to be written once, when the lock was claimed and never again, so
 * after six hours of a slow download it described a perfectly healthy run as
 * ancient — and the shim deleted the lock of a live process on exactly that
 * reading. Progress is the fact worth recording, so the refresh rides on the
 * run's own reporting (see `log`) instead of on a timer, which a synchronous
 * `spawnSync` download would starve anyway.
 */
const LOCK_HEARTBEAT_MS = 30000;

/**
 * Claim the run lock, or report who holds it.
 *
 * `setup.lock` used to be written only at the END of a run, so it recorded an
 * outcome and excluded nothing: the shim's detached provisioning and a hand-run
 * `node scripts/setup.mjs` could write the same `.part` and the same
 * `vendor/<component>.staging` at the same time, and whichever renamed last left
 * a component whose size and digest belonged to neither run. The lock is now
 * claimed before the first byte moves and created with O_EXCL (`wx`), so a second
 * process loses the race instead of interleaving with the first.
 *
 * A lock naming a dead pid, or one a previous run left as `failed`, is taken
 * over: a crash or a failed download must not require a manual `rm` before the
 * next attempt can start.
 */

function readJsonSafe(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function touchRunLock() {
  if (!runLock.held || runLock.file === null) return;
  const now = Date.now();
  if (now - runLock.lastTouch < LOCK_HEARTBEAT_MS) return;
  runLock.lastTouch = now;
  try {
    const current = readJsonSafe(runLock.file);
    if (current === null) return;
    // Only refresh a lock that is still ours. The shim transfers ownership by
    // rewriting the record, and a heartbeat must not resurrect one that was
    // replaced underneath us.
    if (current.token !== RUN_TOKEN && current.pid !== process.pid) return;
    writeFileSync(runLock.file, JSON.stringify({ ...current, at: now }) + "\n");
  } catch {
    /* the lock is advisory: a failed heartbeat must never break a download */
  }
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
  // A dry run writes nothing, logs/ included: see the mkdir note in main().
  if (options.dryRun) return;
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
  // Every line of progress is a heartbeat: the shim reads `at` to tell "still
  // working" from "stopped reporting", and this is the only place the run says
  // anything at all.
  touchRunLock();
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
    const done = (res, via) => {
      // Pause, do not subscribe. (issue #1, bug 1)
      //
      // `res.on("data", …)` starts flowing mode, and Node synchronously flushes any
      // chunk it has already buffered when that listener is attached. The consumer
      // (`writeBody`) only reaches `pipe()` a few microtasks later, so on a fast link
      // — where the headers and the first body bytes arrive in one segment — that
      // first chunk was emitted to the deadline listener and dropped. Reproduced with
      // a local server delivering 4 MiB: 4 128 896 bytes arrived, 65 408 short, and
      // every retry reproduced it, because `Range: bytes=<have>-` asks for exactly
      // the chunk that is about to be thrown away. `pause()` leaves the decision to
      // the consumer; `pipe()` resumes it, and the redirect/error paths already call
      // `resume()` explicitly. The idle deadline is refreshed from `writeBody` now.
      res.pause();
      resolve({ status: res.statusCode, headers: res.headers, stream: res, via });
    };

    if (!useProxy) {
      // The scheme picks the module. Every manifest URL is https, so this only
      // mattered once a test needed to drive this route against a local server —
      // but pinning https here meant an http URL could never use the direct route
      // at all, it just failed TLS with "wrong version number".
      const secure = target.protocol !== "http:";
      const req = (secure ? httpsRequest : httpRequest)(
        {
          host: target.hostname,
          port: target.port || (secure ? 443 : 80),
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
  // A `.part` that already holds the whole body breaks the resume even when the
  // manifest declares no size: the Range request asks for bytes past the end, a
  // correct server answers 416, and every retry repeats it — the file can only be
  // rescued by hand. A pinned checksum is evidence enough to finish the rename;
  // without one there is nothing to compare and the 416 path stays.
  if (have > 0 && !expected.size && expected.sha256 && expected.sha256 !== "unverified") {
    const digest = sha256File(temporary);
    if (digest === expected.sha256) {
      log(`       ${label}: partial file matches the pinned checksum; verified and kept`);
      rmSync(destination, { force: true });
      renameSync(temporary, destination);
      return { sha256: digest, size: have, tofu: false };
    }
    log(`       ${label}: partial file does not match the pinned checksum; starting over`);
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
      // to release-assets.githubusercontent.com correctly, which is what the Node
      // routes struggled with here (direct = reset/timeout, proxy = a 301 loop
      // rewriting back to github.com).
      //
      // The 860-byte shortfall that also argued for PowerShell was NOT the network.
      // `openGet()` attached a `data` listener before any consumer existed, so the
      // first buffered chunk was flushed to it and dropped on every attempt — and
      // nodejs.org advertises no accept-ranges, so a resume could never close that
      // gap, which made a bug in this file look like a property of the link. Fixed
      // under issue #1; PowerShell stays first on Windows for the proxy and redirect
      // reasons, not as a workaround.
      //
      // `REA_BUNDLE_DOWNLOAD_ROUTE=node|powershell` pins the order so the route a
      // platform does not default to can still be exercised — which is exactly how
      // this defect stayed invisible on Windows for so long.
      let via = null;
      let nodeFailure = null;
      const routeOverride = String(process.env.REA_BUNDLE_DOWNLOAD_ROUTE ?? "").trim().toLowerCase();
      const tryPowerShellFirst = routeOverride === "powershell"
        ? true
        : routeOverride === "node"
          ? false
          : IS_WINDOWS;
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
          // A short read is not automatically "this network". Until issue #1 the
          // first chunk was dropped by our own reader on every attempt, which looked
          // exactly like a flaky link and was even documented as one. What remains
          // after that fix is a genuine interruption, so resuming from `produced` is
          // still the cheaper move — and a fresh start is forced once the attempts
          // run out, so a marginal short read cannot accumulate.
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
      // The idle deadline used to be refreshed by a `data` listener attached in
      // `openGet()`, before any consumer existed — which is what started flowing
      // mode and cost the first chunk (issue #1). Refreshing it here keeps the
      // guarantee (a slow but alive transfer survives, a stalled one is cut)
      // without running ahead of the pipe: this listener is attached after
      // `pipe()`, so it only observes bytes the write stream already receives.
      if (source.socket) source.socket.setTimeout(options.idleTimeoutMs);
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
    // `filter="data"` is Python's own member filter (3.12+ by default, available
    // from 3.11.4): it drops absolute paths, `..` escapes, device files and
    // unsafe symlink targets instead of writing them. Every archive here is
    // SHA-256 pinned, so this is defense in depth rather than the only guard —
    // but a bare `extractall` is the shape a future unpinned entry would inherit.
    // The `except TypeError` keeps older Pythons working rather than replacing
    // one silent failure mode with "extraction unavailable".
    attempts.push({
      command: "python3",
      args: [
        "-c",
        "import sys,tarfile\n"
          + "t=tarfile.open(sys.argv[1])\n"
          + "try:\n"
          + "    t.extractall(sys.argv[2],filter='data')\n"
          + "except TypeError:\n"
          + "    t.extractall(sys.argv[2])\n",
        archive,
        destination,
      ],
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
  // Report the version the candidate actually printed, not the interpreter that
  // happens to be running setup. They differ whenever the adopted Node is not
  // the one executing this script — `REA_BUNDLE_NODE`, or a PATH whose first hit
  // is a different install — and recording the running interpreter silently
  // wrote a bundle.json that disagreed with the runtime the row launches.
  return { ok: true, version: firstLine.replace(/^v/, "").trim() || null };
}

/**
 * The version a reused JDK or Ghidra reports about itself.
 *
 * Both reuse branches used to return only `{path, how}`, so `bundle.json` fell
 * back to `merged.<name>?.version ?? null` and recorded `""` for a JDK or Ghidra
 * the machine had adopted — a record that names a runtime but cannot say which
 * one. `check-updates.ps1` compares against exactly that field, so the drift it
 * exists to report became invisible for precisely the components a reuse run
 * touches. Both files are the vendor's own declaration, not a guess:
 * `release` carries `JAVA_VERSION="…"`, `Ghidra/application.properties` carries
 * `application.version=…`.
 */
function readJdkVersion(root) {
  try {
    const release = readFileSync(path.join(root, "release"), "utf8");
    const match = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(release);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function readGhidraVersion(root) {
  try {
    const properties = readFileSync(path.join(root, "Ghidra", "application.properties"), "utf8");
    const match = /^application\.version=(.+)$/m.exec(properties);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * The major number of a version string, or null.
 *
 * Only the JDK's pin is matched this way, and only because "21+" is a real
 * contract rather than a preference: Ghidra 12.1 requires JDK 21 or newer, so a
 * JAVA_HOME holding 25.0.5 and a manifest pinning 21.0.12.1+1 agree with each
 * other. Every other component is matched exactly — `apktool 3.0.3` and
 * `apktool 3.0.2` are different files, not a range.
 */
function majorVersion(version) {
  const match = /^(\d+)/.exec(String(version ?? "").trim());
  return match === null ? null : Number(match[1]);
}

/** Every version the current manifest pins for one component. */
function pinnedVersions(component) {
  const versions = resolveEntries(component)
    .map((entry) => entry?.version)
    .filter((version) => typeof version === "string" && version.trim() !== "");
  return [...new Set(versions)];
}

/**
 * Does a `bundle.json` record still describe the component the manifest pins?
 *
 * The recorded-state branch trusted any record whose path existed: it ran the
 * probe but never compared `recorded.version` to the manifest. A pin bump then
 * left the old component in place and reported `already provisioned (old)`
 * forever — the run that was supposed to upgrade it chose to trust a record
 * about the version it was replacing.
 *
 * An explicit Ghidra gate override is the one sanctioned exception: while
 * `ghidra-gate-override.json` names a requested version, that version IS the
 * intended record, and treating it as drift would make the next plain setup
 * silently re-pin the vendor copy over an override the operator turned on.
 * @returns {{ ok: boolean, reason: string }} verdict, with a readable reason.
 */
function recordedMatchesPin(name, recorded, component) {
  const recordedVersion = typeof recorded.version === "string" ? recorded.version.trim() : "";
  if (component.kind === "npm") {
    // An npm component's version lives in the manifest's `sources.npm`, which
    // resolveEntries does not cover (npm is installed by name, not by URL).
    const pinned = component.sources?.npm?.version;
    if (typeof pinned !== "string" || pinned === "") return { ok: true, reason: "no npm pin" };
    return recordedVersion === pinned
      ? { ok: true, reason: `pinned ${pinned}` }
      : { ok: false, reason: `recorded ${recordedVersion || "no version"}, manifest pins ${pinned}` };
  }
  if (name === "ghidra") {
    try {
      const override = readJson(path.join(options.root, "ghidra-gate-override.json"));
      const requested = override?.requestedVersion;
      if (typeof requested === "string" && requested.trim() !== "" && recordedVersion === requested.trim()) {
        return { ok: true, reason: `recorded ${recordedVersion} matches the enabled gate override` };
      }
    } catch {
      /* no override record: fall through to the manifest pin */
    }
  }
  const pins = pinnedVersions(component);
  if (pins.length === 0) return { ok: true, reason: "the manifest pins no version" };
  if (pins.includes(recordedVersion)) return { ok: true, reason: `pinned ${recordedVersion}` };
  if (name === "jdk") {
    const pinnedMajor = majorVersion(pins[0]);
    const recordedMajor = majorVersion(recordedVersion);
    if (pinnedMajor !== null && recordedMajor !== null && recordedMajor >= pinnedMajor) {
      return { ok: true, reason: `major ${recordedMajor} satisfies the pin's major ${pinnedMajor}` };
    }
    return { ok: false, reason: `recorded ${recordedVersion || "no version"}, manifest pins ${pins.join("/")} (needs major >= 21)` };
  }
  return { ok: false, reason: `recorded ${recordedVersion || "no version"}, manifest pins ${pins.join("/")}` };
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
      if (checked.ok) return { ...candidate, version: checked.version ?? null };
      step("node", "plan", `not reusing ${candidate.how} node ${candidate.path}: ${checked.detail}`);
    }
    return null;
  }
  if (name === "jdk") {
    for (const [variable, how] of [["JAVA_HOME", "JAVA_HOME"]]) {
      const home = process.env[variable];
      if (home && existsSync(path.join(home, "bin", `javac${EXE}`))) {
        return { path: path.normalize(home), how, version: readJdkVersion(home) };
      }
    }
    return null;
  }
  if (name === "ghidra") {
    const install = process.env.GHIDRA_INSTALL_DIR;
    if (install && existsSync(path.join(install, "support", IS_WINDOWS ? "analyzeHeadless.bat" : "analyzeHeadless"))) {
      return { path: path.normalize(install), how: "GHIDRA_INSTALL_DIR", version: readGhidraVersion(install) };
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
 * JSON from disk, tolerating the UTF-8 BOM a Windows editor writes.
 *
 * `JSON.parse` rejects a leading BOM, and every caller in this file treats a
 * parse failure as "no record". A BOM-ed mirror.json therefore meant "this is
 * not a mirrored run", so setup went on to re-mirror the previous manifest;
 * a BOM-ed bundle.json meant "nothing is provisioned". `bin/rea-shim.mjs`
 * carries the same helper — the two must agree, or the same file means two
 * different things depending on which one read it (a hand-edited record with
 * PowerShell's BOM is exactly the case that produced this).
 */
function readJson(file) {
  const bytes = readFileSync(file);
  // The same three shapes `bin/rea-shim.mjs` decodes: UTF-8 (with or without the
  // BOM a Windows editor writes) and UTF-16 in either byte order. PowerShell 5.1
  // writes UTF-16 by default, so a record produced that way used to read as "no
  // record" on this side too. The two readers must agree, or one file means two
  // different things depending on which program opened it.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return JSON.parse(bytes.subarray(2).toString("utf16le"));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    body.swap16();
    return JSON.parse(body.toString("utf16le"));
  }
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

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
    const record = readJson(path.join(options.root, "mirror.json"));
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
  const parsed = readJson(file);
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
    const parsed = readJson(file);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    log(`       ${path.basename(file)} is not readable JSON (${String(error && error.message)}); ignoring it for this run`);
    return null;
  }
}

/**
 * Write JSON through a sibling temporary file, then rename it into place.
 *
 * `bundle.json` is what the shim reads on every row start, and `mirror.json` is
 * what a mirrored run uses to find the checkout it came from. Writing either one
 * in place means a kill (or a full disk) mid-write leaves a truncated file:
 * `readBundleJson` tolerates that by treating it as absent, which turns one
 * interrupted write into a full re-provisioning run, and the shim's own reader
 * reports the bundle as malformed and refuses to start. A rename on the same
 * volume is atomic, so a reader sees either the previous file or the new one.
 */
function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.part`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* the rename failure is the interesting one */
    }
    throw error;
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
      // Carry the adopted installation's own version. Dropping it here made
      // `bundle.json` record the manifest's pin instead of what was adopted — a
      // record that names a path but describes a different build, which is the
      // one thing `check-updates.ps1` exists to catch.
      return { ...reused, reused: true };
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
      // Probe the RECORDED path, never whatever path this run would have used.
      // `runProbe` resolves {jvm}/{ghidra}/{node} through `context.resolved`, and
      // the reuse branch above plants its candidate there for exactly this
      // reason. Without planting the recorded path here, a record pointing at a
      // broken Ghidra was verified against a different, working vendor copy: the
      // probe passed, the broken path stayed in `bundle.json`, and only REA
      // failed later — a runtime vouching for a path it was not asked about.
      const recordedContext = {
        ...context,
        resolved: { ...context.resolved, [name]: { path: recorded.path, root: recorded.root } },
      };
      const probe = runProbe(component.probe ?? {}, recordedContext);
      // The probe proves "the component at that path works". The pin check
      // proves it is the component THIS manifest asks for; without it a pin bump
      // left the previous build installed and reported `already provisioned`.
      const pin = recordedMatchesPin(name, recorded, component);
      // A matching pin and a passing probe still leave one thing unproven for
      // reaAgents: the closure's advisory floors. Those are properties of an
      // INSTALLATION rather than of a version, so the only way to answer is to
      // read it — and this is exactly the branch a 2.0.13 user upgrades through.
      const closure = name === "reaAgents" ? closureAdvisories(path.join(root, "vendor")) : { ok: true, reason: "" };
      if (probe.ok && pin.ok && closure.ok) {
        step(name, "skip", `already provisioned (${recorded.version ?? "recorded"}) — ${pin.reason}`);
        return recorded;
      }
      if (!probe.ok) step(name, "plan", `recorded but unverifiable at ${recorded.path}: ${probe.detail}`);
      else if (!pin.ok) step(name, "plan", `recorded but out of date at ${recorded.path}: ${pin.reason}`);
      else step(name, "plan", `recorded closure is below its advisory floors: ${closure.reason}`);
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

  /* Multi-file components: stage every file, swap in once, probe, roll back. */
  if (component.kind === "multi-file" || component.kind === "file") {
    const targetOf = (entry) => path.join(vendor, entry.moveTo ?? component.unpack?.moveTo ?? name);
    if (options.dryRun) {
      for (const entry of entries) {
        step(`${name}:${entry.id ?? "file"}`, "plan", `${entry.url} -> ${path.join(targetOf(entry), entry.saveAs ?? path.basename(new URL(entry.url).pathname))}`);
      }
      return { planned: true };
    }

    // 1) Fetch EVERY entry, or fail the component outright. A `continue` here is
    //    what made a half-install record itself as complete: the jar download
    //    failed, the wrapper succeeded, the stale 2.0.0 jar already in the target
    //    directory answered the component's own probe, and the record claimed
    //    3.0.3 — carrying the WRAPPER's digest — so every later run printed
    //    "already provisioned (3.0.3)" without downloading anything again.
    const downloads = [];
    for (const entry of entries) {
      const label = `${name}:${entry.id ?? "file"}`;
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
          step(label, "FAIL", `offline and ${archiveName} is not in the cache`);
          step(name, "FAIL", `${downloads.length} of ${entries.length} entries were available; nothing was installed`);
          return null;
        }
        try {
          fetched = await download(entry.url, archivePath, entry, `${name} ${entry.version ?? ""}`);
        } catch (error) {
          step(label, "FAIL", String(error.message));
          step(name, "FAIL", `${downloads.length} of ${entries.length} entries were available; nothing was installed`);
          return null;
        }
      }
      downloads.push({ entry, archivePath, sha256: fetched.sha256, tofu: fetched.tofu, label });
    }

    // 2) Stage into <target>.staging. The live directory is not touched yet, so
    //    nothing here can produce a new wrapper next to an old jar.
    const swaps = [];
    try {
      for (const targetDirectory of [...new Set(downloads.map((item) => targetOf(item.entry)))]) {
        const staging = targetDirectory + ".staging";
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        const staged = [];
        for (const item of downloads.filter((candidate) => targetOf(candidate.entry) === targetDirectory)) {
          const saveAs = item.entry.saveAs ?? path.basename(new URL(item.entry.url).pathname);
          const file = path.join(staging, saveAs);
          copyFileSync(item.archivePath, file);
          // A wrapper script has to be executable. copyFileSync lands the 0644
          // that the archive carries and nothing else in this file changes a
          // mode, while REA starts REA_APKTOOL_COMMAND through execFile/no shell
          // — so on POSIX a 0644 wrapper fails with EACCES. The component's own
          // probe misses it because it runs `java -jar` and never executes the
          // wrapper.
          if (item.entry.executable === true) {
            try {
              chmodSync(file, 0o755);
            } catch {
              /* a filesystem that cannot carry the bit must not fail the component */
            }
          }
          staged.push({ entry: item.entry, saveAs, sha256: item.sha256, tofu: item.tofu, label: item.label });
        }
        swaps.push({ targetDirectory, staging, backup: targetDirectory + ".backup", staged });
      }
    } catch (error) {
      for (const swap of swaps) rmSync(swap.staging, { recursive: true, force: true });
      step(name, "FAIL", `could not stage ${name}: ${String(error?.message ?? error)}`);
      return null;
    }

    // 3) Swap each staged directory in, keeping the old one as a backup so a
    //    failed rename or a failed probe can put it back. The previous code
    //    deleted the target and renamed second: a rename that failed left
    //    NEITHER the old install nor a new one.
    const rollback = () => {
      for (const swap of swaps) {
        try {
          rmSync(swap.targetDirectory, { recursive: true, force: true });
          if (existsSync(swap.backup)) renameSync(swap.backup, swap.targetDirectory);
        } catch {
          /* best effort: the failure being reported is the interesting one */
        }
      }
    };
    try {
      for (const swap of swaps) {
        rmSync(swap.backup, { recursive: true, force: true });
        if (existsSync(swap.targetDirectory)) renameSync(swap.targetDirectory, swap.backup);
        try {
          renameSync(swap.staging, swap.targetDirectory);
        } catch (error) {
          if (existsSync(swap.backup)) renameSync(swap.backup, swap.targetDirectory);
          throw error;
        }
      }
    } catch (error) {
      rollback();
      step(name, "FAIL", `could not replace ${swaps.map((swap) => swap.targetDirectory).join(", ")}: ${String(error?.message ?? error)}`);
      return null;
    }

    const probe = runProbe(component.probe ?? {}, context);
    if (!probe.ok) {
      rollback();
      step(name, "FAIL", `${swaps.map((swap) => swap.targetDirectory).join(", ")} — ${probe.detail}; the previous install was put back`);
      return null;
    }
    for (const swap of swaps) {
      try {
        rmSync(swap.backup, { recursive: true, force: true });
      } catch {
        /* a leftover .backup is inert; the component itself works */
      }
    }

    // 4) One record per entry, with the primary chosen by KIND rather than by the
    //    order the manifest happens to list entries in. `placed[0]` supplied the
    //    path AND the digest while `entries[0].version` supplied the version —
    //    two different files answering one question, which is exactly how the
    //    wrapper's digest came to be recorded as the jar's.
    const files = swaps.flatMap((swap) =>
      swap.staged.map((item) => ({
        id: item.entry.id ?? item.saveAs,
        file: path.join(swap.targetDirectory, item.saveAs),
        version: item.entry.version ?? null,
        sha256: item.sha256,
        tofu: item.tofu,
      })),
    );
    const primary = files.find((item) => /\.jar$/i.test(item.file)) ?? files[0];
    step(name, "ok", swaps.map((swap) => swap.targetDirectory).join(", "));
    return {
      path: path.dirname(primary.file),
      jarName: path.basename(primary.file),
      version: primary.version,
      sha256: primary.sha256,
      tofu: files.some((item) => item.tofu),
      files: files.map((item) => ({ id: item.id, version: item.version, sha256: item.sha256, tofu: item.tofu })),
    };
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
  // The old install is left in place until the new one is ready. Deleting it
  // here — before anything is extracted — made provisioning destructive on the
  // exact path it must not be: an extractor that is missing (a minimal Linux
  // without unzip/python3/tar) or a full disk destroyed a working install and
  // replaced it with nothing. The rename below is what replaces it, and it is
  // the only place that has to clear the destination.
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
  // Adoptium's macOS archives are .app-shaped (issue #1, bug 2): the JDK home is
  // `<root>/Contents/Home`, one level deeper than `stripRootComponents` can express,
  // and no other platform has that extra level. Making the strip count
  // platform-aware would then be wrong for any macOS archive that happens to be
  // flat, so look for the layout instead of counting for it. The `bin/java` test is
  // what stops this from guessing: only a directory that actually holds the runtime
  // is treated as the home. Without this the probe looked for `<jdk>/bin/java`,
  // missed, and took ghidra / apktool / jadx with it through `requires: ["jdk"]`.
  const appHome = path.join(effective, "Contents", "Home");
  if (existsSync(path.join(appHome, "bin", `java${EXE}`))) {
    log(`       ${name}: archive uses the macOS Contents/Home layout; installing that as the root`);
    effective = appHome;
  }
  // Same contract as the multi-file branch: the previous install is renamed
  // aside, not deleted, and it comes back if the swap or the probe fails.
  //
  // 2.0.14 documented this as done and only implemented it for multi-file — the
  // worst of both worlds, because the release note promises a failed probe is
  // survivable while the code deletes the working install anyway. Measured on the
  // audit's repro: probe fails, exit 1, the old known-good tree is gone, the new
  // broken tree is in place, and no `.backup` exists anywhere.
  const backup = target + ".backup";
  rmSync(backup, { recursive: true, force: true });
  let parked = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      parked = true;
    }
    renameSync(effective, target);
  } catch (error) {
    if (parked && !existsSync(target)) {
      try {
        renameSync(backup, target);
      } catch {
        /* the message below reports where the install did not land */
      }
    }
    rmSync(staging, { recursive: true, force: true });
    step(name, "FAIL", `could not move ${archiveName} into ${target}: ${String(error?.message ?? error)}`);
    return null;
  }
  rmSync(staging, { recursive: true, force: true });

  const probe = runProbe(component.probe ?? {}, context);
  if (!probe.ok) {
    let restored = false;
    if (parked) {
      try {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
        restored = true;
      } catch {
        restored = false;
      }
    }
    step(
      name,
      "FAIL",
      `${target} — ${probe.detail}` +
        (restored ? "; the previous install was put back" : parked ? `; the previous install is parked at ${backup}` : "; there was no previous install to restore"),
    );
    return null;
  }
  step(name, "ok", target);
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    /* a leftover .backup is inert; the component itself works */
  }
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
 * The advisory floors this closure has to clear, and a run-time reader for them.
 *
 * `scripts/check-dependency-advisories.mjs` enforces the same three floors at
 * build time, against the committed lock. This asks the same question about an
 * installation that already exists, which the version pin cannot answer: a bundle
 * recording `reaAgents 6.8.0` from before 2.0.14 passes every probe while its
 * vendored closure still carries zod 4.4.3. Without this, a fresh install got the
 * fixed closure and every upgrade kept the vulnerable one — the pin matched, the
 * probe matched, and the run said `already provisioned`.
 */
const CLOSURE_FLOORS = { zod: "4.6.6", minimatch: "11.0.1", glob: "14.0.2" };

/** Numeric-aware "a >= b" for dotted versions; a prerelease suffix is ignored. */
function atLeastVersion(actual, floor) {
  const parts = (value) => String(value ?? "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const found = parts(actual);
  const needed = parts(floor);
  for (let index = 0; index < Math.max(found.length, needed.length); index += 1) {
    const a = found[index] ?? 0;
    const b = needed[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Every advisory-affected package in an EXISTING closure that is below its floor.
 *
 * Both roots are scanned because npm dedupes into the top level when it can and
 * nests when it cannot: `rea-agents/node_modules/zod` is the shape that survives a
 * conflicting range, and a check that only looked at the top level would call that
 * closure healthy while REA imported the old copy.
 */
function closureAdvisories(installRoot) {
  const roots = [
    path.join(installRoot, "node_modules"),
    path.join(installRoot, "node_modules", "rea-agents", "node_modules"),
  ];
  const below = [];
  for (const [name, floor] of Object.entries(CLOSURE_FLOORS)) {
    for (const modules of roots) {
      const version = readJsonSafe(path.join(modules, ...name.split("/"), "package.json"))?.version ?? null;
      // Absent is not this check's business: a closure without the package is a
      // different question (the probe answers it), and reporting "absent" here
      // would fail a bundle for a package it never had.
      if (version === null || atLeastVersion(version, floor)) continue;
      below.push(`${name} ${version} < ${floor}${modules === roots[0] ? "" : " (nested)"}`);
    }
  }
  return below.length === 0
    ? { ok: true, reason: "every advisory-affected package is at or above its floor" }
    : { ok: false, reason: `${below.join(", ")} — GHSA-mrhx-c7xc-m3w5 / -g3hv-75wg-m249 / -3g3m-2fjr-6pw4` };
}

/**
 * The Node that will run the npm CLI, and that CLI itself.
 *
 * Resolved rather than assumed: on the machine this bundle exists for, `npm` is
 * only on PATH because a system Node happens to be installed, and the bootstrap's
 * whole job is the case where it is not — a bare `spawnSync("npm", …)` dies with
 * ENOENT on exactly that machine. Shared by the REA install and the Frida binding
 * check so both resolve the same pair instead of drifting apart.
 */
function resolveNpmRuntime(nodePath) {
  const nodeRuntime = typeof nodePath === "string" && nodePath !== "" && existsSync(nodePath) ? nodePath : process.execPath;
  const candidates = [
    // Portable Windows zip: <node>\node_modules\npm\bin\npm-cli.js
    path.join(path.dirname(nodeRuntime), "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX tarball: <node>/lib/node_modules/npm/bin/npm-cli.js
    path.join(path.dirname(nodeRuntime), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // An installed Node: <prefix>/lib/node_modules/..., also covered above.
    path.join(path.dirname(nodeRuntime), "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return { nodeRuntime, npmCli: candidates.find((candidate) => existsSync(candidate)) ?? null };
}

/**
 * Known-good Frida binding digests, keyed `<frida version>/<platform>-<arch>`.
 *
 * One entry, and that is the honest state of this. The binding arrives from
 * `prebuild-install` (or a local compile), so pinning it means recording a digest
 * somebody actually measured: `32c73230…` was measured on win32-x64 with frida
 * 17.23.2 on 2026-11-06. There is no equivalent measurement for the other
 * platforms, and inventing one would be worse than admitting the gap.
 *
 * A missing entry therefore does NOT fail provisioning — it downgrades the CLAIM.
 * The record then carries `verified: false` and the step text says the digest was
 * recorded rather than checked. "We hashed whatever we got" is not "the supply
 * chain was verified", and conflating the two is the mistake this table exists to
 * prevent. A MISMATCH, by contrast, is a refusal: a binding that is not the one
 * this build was measured with is disabled, not enabled with a note.
 */
const FRIDA_BINDING_SHA256 = {
  "17.23.2/win32-x64": "32c73230bdfd4b9a8f1f1871ef616001e486269919f18a111a195854352057dc",
};

/**
 * Make Frida's native binding present, and prove it loads.
 *
 * `rea-agents` depends on `frida` directly, and the only thing frida installs at
 * install time is `build/frida_binding.node` (its install script runs
 * `prebuild-install` for it). Provisioning uses `--ignore-scripts` on purpose —
 * no arbitrary package script runs during a download — so the binding was never
 * placed, and `import('frida')` failed with "Could not locate the bindings file".
 * Every Frida-backed tool in REA was dead while this run reported success, because
 * no probe ever imported the module.
 *
 * The fix is not "drop --ignore-scripts". It is to NAME the one package whose
 * install script is actually load-bearing, run its rebuild explicitly, and then
 * verify the result the way REA will use it: import the module and enumerate
 * devices. A binding that still does not load is reported, not swallowed, and does
 * not fail the whole provision — the other 200-odd tools do not need it.
 */
function ensureFridaBindings(nodeRuntime, npmCli, installRoot) {
  const fridaRoot = path.join(installRoot, "node_modules", "frida");
  if (!existsSync(path.join(fridaRoot, "package.json"))) {
    return { ok: false, skipped: true, detail: "frida is not in the resolved closure; nothing to bind" };
  }
  const bindingFile = path.join(fridaRoot, "build", "frida_binding.node");
  const fridaVersion = readJsonSafe(path.join(fridaRoot, "package.json"))?.version ?? null;
  const expectedBinding = fridaVersion === null
    ? null
    : FRIDA_BINDING_SHA256[`${fridaVersion}/${process.platform}-${process.arch}`] ?? null;
  const quarantineFile = `${bindingFile}.rejected`;

  /**
   * Inspect the binding WITHOUT importing it.
   *
   * Hashing this file is the first thing that happens to it, deliberately: an
   * `import()` of `frida` executes the native module inside this process, and a
   * verdict recorded afterwards cannot undo that. 2.0.15 had the order backwards —
   * `verify()` (import + enumerateDevices) ran first and the digest comparison ran
   * second — so a mismatched binding was loaded before being rejected, and the
   * release note's "disabling Frida rather than loading an unverified native
   * module" described the opposite of what the code did.
   */
  const inspect = () => {
    if (!existsSync(bindingFile)) return { present: false, digest: null, trusted: null };
    const digest = sha256File(bindingFile);
    // `trusted: null` means "no expectation for this platform", not "trusted".
    if (expectedBinding === null) return { present: true, digest, trusted: null };
    return { present: true, digest, trusted: digest === expectedBinding };
  };

  /**
   * Move a distrusted binding off the path anything loads, BEFORE any import.
   *
   * Writing `available: false` into `bundle.json` does not stop REA: the shim does
   * not consume that field, so the next tool that wants Frida imports whatever sits
   * at `build/frida_binding.node` regardless. Renaming is the only step that
   * actually removes it from that path; the `.rejected` suffix keeps the file for
   * inspection instead of destroying the evidence.
   */
  const quarantine = () => {
    try {
      rmSync(quarantineFile, { recursive: true, force: true });
      renameSync(bindingFile, quarantineFile);
      return quarantineFile;
    } catch {
      return null;
    }
  };

  const rejectBinding = (state, rebuilt) => {
    const moved = quarantine();
    return {
      ok: false,
      rebuilt,
      verified: true,
      digest: state.digest,
      quarantined: moved,
      detail:
        `the frida binding is ${state.digest}, not the recorded ${expectedBinding} for frida ${fridaVersion} ` +
        `on ${process.platform}-${process.arch}; ` +
        (moved === null
          ? `Frida is disabled, but the binding could NOT be moved off ${bindingFile} — remove that file before using Frida`
          : `moved it to ${moved} before any import, so nothing can load it`),
    };
  };

  const bindingOf = () => (existsSync(bindingFile) ? bindingFile : null);

  // Device enumeration, not just import(): a binding can load and still be
  // unusable, and `enumerateDevices` is the cheapest call that proves the native
  // side actually runs. String.fromCharCode(10) keeps this free of nested escapes.
  const probeScript =
    "const NL=String.fromCharCode(10);"
    + "import('frida')"
    + ".then(m=>{const f=m.default??m;return f.enumerateDevices()})"
    + ".then(d=>console.log('FRIDA_OK '+d.length))"
    + ".catch(e=>{console.error('FRIDA_BAD '+String(e.message).split(NL)[0]);process.exit(3)})";
  const verify = () => {
    const run = spawnSync(nodeRuntime, ["-e", probeScript], { cwd: installRoot, encoding: "utf8", timeout: 180000 });
    const text = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    const line = text.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `exit ${run.status}`;
    return { ok: run.status === 0 && text.includes("FRIDA_OK"), detail: line };
  };

  // 1) Hash FIRST. Only a binding that matches the recorded digest (or has no
  //    expectation on this platform) is ever imported.
  const initial = inspect();
  if (initial.present && initial.trusted === false) return rejectBinding(initial, false);

  let before = null;
  if (initial.present) {
    before = verify();
    if (before.ok) {
      return {
        ok: true,
        rebuilt: false,
        detail: before.detail,
        binding: bindingOf(),
        sha256: initial.digest,
        verified: initial.trusted === true,
      };
    }
    if (options.offline) {
      return { ok: false, detail: `offline, and the native binding does not load (${before.detail})` };
    }
    log(`       frida native binding does not load (${before.detail}); running its own install script via npm rebuild frida`);
  } else if (options.offline) {
    return { ok: false, detail: `offline, and frida has no native binding at ${bindingFile}` };
  } else {
    log(`       frida has no native binding at ${bindingFile}; running its own install script via npm rebuild frida`);
  }

  const rebuild = spawnSync(
    nodeRuntime,
    [npmCli, "rebuild", "frida", "--prefix", installRoot, "--loglevel", "error"],
    { cwd: installRoot, encoding: "utf8", timeout: 1800000 },
  );

  // 2) Hash the result BEFORE importing it too — a rebuild can produce a binding
  //    that is present, loadable, and not the one this build was measured with.
  const afterBuild = inspect();
  if (afterBuild.present && afterBuild.trusted === false) return rejectBinding(afterBuild, true);
  if (!afterBuild.present) {
    const tail = `${rebuild.stderr ?? ""}${rebuild.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    log(`       npm rebuild frida exited ${rebuild.status}${tail ? `: ${tail}` : ""}`);
    return { ok: false, rebuilt: true, detail: `npm rebuild frida did not produce ${bindingFile}`, binding: null, sha256: null, verified: false };
  }

  const after = verify();
  if (!after.ok) {
    const tail = `${rebuild.stderr ?? ""}${rebuild.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    log(`       npm rebuild frida exited ${rebuild.status}${tail ? `: ${tail}` : ""}`);
    return { ok: false, rebuilt: true, detail: after.detail, binding: bindingOf(), sha256: afterBuild.digest, verified: false };
  }
  return {
    ok: true,
    rebuilt: true,
    detail: after.detail,
    binding: bindingOf(),
    sha256: afterBuild.digest,
    verified: afterBuild.trusted === true,
  };
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

  // Why a reinstall is needed, carried to the messages below so they say which
  // of the two things is wrong instead of "not usable" for both.
  let reinstallReason = `there is no vendored REA at ${vendor}`;

  if (existsSync(path.join(vendor, "scripts", "rea.mjs"))) {
    const current = probe();
    // `--version` says which REA this is, not what its closure carries. A copy
    // installed before 2.0.14 answers 6.8.0 perfectly while shipping zod 4.4.3, so
    // the advisory floors are checked here too — this is the second early return a
    // 2.0.13 user takes.
    const closure = closureAdvisories(installRoot);
    if (current.ok && closure.ok) {
      step("reaAgents", "skip", `already vendored (${version}) — ${closure.reason}`);
      return { path: vendor, version };
    }
    if (!current.ok) {
      reinstallReason = `the vendored CLI does not answer correctly (${current.detail})`;
      log(`       vendored copy is unusable (${current.detail}); reinstalling`);
    } else {
      reinstallReason = `its closure is below the advisory floors (${closure.reason})`;
      log(`       vendored closure is below its advisory floors (${closure.reason}); reinstalling`);
    }
  }

  if (options.dryRun) {
    step("reaAgents", "plan", `npm ci from vendor-lock (${component.sources.npm.registry.replace("https://registry.npmjs.org/", "")}@${version}, zod/minimatch/glob overridden) --prefix ${installRoot}`);
    return { planned: true, version };
  }

  // `--offline is a promise, not a hint` — and this is the one step that cannot be
  // served from the cache: it is an npm install, not a download. It used to run
  // anyway, so a machine with every archive pre-cached still went to the registry
  // (or failed there) after the flag had promised it would not.
  if (options.offline) {
    step(
      "reaAgents",
      "FAIL",
      `--offline, and the REA at ${vendor} has to be reinstalled — ${reinstallReason}; that needs the registry (drop --offline, or pre-install it)`,
    );
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
   * Resolve npm, do not assume it. See resolveNpmRuntime for why a bare
   * `spawnSync("npm", ...)` is the wrong shape on the machine this exists for —
   * and note that this function and the Frida check in `main` share that one
   * resolution instead of each keeping its own copy.
   */
  const { nodeRuntime, npmCli } = resolveNpmRuntime(context.resolved.node?.path);

  if (!npmCli) {
    step("reaAgents", "FAIL", `no npm-cli.js next to ${nodeRuntime}; cannot resolve the dependency closure without npm`);
    return null;
  }
  log(`       ${path.relative(installRoot, npmCli) || npmCli} (vendored npm, not PATH)`);

  /*
   * The closure is resolved from an audited lock, not from whatever the registry
   * answers on the day of the install.
   *
   * `rea-agents@6.8.0` pins zod EXACTLY (`"zod": "4.4.3"`), and 4.4.3 is inside
   * GHSA-mrhx-c7xc-m3w5 (<4.6.6: memory exhaustion while validating oversized
   * constrained collections). Measured on this closure: a `.max(2)` schema handed
   * 25 elements produced 26 issue objects on 4.4.3 and 1 on 4.6.7 — and REA's own
   * `inspect_analysis_settings` input puts `.max()` on an array, so a malformed
   * tool call is the amplifier. An exact pin cannot be moved by a `dependencies`
   * range, so `overrides` is the only lever that does not rewrite the published
   * tarball. minimatch and glob come with it because each carries an advisory of
   * its own (GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4) and both reach the tree
   * through @electron/asar and frida.
   *
   * vendor-lock/ carries one package.json + package-lock.json pair for the whole
   * closure, so two installs a month apart resolve the same bytes — and `npm ci`
   * verifies the lock's sha512 per tarball, which a fresh `npm install` never
   * does. The pair lives under `scripts/` because that is the only directory the
   * plugin's `files` already ships; a top-level vendor-lock/ is honoured too, so
   * the pair can move without touching this function.
   */
  const CLOSURE_OVERRIDES = { zod: "4.6.7", minimatch: "11.0.5", glob: "14.0.4" };
  const ZOD_FLOOR = "4.6.6";
  const lockCandidates = [path.join(HERE, "vendor-lock"), path.join(PLUGIN_ROOT, "vendor-lock")];
  let lockSource = lockCandidates.find((dir) => existsSync(path.join(dir, "package-lock.json")) && existsSync(path.join(dir, "package.json"))) ?? null;
  if (lockSource) {
    // A lock that pins a different REA than the manifest asks for would install
    // the wrong server and then fail the probe with a version mismatch, which
    // names neither cause. Say which of the two is stale, and resolve the
    // manifest's pin instead of silently shipping the older REA.
    // readJsonSafe, not a raw parse of the file's bytes: the same BOM/UTF-16
    // handling every other record in this file gets. An editor that writes a BOM
    // would otherwise make this read as "the lock pins nothing", and the run would
    // silently ignore an audited lock instead of installing from it.
    const locked = readJsonSafe(path.join(lockSource, "package.json"))?.dependencies?.["rea-agents"] ?? null;
    if (locked !== version) {
      log(`       ignoring ${path.relative(PLUGIN_ROOT, lockSource) || lockSource}: it pins rea-agents@${locked ?? "nothing"} but the manifest pins ${version}; regenerate the lock`);
      lockSource = null;
    }
  }

  /** `<modules>/<name>/package.json`'s version, or null when it is not installed. */
  const closureVersion = (modules, name) => {
    const manifestPath = path.join(modules, ...name.split("/"), "package.json");
    if (!existsSync(manifestPath)) return null;
    // readJsonSafe for the same reason as the lock above: a dependency's
    // package.json is a record like any other, and a BOM must not read as
    // "no version" — that would make the closure check report a package as
    // absent while it sits on disk.
    return readJsonSafe(manifestPath)?.version ?? null;
  };
  /** Dotted numeric compare; a prerelease suffix is ignored, not ordered. */
  const atLeast = (actual, floor) => {
    const parts = (value) => String(value).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
    const found = parts(actual);
    const needed = parts(floor);
    for (let index = 0; index < Math.max(found.length, needed.length); index += 1) {
      const left = found[index] ?? 0;
      const right = needed[index] ?? 0;
      if (left !== right) return left > right;
    }
    return true;
  };

  /*
   * Install into a staging prefix and swap it in afterwards.
   *
   * `npm ci` deletes node_modules before it downloads anything, so replaying the
   * lock in place would trade a working vendor copy for a network error on
   * exactly the machine this script exists for. The rename below is the only step
   * that touches the live tree, and it runs after the closure has been installed
   * AND verified.
   */
  const staging = path.join(installRoot, ".npm-staging");
  const modules = path.join(staging, "node_modules");
  const live = path.join(installRoot, "node_modules");
  const retired = path.join(installRoot, ".node_modules.retired");
  const npmRun = (verb) =>
    spawnSync(nodeRuntime, [npmCli, verb, "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error"], {
      cwd: installRoot,
      encoding: "utf8",
      timeout: 1800000,
    });
  const npmTail = (result) => `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  const generatePackageJson = () =>
    writeFileSync(
      path.join(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "rea-bundle-vendor",
          version: "1.0.0",
          private: true,
          description: "Generated by dsh-plugin-rea setup: the vendored REA closure, pinned to patched zod/minimatch/glob.",
          dependencies: { "rea-agents": version },
          overrides: CLOSURE_OVERRIDES,
        },
        null,
        2,
      )}\n`,
    );

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let install = null;
  let verb = "ci";
  if (lockSource) {
    copyFileSync(path.join(lockSource, "package.json"), path.join(staging, "package.json"));
    copyFileSync(path.join(lockSource, "package-lock.json"), path.join(staging, "package-lock.json"));
    log(`       replaying the audited closure lock ${path.relative(PLUGIN_ROOT, lockSource) || lockSource}`);
    install = npmRun("ci");
    if (install.status !== 0) {
      if (!options.allowUnlockedNpm) {
        // Fail closed. A mirror serving different tarball bytes, or a package the
        // lock names and the registry dropped, breaks `ci` — but the honest answer
        // is to stop and say so, not to resolve the same names freshly and call it
        // the audited closure. That fallback silently traded byte-reproducibility
        // (the whole point of committing a lock) for a green run.
        rmSync(staging, { recursive: true, force: true });
        step(
          "reaAgents",
          "FAIL",
          `npm ci could not replay the audited lock (${npmTail(install)}); ` +
            `refusing to fall back to an unlocked install — re-run with --allow-unlocked-npm-fallback to accept a resolved-again closure`,
        );
        log("       mirrors that repackage tarballs (npmmirror and friends) fail this check by design; the lock names upstream bytes");
        return null;
      }
      log(`       npm ci could not replay the lock (${npmTail(install)}); resolving the same pins with overrides instead (--allow-unlocked-npm-fallback)`);
      // The lock itself has to go too: leaving it in the staging prefix makes the
      // `npm install` below honour the same unreadable entries and fail again, so
      // the fallback would never actually fall back. Verified against a
      // deliberately corrupted integrity hash.
      rmSync(modules, { recursive: true, force: true });
      rmSync(path.join(staging, "package-lock.json"), { force: true });
    }
  }
  if (!install || install.status !== 0) {
    generatePackageJson();
    verb = "install";
    install = npmRun("install");
  }
  if (install.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    step("reaAgents", "FAIL", `npm ${verb} failed (${install.status}): ${npmTail(install)}`);
    // Every other component can fall back to the proxy route this script resolves
    // itself; npm cannot, and this step is the one that fails most often on a
    // network where the registry needs a mirror.
    log("       npm reads HTTPS_PROXY/HTTP_PROXY and NPM_CONFIG_REGISTRY from the environment (this script's own proxy routing does not apply here)");
    return null;
  }
  if (!existsSync(path.join(modules, "rea-agents", "scripts", "rea.mjs"))) {
    rmSync(staging, { recursive: true, force: true });
    step("reaAgents", "FAIL", `npm ${verb} reported success but ${path.join(modules, "rea-agents")} has no scripts/rea.mjs`);
    return null;
  }

  /*
   * The audit's actual demand, verified against what landed instead of against
   * what the lock intended: a degraded install or a future re-pin must fail here,
   * not in someone's REA session weeks later.
   */
  log(`       closure ${["zod", "minimatch", "glob"].map((name) => `${name}@${closureVersion(modules, name) ?? "absent"}`).join(" ")}`);
  const zodVersion = closureVersion(modules, "zod");
  if (!zodVersion || !atLeast(zodVersion, ZOD_FLOOR)) {
    rmSync(staging, { recursive: true, force: true });
    step("reaAgents", "FAIL", `resolved zod@${zodVersion ?? "absent"} is below the ${ZOD_FLOOR} floor of GHSA-mrhx-c7xc-m3w5; refusing to vendor this closure`);
    return null;
  }

  rmSync(retired, { recursive: true, force: true });
  let parked = false;
  try {
    if (existsSync(live)) {
      renameSync(live, retired);
      parked = true;
    }
    renameSync(modules, live);
  } catch (error) {
    if (parked && !existsSync(live)) {
      try {
        renameSync(retired, live);
      } catch {
        /* the message below already says where the install did not land */
      }
    }
    rmSync(staging, { recursive: true, force: true });
    step("reaAgents", "FAIL", `could not move the new closure into ${live}: ${String(error?.message ?? error)}`);
    return null;
  }
  rmSync(staging, { recursive: true, force: true });

  /*
   * Verify the swap BEFORE deleting what it replaced.
   *
   * `retired` used to be removed on the line after the rename, so a closure that
   * renamed cleanly and then failed its own `--version` left the machine with no
   * usable REA at all: the old copy was gone and the new one did not work. A
   * rename that throws is the easy case — a rename that succeeds over a broken
   * install is the expensive one.
   *
   * Two checks, not one: `--version` proves the CLI starts, and `doctor` drives a
   * much wider slice of the zod schemas REA actually defines. `doctor` exits
   * non-zero whenever any optional capability is unconfigured (Hopper, IDA, Kuna,
   * registrations), so the verdict here is "it produced JSON", not "it is green".
   */
  const current = probe();
  const doctorRun = spawnSync(nodeRuntime, [path.join(vendor, "scripts", "rea.mjs"), "doctor", "--format", "json"], {
    encoding: "utf8",
    timeout: 300000,
    windowsHide: true,
  });
  const doctorOutput = `${doctorRun.stdout ?? ""}`.trim();
  const doctorAnswered = doctorOutput.startsWith("{") && (() => {
    try {
      JSON.parse(doctorOutput);
      return true;
    } catch {
      return false;
    }
  })();

  const restorePreviousClosure = () => {
    if (!parked) return false;
    try {
      rmSync(live, { recursive: true, force: true });
      renameSync(retired, live);
      return true;
    } catch {
      return false;
    }
  };

  if (!current.ok || !doctorAnswered) {
    const why = !current.ok ? current.detail : `doctor did not answer with JSON (exit ${doctorRun.status})`;
    const restored = restorePreviousClosure();
    step(
      "reaAgents",
      "FAIL",
      `${vendor} — ${why}` +
        (restored
          ? "; the previous closure was put back"
          : parked
            ? `; the previous closure is parked at ${retired} and could not be moved back`
            : "; there was no previous closure to restore"),
    );
    return null;
  }
  rmSync(retired, { recursive: true, force: true });
  step("reaAgents", "ok", `${vendor} — --version and doctor both answered`);

  // The package is in place; its native dependency is a separate claim. Checked
  // here as well as in `main` so a fresh install records the verdict immediately;
  // `main` covers the case this path never runs — a bundle that already records
  // 6.8.0, which is every upgrade.
  const frida = ensureFridaBindings(nodeRuntime, npmCli, installRoot);
  if (frida.ok) {
    step("fridaBindings", "ok", `${frida.detail}${frida.rebuilt ? " (rebuilt by setup)" : ""}${frida.binding ? ` — ${frida.binding}` : ""}`);
  } else {
    // Never "FAIL": the package itself provisioned, and one optional native
    // binding must not turn a working bundle into a failed run. `browser` reports
    // its own absence the same way.
    step("fridaBindings", "skip", frida.skipped ? frida.detail : `unavailable: ${frida.detail}`);
  }
  return {
    path: vendor,
    version,
    frida: frida.ok
      ? { available: true, binding: frida.binding, sha256: frida.sha256 ?? null, verified: frida.verified === true, devices: frida.detail }
      : { available: false, reason: frida.detail, verified: frida.verified === true },
  };
}

/* ---------------------------------------------------------------------- main */

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "") + "\n");
  process.exit(0);
}

// `--dry-run` writes nothing at all. The help text only promised "no
// downloads", but creating the root, the cache and logs/setup.log on a machine
// whose owner asked for a preview is a side effect nobody asked for — and the
// audit read that gap as a promise the code did not keep.
if (!options.dryRun) {
  mkdirSync(options.root, { recursive: true });
  mkdirSync(options.cache, { recursive: true });
}

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

/* ---------------------------------------------------------------- concurrency */

/*
 * `RUN_TOKEN`, `runLock`, `LOCK_HEARTBEAT_MS`, `readJsonSafe` and `touchRunLock`
 * are declared up with the output section, because `log()` reaches for the
 * heartbeat and `log()` runs long before the lock is claimed.
 */

/**
 * True while a pid still exists.
 *
 * `process.kill(pid, 0)` performs the existence check without delivering a
 * signal; EPERM means "it exists, but it is not ours", which still counts.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Claim the run lock, or report who holds it.
 *
 * `setup.lock` used to be written only at the END of a run, so it recorded an
 * outcome and excluded nothing: the shim's detached provisioning and a hand-run
 * `node scripts/setup.mjs` could write the same `.part` and the same
 * `vendor/<component>.staging` at the same time, and whichever renamed last left
 * a component whose size and digest belonged to neither run. The lock is now
 * claimed before the first byte moves and created with O_EXCL (`wx`), so a second
 * process loses the race instead of interleaving with the first.
 *
 * A lock naming a dead pid, or one a previous run left as `failed`, is taken
 * over: a crash or a failed download must not require a manual `rm` before the
 * next attempt can start.
 */
function acquireRunLock() {
  const lockFile = path.join(options.root, "setup.lock");
  const record = { state: "running", pid: process.pid, at: Date.now(), log: logFilePath(), token: RUN_TOKEN };
  try {
    mkdirSync(options.root, { recursive: true });
  } catch (error) {
    return { ok: false, holder: null, error };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, JSON.stringify(record) + "\n", { flag: "wx" });
      return { ok: true, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, holder: null, error };
    }
    // A lock written by a crashed run — or by a `writeFileSync` that a kill or a
    // full disk caught halfway — can be unparseable, and `readJson` throws on
    // that. The throw escaped `acquireRunLock`, so a hand-run
    // `node scripts/setup.mjs` died with a raw JSON SyntaxError even though the
    // comment below promises an unreadable lock is replaced. An unparseable lock
    // names no live holder, so it is stale by definition.
    let holder = null;
    try {
      holder = readJson(lockFile);
    } catch (error) {
      log(`       setup.lock is not readable JSON (${String(error?.message ?? error)}); replacing it`);
    }
    // OUR OWN lock, claimed on our behalf by `bin/rea-shim.mjs`: take it over.
    //
    // The shim creates the lock, spawns this script detached, and only THEN
    // rewrites the record with the child's pid. Without this branch a run that
    // reached this point inside that window read a live pid it did not own and
    // exited 75 — losing the exclusive create to the lock that was reserved for
    // it. The token is the fact; `pid` is only a hint.
    if (holder && typeof holder.token === "string" && holder.token === RUN_TOKEN) {
      try {
        writeFileSync(lockFile, JSON.stringify(record) + "\n");
        return { ok: true, lockFile, inherited: true };
      } catch (error) {
        return { ok: false, holder, error };
      }
    }
    if (holder && holder.state === "running" && holder.pid !== process.pid && pidAlive(holder.pid)) {
      return { ok: false, holder };
    }
    // Missing, unreadable, failed, or owned by a pid that is gone: replace it.
    try {
      rmSync(lockFile, { force: true });
    } catch {
      /* the next write reports why */
    }
  }
  let lastHolder = null;
  try {
    lastHolder = readJson(lockFile);
  } catch {
    /* an unparseable lock leaves nothing usable to name as the holder */
  }
  return { ok: false, holder: lastHolder };
}

if (!options.dryRun && !options.help) {
  const lock = acquireRunLock();
  if (!lock.ok) {
    const holder = lock.holder ?? {};
    const who = typeof holder.pid === "number" ? `pid ${holder.pid}` : "another run";
    const where = typeof holder.log === "string" ? holder.log : logFilePath();
    process.stderr.write(
      `setup: another provisioning run holds ${path.join(options.root, "setup.lock")} (${who}).\n` +
        `  its log: ${where}\n` +
        `  wait for it to finish, or delete that file if the process is gone.\n`,
    );
    if (lock.error) process.stderr.write(`  ${String(lock.error?.message ?? lock.error)}\n`);
    process.exit(75);
  }
  runLock.file = lock.lockFile;
  runLock.held = true;
  runLock.lastTouch = Date.now();
}

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

/*
 * Frida's native binding — checked whenever the provisioning path above did not.
 *
 * `rea-agents` depends on `frida` directly, and the only thing frida installs at
 * install time is `build/frida_binding.node`. Provisioning runs npm with
 * `--ignore-scripts` on purpose, so that binding is never placed by the install
 * itself; `ensureFridaBindings` repairs it. But that repair lives inside the
 * provisioning path, which a bundle already recording 6.8.0 never enters — that
 * is, every upgrade — so the binding could stay missing while every line of the
 * run said "already provisioned". This closes the gap: when this run produced no
 * frida verdict, take one now.
 *
 * Reported, never fatal, for the same reason `browser` is: the other 200-odd REA
 * tools do not need it, and failing a whole provision over one optional native
 * binding answers a worse question than naming the capability that is missing.
 */
/*
 * Frida's native binding — checked on EVERY run, never decided from the record.
 *
 * Gating this on `merged.reaAgents.frida === undefined` turned one transient
 * failure (a network blip inside `npm rebuild`, a file momentarily locked) into a
 * permanent verdict: every later setup read the stored `available: false` and moved
 * on without retrying, and a binding deleted after a successful record kept its
 * `available: true` forever. `ensureFridaBindings` already begins by importing the
 * module, so re-running it IS the cheap check — one import, no download when the
 * binding is there.
 */
if (
  !options.dryRun
  && merged.reaAgents
  && typeof merged.reaAgents.path === "string"
  && existsSync(merged.reaAgents.path)
) {
  const fridaRuntime = resolveNpmRuntime(merged.node?.path);
  if (!fridaRuntime.npmCli) {
    step("fridaBindings", "skip", `no npm-cli.js next to ${fridaRuntime.nodeRuntime}; the binding cannot be repaired from here`);
  } else {
    const frida = ensureFridaBindings(fridaRuntime.nodeRuntime, fridaRuntime.npmCli, path.join(options.root, "vendor"));
    merged.reaAgents = {
      ...merged.reaAgents,
      frida: frida.ok
        ? {
            available: true,
            binding: frida.binding,
            sha256: frida.sha256 ?? null,
            // `verified` is about the DIGEST, not about the module loading. A
            // platform with no pinned digest is usable but unproven, and the
            // record has to say which of those two it is.
            verified: frida.verified === true,
            devices: frida.detail,
          }
        : { available: false, reason: frida.detail, verified: frida.verified === true },
    };
    if (frida.ok) {
      const how = frida.verified === true ? "digest matches the recorded one" : "digest recorded, no pinned value for this platform";
      step("fridaBindings", "ok", `${frida.detail}${frida.rebuilt ? " (rebuilt by setup)" : ""} — ${how}`);
    } else {
      step("fridaBindings", "skip", frida.skipped ? frida.detail : `unavailable: ${frida.detail}`);
    }
  }
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
  writeJsonAtomic(path.join(options.root, "bundle.json"), bundleConfig);
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
  // The same two variables the mirrored shim exports. Without them REA falls
  // back to probing the machine, so `doctor` here reported whichever Ghidra and
  // JDK happened to be installed globally — on a machine with an older global
  // Ghidra this run's own engine was never the thing being checked, and a broken
  // vendor copy could still come back healthy.
  const reaEnv = {
    ...process.env,
    ...(paths.ghidra ? { GHIDRA_INSTALL_DIR: paths.ghidra } : {}),
    ...(paths.jdk ? { JAVA_HOME: paths.jdk } : {}),
  };
  if (existsSync(reaEntry)) {
    const doctor = spawnSync(nodePath, [reaEntry, "doctor", "--json"], { encoding: "utf8", timeout: 300000, env: reaEnv });
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

  // Ghidra smoke: prove the engine runs, not merely that its files exist.
  //
  // `doctor` validates paths, versions and which Java would be chosen; it never
  // imports a binary. The first real import pays a one-time cost (measured here:
  // ~35 s for a small PE, ~64 s for a 6 MB DLL) for the JVM start plus default
  // auto-analysis. On a broken bridge or a mismatched native addon the operator
  // met that only as an MCP tool timeout on the first real analysis — which reads
  // exactly like "the runtime upgrade broke REA". Importing one small file here
  // ends provisioning with a measured verdict instead of an inference, and makes
  // the failure visible while the operator is still in the setup output.
  //
  // The input is the JDK's own launcher: it exists on every platform this bundle
  // provisions, it is small enough to keep the step short, and it is never the
  // user's file.
  if (options.skipSmoke) {
    step("smoke", "skip", "disabled by --skip-smoke");
  } else if (!existsSync(reaEntry)) {
    step("smoke", "skip", "no vendored REA CLI to drive");
  } else if (!paths.ghidra || !paths.jdk) {
    step("smoke", "skip", "this run resolved no ghidra + jdk pair");
  } else {
    const smokeInput = path.join(paths.jdk, "bin", `java${EXE}`);
    if (!existsSync(smokeInput)) {
      step("smoke", "skip", `no small input at ${smokeInput}`);
    } else {
      const startedAt = Date.now();
      const smoke = spawnSync(nodePath, [reaEntry, "analyze", smokeInput, "--json"], {
        encoding: "utf8",
        timeout: 600000,
        env: reaEnv,
      });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      let evidence = null;
      try {
        const text = String(smoke.stdout ?? "");
        const open = text.indexOf("{");
        const close = text.lastIndexOf("}");
        evidence = open >= 0 && close > open ? JSON.parse(text.slice(open, close + 1)) : null;
      } catch {
        evidence = null;
      }
      if (smoke.status === 0 && evidence && typeof evidence.evidence_id === "string") {
        step("smoke", "ok", `imported ${path.basename(smokeInput)} in ${elapsed}s via ghidra`);
      } else {
        step(
          "smoke",
          "FAIL",
          `ghidra import failed (exit ${smoke.status}, ${elapsed}s): ${`${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.trim().slice(0, 300)}`,
        );
      }
    }
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
    record.pluginVersion = readJson(path.join(source, "package.json")).version ?? null;
  } catch {
    record.pluginVersion = null;
  }
  // The MCP child the harness starts has every DSH_* variable stripped, so the
  // mirrored shim cannot re-derive a CUSTOM home from its environment — it would
  // read `~/.dsh` and miss a duplicate `serverName: rea` living in the real one.
  // Record the home setup ran under; the shim prefers the environment, then this.
  try {
    record.dshHome = dshHome();
  } catch {
    record.dshHome = null;
  }
  try {
    mkdirSync(context.root, { recursive: true });
    writeJsonAtomic(path.join(context.root, "mirror.json"), record);
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
// Stop heartbeating before deciding the outcome: from here the record is the
// verdict, not a "still running" marker.
runLock.held = false;
// Only touch the lock if it is still ours.
//
// Between claiming it at start-up and reaching here, the record can have been
// replaced: a run that died after we read it, a human deleting it by hand, or (in
// the extreme) the shim reclaiming the root. Deleting or overwriting a record that
// belongs to somebody else is how a live run gets its brake removed — so compare
// the token before either write, and say nothing at all when it no longer matches.
let lockIsOurs = false;
try {
  const holderNow = readJsonSafe(lockFile);
  lockIsOurs = holderNow !== null && (holderNow.token === RUN_TOKEN || holderNow.pid === process.pid);
} catch {
  lockIsOurs = false;
}
if (!lockIsOurs) {
  log("       setup.lock no longer carries this run's token; leaving it alone");
} else if (failed.length === 0) {
  rmSync(lockFile, { force: true });
} else {
  try {
    writeFileSync(lockFile, JSON.stringify({ state: "failed", pid: process.pid, at: Date.now(), exit: 1, log: logFilePath(), token: RUN_TOKEN }) + "\n");
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
