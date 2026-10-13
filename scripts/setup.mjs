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
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

/* ------------------------------------------------------------------ options */

function parseArgs(argv) {
  const options = {
    root: process.env.REA_BUNDLE_ROOT ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), ".dsh"), "plugins", "rea-bundle"),
    cache: null,
    reuse: false,
    dryRun: false,
    json: false,
    only: null,
    offline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg === "--cache") options.cache = argv[++i];
    else if (arg === "--reuse") options.reuse = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--yes") continue;
    else if (arg === "--only") options.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.cache) options.cache = path.join(options.root, "cache");
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

function sha256File(file) {
  const hash = createHash("sha256");
  const buffer = readFileSync(file);
  hash.update(buffer);
  return hash.digest("hex");
}

/* ------------------------------------------------------------ download + unzip */

async function download(url, destination, expected, label) {
  const temporary = destination + ".part";
  if (existsSync(temporary)) rmSync(temporary, { force: true });
  log(`       downloading ${label}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const stream = createWriteStream(temporary);
  let seen = 0;
  let nextMark = 0;
  for await (const chunk of response.body) {
    stream.write(chunk);
    seen += chunk.length;
    if (total > 0 && seen >= nextMark) {
      const percent = ((seen / total) * 100).toFixed(1);
      if (!options.json) process.stdout.write(`\r       ${label}: ${percent}% (${(seen / 1048576).toFixed(1)} MiB)`);
      nextMark = seen + Math.max(total / 20, 1048576);
    }
  }
  await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
  if (!options.json) process.stdout.write("\r" + " ".repeat(72) + "\r");
  const size = statSync(temporary).size;
  if (expected.size && size !== expected.size) throw new Error(`size mismatch: got ${size}, expected ${expected.size}`);
  const digest = sha256File(temporary);
  if (expected.sha256 && expected.sha256 !== "unverified" && digest !== expected.sha256) {
    throw new Error(`sha256 mismatch: got ${digest}, expected ${expected.sha256}`);
  }
  rmSync(destination, { force: true });
  const { renameSync } = await import("node:fs");
  renameSync(temporary, destination);
  return { sha256: digest, size, tofu: !expected.sha256 || expected.sha256 === "unverified" };
}

/** Extract with the platform's own tools. Returns true on success. */
function extract(archive, destination, format) {
  mkdirSync(destination, { recursive: true });
  if (format === "zip") {
    if (IS_WINDOWS) {
      const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`],
        { stdio: options.json ? "ignore" : "inherit" });
      return result.status === 0;
    }
    const result = spawnSync("unzip", ["-q", "-o", archive, "-d", destination], { stdio: options.json ? "ignore" : "inherit" });
    return result.status === 0;
  }
  if (format === "tar.gz" || format === "tar.xz") {
    const result = spawnSync("tar", ["-xf", archive, "-C", destination], { stdio: options.json ? "ignore" : "inherit" });
    return result.status === 0;
  }
  throw new Error(`unsupported archive format: ${format}`);
}

/* --------------------------------------------------------------- host probing */

function hostKey() {
  return `${process.platform}-${process.arch}`;
}

/** Path of a resolved component, wherever it actually lives (vendor or reused). */
function componentPath(context, name) {
  const resolved = context.resolved?.[name];
  if (resolved && typeof resolved.path === "string") return resolved.path;
  return path.join(context.vendor, name);
}

/**
 * Substitute probe tokens. `{root}` is the bundle root; component tokens
 * ({node},{jdk},{ghidra},{jvm},{vendor}/{vendorDir}) resolve through the
 * components that have already been provisioned or adopted this run, so a
 * reused JDK is found at its real location instead of a vendor path that was
 * never created. Paths are joined with the platform separator by the caller.
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
    return resolved && typeof resolved.path === "string" ? resolved.path : null;
  };
  swap("{vendor}", vendor);
  swap("{vendorDir}", vendor);
  swap("{root}", context.root);
  swap("{node}", vendorPath("node"));
  swap("{jdk}", vendorPath("jdk"));
  swap("{ghidra}", vendorPath("ghidra"));
  const jdk = vendorPath("jdk");
  if (jdk) swap("{jvm}", path.join(jdk, "bin", `java${EXE}`));
  swap("{exe}", EXE);
  return text.replaceAll("/", path.sep);
}

function runProbe(probe, context) {
  if (probe.file) {
    const file = substituteProbe(probe.file, context);
    return { ok: existsSync(file), detail: file };
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

/** Adopt an existing installation instead of downloading a duplicate. */
function reuseExisting(name, root) {
  if (!options.reuse) return null;
  const fileExists = (file) => file && existsSync(file);
  if (name === "node") {
    const candidate = process.env.REA_BUNDLE_NODE ?? null;
    if (fileExists(candidate)) return { path: candidate, how: "REA_BUNDLE_NODE" };
    const found = spawnSync(IS_WINDOWS ? "where" : "which", ["node"], { encoding: "utf8" });
    const first = (found.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (fileExists(first)) return { path: first, how: "PATH" };
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

function loadManifest() {
  const file = path.join(PLUGIN_ROOT, "manifest", "bundle.manifest.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed;
}

const INSTALL_ORDER = ["node", "jdk", "ghidra", "apktool", "jadxHeadlessMcp", "androidPlatformTools", "reaAgents"];

/* -------------------------------------------------------------------- stages */

async function provisionComponent(name, component, context) {
  const root = context.root;
  const vendor = path.join(root, "vendor");

  // 1) already present and verified?
  if (existsSync(path.join(root, "bundle.json"))) {
    const current = JSON.parse(readFileSync(path.join(root, "bundle.json"), "utf8"));
    const recorded = current.components?.[name];
    if (recorded) {
      const probe = runProbe(component.probe ?? {}, context);
      if (probe.ok) {
        step(name, "skip", `already provisioned (${recorded.version ?? "recorded"})`);
        return recorded;
      }
      step(name, "plan", `recorded but unverifiable: ${probe.detail}`);
    }
  }

  // 2) adopt an existing install
  const reused = reuseExisting(name, root);
  if (reused) {
    step(name, "skip", `reusing existing ${name} from ${reused.how}: ${reused.path}`);
    return { path: reused.path, reused: true };
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
      const { copyFileSync } = await import("node:fs");
      copyFileSync(archivePath, target);
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
    const { copyFileSync } = await import("node:fs");
    copyFileSync(archivePath, target);
    const probe = runProbe(component.probe ?? {}, context);
    step(name, probe.ok ? "ok" : "FAIL", `${target}${probe.ok ? "" : " — " + probe.detail}`);
    return probe.ok ? { path: target, version: source.version, sha256: fetched.sha256 } : null;
  }

  const target = path.join(vendor, component.unpack?.moveTo ?? name);
  rmSync(target, { recursive: true, force: true });
  const staging = target + ".staging";
  rmSync(staging, { recursive: true, force: true });
  const unpacked = extract(archivePath, staging, source.format);
  if (!unpacked) {
    step(name, "FAIL", `extraction failed for ${archiveName}`);
    return null;
  }
  const strip = component.unpack?.stripRootComponents ?? 0;
  let effective = staging;
  if (strip > 0) {
    const { readdirSync, renameSync } = await import("node:fs");
    for (let level = 0; level < strip; level += 1) {
      const entries = readdirSync(effective).filter((entry) => !entry.startsWith("."));
      if (entries.length !== 1) break;
      effective = path.join(effective, entries[0]);
    }
    const entries = readdirSync(effective);
    if (entries.length === 1 && statSync(path.join(effective, entries[0])).isDirectory() && strip > 1) {
      effective = path.join(effective, entries[0]);
    }
  }
  const { renameSync } = await import("node:fs");
  rmSync(target, { recursive: true, force: true });
  renameSync(effective, target);
  rmSync(staging, { recursive: true, force: true });

  const probe = runProbe(component.probe ?? {}, context);
  step(name, probe.ok ? "ok" : "FAIL", `${target}${probe.ok ? "" : " — " + probe.detail}`);
  return probe.ok ? { path: target, version: source.version, sha256: fetched.sha256, tofu: fetched.tofu } : null;
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
  log(`       npm install rea-agents@${version} (dependency closure)`);
  const install = spawnSync("npm", installArgs, {
    cwd: installRoot,
    encoding: "utf8",
    shell: IS_WINDOWS,
    timeout: 1800000,
  });
  if (install.status !== 0) {
    step("reaAgents", "FAIL", `npm install failed (${install.status}): ${`${install.stderr ?? ""}${install.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
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
log(`  plugin   ${PLUGIN_ROOT}`);
log(`  root     ${options.root}`);
log(`  cache    ${options.cache}`);
log(`  host     ${hostKey()}  node ${process.versions.node}`);
log(`  mode     ${options.dryRun ? "dry-run " : ""}${options.reuse ? "reuse " : ""}${options.offline ? "offline" : "online"}`.trimEnd());
log("");

const manifest = loadManifest();
const context = {
  root: options.root,
  cache: options.cache,
  vendor: path.join(options.root, "vendor"),
  resolved: {},
};
const results = {};

for (const name of INSTALL_ORDER) {
  const component = manifest.components[name];
  if (!component) continue;
  if (options.only && !options.only.includes(name)) continue;
  const missingRequirement = (component.requires ?? []).find((requirement) => !context.resolved[requirement]);
  if (missingRequirement && !options.only) {
    step(name, "FAIL", `skipped: required component "${missingRequirement}" is unavailable`);
    results[name] = null;
    continue;
  }
  const resolvedValue = await provisionComponent(name, component, context);
  results[name] = resolvedValue;
  // Only a real path may satisfy another component's `requires`.
  if (resolvedValue && typeof resolvedValue.path === "string") {
    context.resolved[name] = resolvedValue;
  }
}

/* browser is adopted, never downloaded */
const browser = reuseExisting("browser", options.root);
if (browser) step("browser", "skip", `adopting ${browser.path}`);

/* --------------------------------------------------------------- wire + probe */

const nodePath = typeof results.node?.path === "string" && existsSync(results.node.path)
  ? results.node.path
  : process.execPath;

const paths = {
  node: nodePath,
  reaEntry: path.join(options.root, "vendor", "node_modules", "rea-agents", "scripts", "rea.mjs"),
  ghidra: results.ghidra?.path ?? null,
  jdk: results.jdk?.path ?? null,
  adb: results.androidPlatformTools?.path ? path.join(results.androidPlatformTools.path, `adb${EXE}`) : null,
  apktoolCommand: results.apktool?.path
    ? path.join(results.apktool.path, IS_WINDOWS ? "apktool.bat" : "apktool")
    : null,
  jadxJar: results.jadxHeadlessMcp?.path
    ? path.join(
        results.jadxHeadlessMcp.path,
        results.jadxHeadlessMcp.jarName ?? "jadx-headless-mcp-0.7.1-all.jar",
      )
    : null,
  browser: browser?.path ?? null,
  ilspycmd: process.env.REA_ILSPY_CMD_PATH ?? null,
};

if (!options.dryRun) {
  const bundleConfig = {
    schema: 1,
    provisionedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.versions.node },
    plugin: { name: "dsh-plugin-rea", root: PLUGIN_ROOT },
    paths,
    versions: {
      reaAgents: results.reaAgents?.version ?? null,
      ghidra: results.ghidra?.version ?? null,
      jdk: results.jdk?.version ?? null,
      apktool: results.apktool?.version ?? null,
      jadxHeadlessMcp: results.jadxHeadlessMcp?.version ?? null,
      node: results.node?.version ?? process.versions.node,
    },
    components: Object.fromEntries(
      Object.entries(results).map(([name, value]) => [name, value ?? { path: null, unavailable: true }]),
    ),
    unverifiedChecksums: Object.entries(results)
      .filter(([, value]) => value?.tofu)
      .map(([name]) => name),
  };
  writeFileSync(path.join(options.root, "bundle.json"), JSON.stringify(bundleConfig, null, 2) + "\n");
  step("wire", "ok", path.join(options.root, "bundle.json"));

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

  // The real end-to-end check: launch the exact command the MCP row will use,
  // with no REA on PATH, and confirm the shim relays the CLI's answer.
  if (existsSync(path.join(PLUGIN_ROOT, "bin", "rea-shim.mjs"))) {
    const shim = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "bin", "rea-shim.mjs"), "--version"], {
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, REA_BUNDLE_ROOT: options.root },
    });
    const output = `${shim.stdout ?? ""}${shim.stderr ?? ""}`.trim();
    const ok = shim.status === 0 && /\d+\.\d+\.\d+/.test(output);
    step("shim", ok ? "ok" : "FAIL", ok ? `resolved to REA ${output.split(/\r?\n/)[0]}` : output.slice(0, 240));
  }
} else {
  step("wire", "plan", `would write ${path.join(options.root, "bundle.json")}`);
}

/* -------------------------------------------------------------------- summary */

const failed = state.steps.filter((entry) => entry.status === "FAIL");
if (options.json) {
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, steps: state.steps, log: state.log }, null, 2) + "\n");
} else {
  log("");
  log(failed.length === 0 ? "setup complete." : `setup finished with ${failed.length} unmet step(s).`);
  for (const entry of failed) log(`  unmet: ${entry.name} — ${entry.detail}`);
  log("");
  if (failed.length === 0) {
    // Release the provisioning lock the shim set, so a later first run on a new
    // machine (or after a manual wipe) can start again. A failed run keeps the
    // lock, but the shim treats a lock older than six hours as stale.
    rmSync(path.join(options.root, "setup.lock"), { force: true });
    log("restart DSH (or reload the profile) so the MCP row reconnects.");
    log(`status: node ${path.join(PLUGIN_ROOT, "bin", "rea-shim.mjs")} --shim-status`);
  } else {
    log("some components are unmet; fix the cause and re-run this command.");
  }
  log(`log: ${logFilePath()}`);
}
process.exit(failed.length === 0 ? 0 : 1);
