#!/usr/bin/env node
/**
 * rea-shim 鈥?the process the DSH MCP row launches.
 *
 * Why this exists: the published `cordis.patch.yml` must carry no machine path,
 * yet REA needs absolute paths for every dependency. The shim is the seam: it
 * reads one machine-local JSON file, exports exactly the variables REA reads,
 * and execs the vendored REA CLI with the arguments the row was given.
 *
 * It downloads nothing, writes nothing, and never touches PATH.
 *
 * Exit codes:  0 child exited normally   * child's own status
 *              78 EX_CONFIG  bundle not provisioned (or unusable) 鈥?the row has
 *                            `failOnStartupError: false`, so the harness stays up
 *                            and the message is the operator's remediation.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EX_CONFIG = 78;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/** DSH home, by the same rule setup.mjs and the published patch use. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homedir(), ".dsh");
}

/**
 * Where setup writes the machine-local truth.
 *
 * Two copies of this file exist and they need different answers, so the copy has
 * to be identified before the root can be:
 *
 *  * The **mirrored** copy at `<bundle>/bin/rea-shim.mjs` is what the published
 *    row launches, and its own location is the bundle root. It must not consult
 *    DSH_HOME: the harness strips every `DSH_*` name from an MCP child's
 *    environment (case-insensitively, because Windows is), so a custom DSH_HOME
 *    would send it to `~/.dsh`, where it would report "not provisioned" for a
 *    bundle sitting right next to it 鈥?and start a second ~800 MB run there.
 *  * The **checkout** copy (`<plugin>/bin/rea-shim.mjs`) is what a human runs, e.g.
 *    `npm run bundle:status`, from a shell where DSH_HOME *is* visible. Its own
 *    directory is the plugin, not the bundle, so resolving to itself would report
 *    "not provisioned" on a fully provisioned machine 鈥?and a bare
 *    `node bin/rea-shim.mjs mcp` would provision ~800 MB into the checkout.
 *
 * Only the checkout ships `cordis.patch.yml`, so that file is the discriminator.
 * REA_BUNDLE_ROOT stays as an explicit override for tests and unusual layouts.
 */
function bundleRoot() {
  const override = process.env.REA_BUNDLE_ROOT;
  if (override && override.trim() !== "") return path.resolve(override);
  if (!existsSync(path.join(PLUGIN_ROOT, "cordis.patch.yml"))) return PLUGIN_ROOT;
  return path.join(dshHome(), "plugins", "rea-bundle");
}

/**
 * A directory can provision only when it holds both files a run reads: the script
 * and the manifest it loads at startup. A bundle provisioned before the manifest
 * was mirrored has the script but not the manifest, so recommending that copy
 * would send the operator straight into an ENOENT.
 */
function usableSetup(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return null;
  const base = path.resolve(dir);
  const script = path.join(base, "scripts", "setup.mjs");
  const manifest = path.join(base, "manifest", "bundle.manifest.json");
  return existsSync(script) && existsSync(manifest) ? script : null;
}

/**
 * Which setup.mjs to run.
 *
 * The mirrored copy is a snapshot: after a plugin upgrade it still holds the
 * previous manifest, so it would provision the previous versions forever. setup
 * writes <bundle>/mirror.json naming the real checkout; prefer that while it is
 * usable, and fall back to the local copy 鈥?which is also all a first run has.
 */
function provisioningScript(root) {
  try {
    const record = JSON.parse(readFileSync(path.join(root, "mirror.json"), "utf8"));
    const recorded = usableSetup(record && record.pluginRoot);
    if (recorded) return recorded;
  } catch {
    /* no record, or not readable: the local copy is the only option */
  }
  return usableSetup(PLUGIN_ROOT);
}

/**
 * Upstream REA 6.5.0 can add a second registration for the same MCP server:
 * `rea setup --client dsh` writes a row with id "rea-mcp" and serverName "rea"
 * into `<DSH_HOME>/cordis.patch.yml`, while this bundle ships id "mcp-rea" with
 * the same serverName. DSH does not dedupe those rows: it rejects the later entry
 * with a duplicate-server-name error, so which REA row survives depends on load
 * order. The shim cannot prevent that, but it can name the conflict instead of
 * leaving a missing row to be diagnosed from "the tools are gone".
 *
 * The parse is deliberately small: the two files it cares about are block
 * mappings with one id/serverName per row, and anything it cannot attribute is
 * ignored 鈥?a missed hint is acceptable, a false alarm is not. The mirrored shim
 * cannot see a custom DSH_HOME (the harness strips DSH_* from an MCP child), so
 * this falls back to `~/.dsh` like the rest of the bundle; the row has the same
 * limitation.
 */
function foreignReaRegistration() {
  const patch = path.join(dshHome(), "cordis.patch.yml");
  let text;
  try {
    text = readFileSync(patch, "utf8");
  } catch {
    return null;
  }
  const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2").trim();
  // A row starts at `- id:`; the block runs to the next row, so a serverName can
  // never be attributed to a row that does not contain it.
  for (const block of text.split(/\r?\n(?=\s*-\s+id:\s*)/)) {
    const id = /^\s*-\s+id:\s*(.+?)\s*$/m.exec(block);
    const server = /^\s+serverName:\s*(.+?)\s*$/m.exec(block);
    if (!id || !server || unquote(server[1]) !== "rea") continue;
    const rowId = unquote(id[1]);
    if (rowId !== "mcp-rea") return { patch, id: rowId };
  }
  return null;
}

/**
 * The provisioning lock is a small JSON record: { state, pid, at, exit? }.
 * `state: "running"` is written when a run is started (setup's own pid once it
 * exists), and the failing run rewrites it as `state: "failed"` 鈥?it is kept on
 * purpose so a broken setup cannot be re-downloaded in a loop. A legacy
 * plain-number lock is still honoured as "running".
 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

function readLock(lock) {
  try {
    const raw = readFileSync(lock, "utf8").trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    const at = Number(raw);
    return Number.isFinite(at) ? { state: "running", at } : null;
  } catch {
    return null;
  }
}

/** Is the process recorded in the lock still alive? null means "cannot tell". */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : null;
  }
}

/**
 * On first run there is nothing to launch. Provisioning is a long download, so
 * it is started detached: the harness may kill this row (or the whole session)
 * long before 800 MB arrive, and the downloader is resumable and idempotent, so
 * a killed attempt is simply continued on the next start.
 *
 * Set REA_BUNDLE_AUTO_PROVISION=0 to require an explicit `setup.mjs` run.
 * Returns { started, reason, logPath } 鈥?the caller words its message from
 * `reason`, because "provisioning started in the background" was also printed
 * for a lock left behind by a run that had already failed, and for one whose
 * process was long gone.
 */
function maybeAutoProvision(root) {
  if (process.env.REA_BUNDLE_AUTO_PROVISION === "0") return { started: false, reason: "disabled" };
  const setupScript = provisioningScript(root);
  if (!setupScript) return { started: false, reason: "no-setup" };
  const lock = path.join(root, "setup.lock");
  const logPath = path.join(root, "logs", "setup.log");
  if (existsSync(lock)) {
    // A crashed run must not wedge provisioning forever: honour the lock only
    // while it is fresh; setup removes it itself when it finishes cleanly.
    const record = readLock(lock);
    const age = record && Number.isFinite(record.at) ? Date.now() - record.at : Infinity;
    const fresh = Number.isFinite(age) && age < STALE_LOCK_MS;
    if (fresh && record?.state === "failed") {
      // The run gave up and left the lock behind so it would not be retried in a
      // loop. Claiming it is still provisioning was a six-hour lie: nothing runs,
      // and every restart repeated the sentence.
      return {
        started: false,
        reason: "last-run-failed",
        exit: record.exit,
        failedAt: record.at,
        ageMs: age,
        logPath,
      };
    }
    if (fresh) {
      const alive = pidAlive(record?.pid);
      if (alive !== false) return { started: false, reason: "in-flight", logPath, ageMs: age };
    }
    // Reached when the lock is older than the freshness window, or its holder is
    // gone and never wrote an outcome (harness restart, power loss, a kill): what
    // it records is not happening any more. This removal is the whole point of the
    // freshness rule 鈥?without it the exclusive create below failed with EEXIST
    // *forever*, auto-provisioning never ran again, and main() printed nothing at
    // all for that outcome. The lock's own "honour it only while it is fresh"
    // comment described behaviour the code did not have.
    try {
      rmSync(lock, { force: true });
    } catch {
      // A read-only bundle root (system-wide install, chmod 555) cannot drop the
      // stale lock either. Returning the same "cannot write here" outcome as the
      // exclusive create below keeps the row alive: an uncaught EACCES killed the
      // shim with a stack trace, which is louder than the old silence but just as
      // unable to start REA.
      return { started: false, reason: "unwritable", logPath };
    }
  }
  try {
    mkdirSync(path.join(root, "logs"), { recursive: true });
    // Exclusive create: check-then-write is not atomic, so two rows starting at
    // once could both decide to provision. EEXIST means another run owns it.
    writeFileSync(lock, JSON.stringify({ state: "running", pid: process.pid, at: Date.now() }), { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") return { started: false, reason: "in-flight", logPath };
    /* a read-only bundle root must never break the harness */
    return { started: false, reason: "unwritable" };
  }
  try {
    const child = spawn(process.execPath, [setupScript, "--root", root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // Hand the lock to the detached downloader, so a later start that finds this
    // row dead still sees the run that is actually doing the work as alive.
    if (Number.isInteger(child.pid)) {
      try {
        writeFileSync(lock, JSON.stringify({ state: "running", pid: child.pid, at: Date.now(), supervisor: process.pid }));
      } catch {
        /* the lock is advisory: the row keeps working without it */
      }
    }
    return { started: true, reason: "started", logPath };
  } catch {
    return { started: false, reason: "spawn-failed", logPath };
  }
}

function fail(message, detail) {
  const lines = [
    "",
    "  dsh-plugin-rea (bundle): REA is not provisioned on this machine.",
    "",
    "  " + message,
  ];
  if (detail) lines.push("", "  detail: " + detail);
  // Point at the real checkout when the record allows it: running the mirrored
  // copy is fine, but it can only ever provision the manifest it was mirrored
  // with 鈥?and a bundle mirrored before the manifest travelled with it has no
  // usable copy at all, so the honest answer is then "run the plugin's own script".
  const root = bundleRoot();
  const setupScript = provisioningScript(root);
  lines.push(
    "",
    "  Finish setup with:",
    setupScript
      // `--root` is not decoration: a shim started with REA_BUNDLE_ROOT (or with
      // DSH_HOME unset in a row's scrubbed environment) resolves a root that
      // setup's own default need not agree with, and a remediation command that
      // provisions into another root leaves this row failing exactly as before.
      ? "    node \"" + setupScript + "\" --root \"" + root + "\""
      : "    node \"<installed plugin directory>/scripts/setup.mjs\" --root \"" + root + "\"",
  );
  if (!setupScript) {
    lines.push("", "  (Run it from the installed plugin directory: the copy in this bundle has no manifest.)");
  }
  lines.push(
    "",
    "  Then restart DSH (or reload the profile) so the MCP row reconnects.",
    "",
    "  The harness keeps running: this row declares failOnStartupError: false.",
    "",
  );
  process.stderr.write(lines.join("\n"));
  return EX_CONFIG;
}

function readBundleConfig(root) {
  const file = path.join(root, "bundle.json");
  if (!existsSync(file)) return { ok: false, code: "missing", file };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, code: "malformed", file, detail: String(error && error.message) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "malformed", file, detail: "bundle.json is not an object" };
  }
  return { ok: true, file, config: parsed };
}

/** Resolve the vendored REA entry, or report precisely what is missing. */
function resolveRea(config, root) {
  const paths = config.paths ?? {};
  const node = paths.node;
  // The fallback has to match where setup actually installs the package:
  // `npm install --prefix <root>/vendor` resolves into vendor/node_modules, so a
  // fallback without that segment named a directory that never exists. It only
  // fires when an older bundle.json has no paths.reaEntry 鈥?which is exactly when
  // a wrong fallback turns a usable install into "the vendored REA CLI is gone".
  const reaEntry = paths.reaEntry
    ?? path.join(root, "vendor", "node_modules", "rea-agents", "scripts", "rea.mjs");

  if (typeof node !== "string" || node.trim() === "") {
    return { ok: false, reason: "bundle.json has no paths.node" };
  }
  if (!existsSync(node)) {
    return { ok: false, reason: `the recorded Node runtime is gone: ${node}` };
  }
  if (!existsSync(reaEntry)) {
    return { ok: false, reason: `the vendored REA CLI is gone: ${reaEntry}` };
  }
  return { ok: true, node, reaEntry };
}

/**
 * Export only what REA actually reads, and only when the bundle recorded it.
 * An absent variable is better than a wrong one: REA then reports its own
 * availability with its own remediation text.
 */
function childEnvironment(config) {
  const env = { ...process.env };
  const paths = config.paths ?? {};

  const set = (name, value) => {
    if (typeof value === "string" && value.trim() !== "") env[name] = value;
  };

  // Analysis engines.
  set("GHIDRA_INSTALL_DIR", paths.ghidra);
  set("JAVA_HOME", paths.jdk);
  // Optional providers/tools; wired only when the bundle provisioned them.
  set("REA_ADB_PATH", paths.adb);
  set("REA_APKTOOL_COMMAND", paths.apktoolCommand);
  set("REA_JADX_MCP_JAR", paths.jadxJar);
  set("REA_BROWSER_EXECUTABLE", paths.browser);
  set("REA_ILSPY_CMD_PATH", paths.ilspycmd);

  // Keep the vendored Node first for any grandchild the bridge may spawn.
  if (typeof paths.node === "string" && paths.node.trim() !== "") {
    const nodeDir = path.dirname(paths.node);
    const current = env.PATH ?? "";
    const parts = current.split(path.delimiter).filter((part) => part !== "");
    if (!parts.some((part) => path.resolve(part) === path.resolve(nodeDir))) {
      env.PATH = [nodeDir, ...parts].join(path.delimiter);
    }
  }
  return env;
}

/**
 * Launch modes. 2.x exists to supply a runtime the machine does not have; when
 * the machine already has one, the honest thing to do is run it.
 *
 * The 1.x line was exactly that: `rea mcp` off PATH, user-managed Node and
 * Ghidra. So "use the system install" is not a new code path invented here 鈥?it
 * is the 1.x contract, reachable from the 2.x row. `auto` (the default) prefers
 * the system install and falls back to the provisioned bundle; `bundle` pins the
 * old behaviour; `system` insists (and fails loudly instead of provisioning
 * 800 MB behind an operator who asked for their own REA).
 */
const LAUNCH_MODES = ["auto", "system", "bundle"];

/**
 * How long a candidate may take to answer `--version`.
 *
 * Measured on a real npm-global install: `rea --version` through its `.cmd`
 * shim takes ~2.4 s cold (cmd.exe -> node -> the CLI's own module graph), and
 * 2.8-3.0 s with four probes in flight. A 3 s budget was therefore a coin flip:
 * half the runs rejected a perfectly good REA and silently fell back to the
 * bundle. 8 s leaves room for a slow disk and a loaded machine while still
 * bounding the one-off cost at startup.
 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * What the environment says about the launch mode.
 *
 * An unknown value is reported and treated as `auto`: the row is launched by
 * the harness with nobody watching stderr, so refusing to start over a typo
 * would read as "the plugin is broken". `auto` is the mode that still works.
 */
function launchPreference(env = process.env) {
  const raw = (env.REA_BUNDLE_LAUNCH ?? "").trim().toLowerCase();
  if (raw === "") return { value: "auto", invalid: null };
  return LAUNCH_MODES.includes(raw)
    ? { value: raw, invalid: null }
    : { value: "auto", invalid: raw };
}

/** True when `child` is `parent` or lives under it (case-insensitive on Windows). */
function isInside(child, parent) {
  const normalise = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const target = normalise(path.resolve(child));
  const base = normalise(path.resolve(parent));
  if (target === base) return true;
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Executable names a REA install provides on this platform.
 *
 * npm's global install writes a shell script plus `.cmd`/`.ps1` shims on
 * Windows, and only the `.cmd` one is spawnable without a shell. `rea.exe` is
 * accepted for a native/standalone install.
 */
function systemReaNames(platform = process.platform) {
  return platform === "win32" ? ["rea.cmd", "rea.exe", "rea.bat"] : ["rea"];
}

/**
 * Every path worth probing, most explicit first.
 *
 * `REA_BUNDLE_SYSTEM_REA` names one binary outright 鈥?that is both the test
 * seam and a real operator need (an install that is not on the harness's PATH,
 * which on Desktop is not the user's shell PATH).
 */
function systemReaCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  const explicit = (env.REA_BUNDLE_SYSTEM_REA ?? "").trim();
  if (explicit !== "") candidates.push(path.resolve(explicit));
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const raw of searchPath.split(path.delimiter)) {
    // A quoted PATH entry (`PATH="C:\Program Files\v66";…`) is legal in Windows
    // environments and `path.join` would treat the quotes as part of the name, so
    // the install would be invisible. A relative entry is skipped rather than
    // resolved: its meaning depends on the cwd THIS process happens to have, and
    // a candidate found that way would be launched by a path that means something
    // else to whoever reads the status report.
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (dir === "" || !path.isAbsolute(dir)) continue;
    for (const name of systemReaNames(platform)) candidates.push(path.join(dir, name));
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Kill a process and its children.
 *
 * `spawnSync`'s timeout kills only the process it started — for a `.cmd` shim
 * that is cmd.exe, and the `node` running inside it keeps the inherited stdio
 * handles open and keeps working. Taskkill's `/T` is the one portable-enough way
 * to get the tree on Windows; POSIX uses the process itself (the candidate is a
 * shebang script there, so there is no intermediate shell).
 */
function killTree(pid, platform = process.platform) {
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    if (platform === "win32") {
      const taskkill = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe");
      spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  } catch {
    /* best effort: a failed cleanup must not change the verdict */
  }
}

/** True when the path is a regular file (a directory named `rea.cmd` is not). */
function isFileSync(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A command line that survives `cmd /c` on Windows: quoted, quotes doubled. */
function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * The shell used to run a `.cmd`/`.bat` candidate.
 *
 * Absolute on purpose: `spawn(comspec())` is resolved against the CHILD's PATH,
 * and an MCP row inherits a scrubbed environment. A machine with a working REA
 * but a PATH that does not include System32 would then be judged "no REA",
 * which is precisely the wrong answer for the feature that exists to find it.
 */
function comspec() {
  const fromEnv = process.env.ComSpec ?? process.env.COMSPEC;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "cmd.exe");
}

/**
 * Ask a candidate whether it is a working REA.
 *
 * A file existing on PATH is not the same as a working install: npx leftovers,
 * half-removed globals and a shim whose Node is gone all sit on PATH and all
 * fail at once. One bounded `--version` separates them, and a slow or hanging
 * answer counts as "not usable" 鈥?the fallback (the bundle) still works, while
 * delegating to a broken binary would take the tools down with it.
 */
function probeRea(file, { platform = process.platform, timeout = PROBE_TIMEOUT_MS } = {}) {
  // `existsSync` says nothing about the shape: a DIRECTORY named `rea.cmd` exists,
  // fails to spawn, and would be reported as a broken install instead of as a
  // name collision. Only a regular file is a candidate.
  try {
    if (!statSync(file).isFile()) return { ok: false, reason: "not a file" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  const command = [file, "--version"];
  // `cmd /d /s /c "<line>"`: Windows only. Two details are load-bearing.
  // `/s` strips the first and last quote, so the whole line is quoted; and the
  // arguments are passed VERBATIM, because Node otherwise backslash-escapes the
  // quotes it sees and cmd.exe does not understand `\"` — every candidate then
  // answers "exit 1", which reads as "no REA on this machine".
  const result = platform === "win32" && /\.(cmd|bat)$/i.test(file)
    ? spawnSync(comspec(), ["/d", "/s", "/c", `"${[cmdQuote(file), "--version"].join(" ")}"`], {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawnSync(command[0], command.slice(1), {
        encoding: "utf8",
        timeout,
        windowsHide: true,
      });
  if (result.error) {
    // A timed-out probe leaves its grandchild running: cmd.exe is killed, the
    // REA inside it is not, and it keeps the inherited pipes open. Clean the tree
    // before answering, or a hung candidate leaves a process behind per start.
    if (result.error.code === "ETIMEDOUT") killTree(result.pid, platform);
    return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  }
  if (result.status !== 0) return { ok: false, reason: `exit ${String(result.status)}` };
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const version = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)?.[1] ?? null;
  // A REA install prints its version. Anything else (a shim that swallowed the
  // flag, an unrelated program that shares the name) is not a usable CLI.
  if (version === null) return { ok: false, reason: "no version in --version output" };
  return { ok: true, version };
}

/**
 * The system REA this machine already has, or why it was rejected.
 *
 * Candidates inside this bundle or this checkout are skipped: a REA that the
 * provisioner installed is the `bundle` mode, and delegating to it would be a
 * loop through a path the bundle already covers.
 */
function detectSystemRea({ env = process.env, platform = process.platform, root, pluginRoot = PLUGIN_ROOT } = {}) {
  const rejected = [];
  let profiled = 0;
  const explicit = (env.REA_BUNDLE_SYSTEM_REA ?? "").trim();
  // Probing costs a process start per candidate, and a row has to answer before
  // its tools exist. The first existing entry is what the shell would run, so a
  // couple of fallbacks is plenty; a machine whose first three `rea`s are all
  // broken is a repair job, not something this decision should keep paying for.
  const MAX_PROBES = 3;
  for (const candidate of systemReaCandidates({ env, platform })) {
    if (isInside(candidate, root) || isInside(candidate, pluginRoot)) {
      // A REA the provisioner installed is `bundle` mode; delegating to it would
      // be a loop back into the thing this decision is choosing between.
      if (rejected.length < 8) rejected.push({ file: candidate, reason: "inside the bundle" });
      continue;
    }
    // The candidate list is PATH x every executable name: one missing name per
    // directory is normal and is not a finding. Only a regular file that EXISTS
    // and then fails the probe is worth reporting.
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    if (profiled >= MAX_PROBES) {
      if (rejected.length < 8) rejected.push({ file: candidate, reason: "not probed (budget)" });
      continue;
    }
    profiled += 1;
    const probe = probeRea(candidate, { platform });
    if (probe.ok) return { found: true, file: candidate, version: probe.version };
    if (rejected.length < 8) rejected.push({ file: candidate, reason: probe.reason });
  }
  // Say what actually happened, not what a flag says: an explicit path that was
  // skipped because it lives inside the bundle is a different answer from one
  // that does not exist.
  const explicitPath = explicit === "" ? null : path.resolve(explicit);
  const explicitRejection = explicitPath === null
    ? null
    : (rejected.find(entry => entry.file === explicitPath) ?? null);
  let reason;
  if (explicitPath !== null && explicitRejection !== null) {
    reason = `REA_BUNDLE_SYSTEM_REA was rejected (${explicitRejection.reason}): ${explicitPath}`;
  } else if (explicitPath !== null && !isFileSync(explicitPath)) {
    reason = `REA_BUNDLE_SYSTEM_REA does not exist: ${explicitPath}`;
  } else {
    reason = profiled === 0 ? "no rea on PATH" : "no usable rea on PATH";
  }
  return { found: false, reason, rejected };
}

/**
 * Numeric dotted comparison (6.4.0 vs 6.5.0). null when either side is not a
 * plain x.y.z — a prerelease or a vendor tag is not something this decision
 * should pretend to order.
 */
function compareDotted(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Which REA this invocation should run.
 *
 * `auto` prefers the system install, but not blindly: a global REA older than
 * the one this bundle provisioned would silently take the tool count back
 * (6.4.0 ships 170 tools, 6.5.0 ships 207), so the newer of the two wins and
 * the older is only used when asked for by name. `bundle` and `system` are
 * honoured literally 鈥?`system` fails loudly rather than provisioning 800 MB
 * behind an operator who asked for their own REA.
 */
function resolveLaunch({ root, bundleVersion = null, bundleProvisioned = false, env = process.env, platform = process.platform } = {}) {
  const preference = launchPreference(env);
  if (preference.value === "bundle") {
    return { preference: preference.value, invalid: preference.invalid, mode: "bundle", reason: "pinned by REA_BUNDLE_LAUNCH=bundle" };
  }
  // A delegated child that ends up back in this shim (a wrapper script named
  // `rea` that calls us, a PATH that resolves to a launcher) would recurse
  // forever: the probe cannot break it, because the grandchild starts a fresh
  // one. One flag, written into the child's environment, ends the loop — the
  // nested run takes the bundle path, which either works or fails loudly.
  if ((env.REA_BUNDLE_DELEGATED ?? "") === "1") {
    return {
      preference: preference.value,
      invalid: preference.invalid,
      mode: "bundle",
      reason: "REA_BUNDLE_DELEGATED=1: already running under a delegated system REA, refusing to delegate again",
    };
  }
  const system = detectSystemRea({ env, platform, root });
  if (system.found) {
    const order = bundleVersion === null ? null : compareDotted(system.version, bundleVersion);
    const pinned = preference.value === "system";
    // No provisioned build at all: there is nothing to compare against, and the
    // machine's own REA is exactly what this mode exists to use.
    if (!bundleProvisioned || pinned || (order !== null && order >= 0)) {
      return {
        preference: preference.value,
        invalid: preference.invalid,
        mode: "system",
        reason: pinned
          ? `pinned by REA_BUNDLE_LAUNCH=system (system ${system.version}, bundle ${bundleVersion ?? "none"})`
          : !bundleProvisioned
            ? `a working REA is on PATH (${system.version}) and this machine has no provisioned bundle`
            : `the REA on PATH (${system.version}) is at least as new as the provisioned one (${bundleVersion})`,
        system,
      };
    }
    return {
      preference: preference.value,
      invalid: preference.invalid,
      mode: "bundle",
      reason: order === null
        ? `the REA on PATH (${system.version}) cannot be compared with the provisioned one (${bundleVersion}); keeping the bundle — set REA_BUNDLE_LAUNCH=system to use the system install`
        : `the REA on PATH (${system.version}) is older than the provisioned one (${bundleVersion}); set REA_BUNDLE_LAUNCH=system to use it anyway`,
      system,
    };
  }
  if (preference.value === "system") {
    return {
      preference: preference.value,
      invalid: preference.invalid,
      mode: "system",
      reason: `REA_BUNDLE_LAUNCH=system, but no usable REA was found (${system.reason})`,
      system,
      unusable: true,
    };
  }
  return {
    preference: preference.value,
    invalid: preference.invalid,
    mode: "bundle",
    reason: `no usable system REA (${system.reason})`,
    system,
  };
}

/** Launch the system REA exactly the way the 1.x row did. */
function launchSystemRea(system, argv) {
  const args = argv.length > 0 ? argv : ["mcp"];
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(system.file);
  // `REA_BUNDLE_DELEGATED` marks the child as "already the system REA". Without
  // it a wrapper on PATH that calls this shim would delegate to itself forever.
  const env = { ...process.env, REA_BUNDLE_DELEGATED: "1" };
  // Only the PATH is quoted. Quoting the arguments too would hand them to a
  // `.cmd`'s `%*` WITH their quotes (`"mcp"` instead of `mcp`) — measured — which
  // is a different command line than the 1.x row produced. The row passes `mcp`
  // and nothing else, so plain tokens are the contract here; an argument that
  // needs shell quoting is not something this path supports (cmd would also
  // expand `%NAME%` inside it).
  const child = useShell
    ? spawn(comspec(), ["/d", "/s", "/c", `"${[cmdQuote(system.file), ...args].join(" ")}"`], {
        env,
        stdio: "inherit",
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(system.file, args, { env, stdio: "inherit", windowsHide: true });
  // Signal handling, per platform, because the two are not the same problem.
  //
  // POSIX: stdio is inherited and the child is in this process's group, so a
  // terminal's Ctrl+C already reaches it. Forwarding again would deliver the
  // signal twice.
  //
  // Windows: there is no process group to deliver to, and `child.kill("SIGINT")`
  // is TerminateProcess on the cmd.exe WRAPPER — the REA inside it survives and
  // keeps the inherited pipes open, which looks exactly like "the tools still
  // work after I stopped the harness". `taskkill /T` is what actually ends the
  // tree, so that is what a signal asks for here.
  if (process.platform === "win32") {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        killTree(child.pid, "win32");
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }
  child.on("error", (error) => {
    process.stderr.write(`rea-shim: could not start ${system.file}\n  ${String(error && error.message)}\n`);
    process.exit(EX_CONFIG);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
      process.exit(128 + (signals[signal] ?? 0));
    }
    process.exit(code ?? 0);
  });
  return null;
}

/**
 * Usage text, also what a bare invocation prints.
 *
 * `package.json` exposes this file as the `rea-bundle-status` bin, and npm's bin
 * shim can only forward the arguments a user typed 鈥?it cannot append a flag. So a
 * bare `rea-bundle-status`, which is exactly what that name invites, used to fall
 * through to the launch path: it started REA, and on an unprovisioned machine it
 * began an ~800 MB download. Reporting usage instead makes the command's behaviour
 * match its name, and the row is unaffected because it always passes `mcp`.
 */
function usage() {
  return [
    "rea-shim: launches a REA MCP server for a DSH MCP row.",
    "",
    "  node bin/rea-shim.mjs [rea arguments...]   (normal use: 'mcp')",
    "  node bin/rea-shim.mjs --shim-status        launch decision and provisioning status, no launch",
    "  node bin/rea-shim.mjs --shim-print-env     the environment it would export",
    "",
    `  bundle root: ${bundleRoot()}`,
    `  plugin root: ${PLUGIN_ROOT}`,
    "",
    "  REA_BUNDLE_LAUNCH=auto|system|bundle  (default auto: use the REA already",
    "  on PATH when it answers --version, otherwise the provisioned bundle)",
    "  REA_BUNDLE_SYSTEM_REA=<path>          probe this binary instead of PATH",
    "",
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--shim-help") || argv.length === 0) {
    process.stdout.write(usage());
    return 0;
  }

  const root = bundleRoot();
  const loaded = readBundleConfig(root);
  // Decide what to run before asking whether the bundle is provisioned: a
  // machine with its own working REA must not be sent into an ~800 MB
  // provisioning run just because this bundle has no state yet.
  const bundleVersion = loaded.ok ? (loaded.config.versions?.reaAgents ?? null) : null;
  const launch = resolveLaunch({ root, bundleVersion, bundleProvisioned: loaded.ok });
  if (launch.invalid !== null) {
    process.stderr.write(
      `rea-shim: REA_BUNDLE_LAUNCH="${launch.invalid}" is not one of ${LAUNCH_MODES.join("/")}; using auto.\n`,
    );
  }
  // Upstream can add a second row for the same serverName; the shim cannot stop
  // DSH from loading both rows, but saying so is better than doubled tools with
  // no stated cause. The status report carries the same fact for diagnostics.
  const duplicate = foreignReaRegistration();
  if (duplicate && !argv.includes("--shim-status")) {
    process.stderr.write(
      `\n  dsh-plugin-rea (bundle): duplicate REA registration.\n` +
        `  ${duplicate.patch} also registers serverName "rea" (id "${duplicate.id}").\n` +
        `  This bundle's row is id "mcp-rea" with the same serverName; DSH rejects the later\n` +
        `  entry as a duplicate server name, so only one survives. Keep exactly one of them.\n`,
    );
  }

  if (argv.includes("--shim-status")) {
    const report = {
      bundleRoot: root,
      bundleFile: loaded.file,
      provisioned: loaded.ok,
      reason: loaded.ok ? undefined : loaded.code,
      autoProvision: process.env.REA_BUNDLE_AUTO_PROVISION ?? "(default)",
      launch: {
        preference: launch.preference,
        mode: launch.mode,
        reason: launch.reason,
        // Reported, not implied: `mode: "system"` with `unusable: true` is a
        // request that cannot be met, and a caller reading only the mode would
        // draw the opposite conclusion.
        unusable: launch.unusable === true,
        systemRea: launch.system?.found ? { file: launch.system.file, version: launch.system.version } : null,
      },
    };
    if (launch.system?.rejected?.length) report.launch.rejected = launch.system.rejected;
    if (duplicate) report.duplicateRegistration = duplicate;
    if (loaded.ok) {
      report.paths = loaded.config.paths ?? {};
      report.versions = loaded.config.versions ?? {};
      report.rea = resolveRea(loaded.config, root);
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    // The row works either way round — a system launch needs no bundle, a bundle
    // launch needs a provisioned one — but a PINNED system launch with nothing to
    // launch is a failure whether or not the bundle happens to be provisioned,
    // and reporting 0 there is how a broken row looks healthy until it starts.
    const usable = launch.mode === "system" ? launch.unusable !== true : loaded.ok;
    return usable ? 0 : EX_CONFIG;
  }

  if (launch.mode === "system") {
    if (launch.unusable) {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): REA_BUNDLE_LAUNCH=system was requested, but no usable REA was found.\n` +
          `  ${launch.reason}\n\n` +
          `  Install REA (\`npm install -g rea-agents\`), point REA_BUNDLE_SYSTEM_REA at it,\n` +
          `  or unset REA_BUNDLE_LAUNCH to use the provisioned bundle instead.\n`,
      );
      return EX_CONFIG;
    }
    if (argv.includes("--shim-print-env")) {
      process.stdout.write(
        JSON.stringify({ launch: "system", rea: launch.system.file, version: launch.system.version }, null, 2) + "\n",
      );
      return 0;
    }
    // The 1.x contract, from the 2.x row: the machine's own REA, its own Node,
    // its own PATH. Nothing is provisioned and no bundle state is required.
    return launchSystemRea(launch.system, argv);
  }

  if (!loaded.ok) {
    const message =
      loaded.code === "missing"
        ? `No bundle state at ${loaded.file}.`
        : `Bundle state at ${loaded.file} could not be parsed.`;
    // Both "missing" and "malformed" start a run. A malformed file used to fail
    // permanently: setup overwrites a bundle.json it cannot parse, but nothing
    // ever started setup, so every restart reported the same EX_CONFIG until the
    // operator deleted the file by hand. The lock stops a provisioning loop when
    // writing keeps failing.
    const provisioning = maybeAutoProvision(root);
    if (provisioning.started) {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): first run 鈥?provisioning started in the background.\n  progress: ${provisioning.logPath}\n`,
      );
    } else if (provisioning.reason === "last-run-failed") {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): the last provisioning attempt failed (exit ${provisioning.exit ?? "?"}).\n` +
          `  Nothing is running right now 鈥?read the log, then re-run setup.\n  log: ${provisioning.logPath}\n`,
      );
    } else if (provisioning.reason === "in-flight") {
      // A live run owns the lock. Saying nothing here is what made a wedged
      // provisioning attempt look like a machine that simply has no bundle.
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): provisioning is already running in the background.\n  progress: ${provisioning.logPath}\n`,
      );
    } else if (provisioning.reason === "spawn-failed" || provisioning.reason === "unwritable") {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): provisioning could not be started (${provisioning.reason}).\n` +
          `  Run it by hand:\n    node "${path.join(root, "scripts", "setup.mjs")}" --root "${root}"\n`,
      );
    }
    return fail(message, loaded.detail);
  }

  const rea = resolveRea(loaded.config, root);
  if (!rea.ok) return fail(rea.reason);

  const env = childEnvironment(loaded.config);
  if (argv.includes("--shim-print-env")) {
    const interesting = Object.fromEntries(
      Object.entries(env).filter(([key]) =>
        /^(GHIDRA_INSTALL_DIR|JAVA_HOME|REA_[A-Z0-9_]+|PATH)$/.test(key),
      ),
    );
    process.stdout.write(JSON.stringify(interesting, null, 2) + "\n");
    return 0;
  }

  // Pass through whatever the row supplied; 'mcp' in the normal case.
  const childArgs = [rea.reaEntry, ...(argv.length > 0 ? argv : ["mcp"])];
  const child = spawn(rea.node, childArgs, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (error) => {
    process.stderr.write(
      `rea-shim: could not start ${rea.node}\n  ${String(error && error.message)}\n`,
    );
    process.exit(EX_CONFIG);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raising the signal is not portable: process.kill(pid, "SIGTERM")
      // throws ERR_UNKNOWN_SIGNAL on Windows. Report the conventional 128+n
      // status instead, which the harness reads the same way.
      const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
      process.exit(128 + (signals[signal] ?? 0));
    }
    process.exit(code ?? 0);
  });
  return null;
}

const status = main();
if (typeof status === "number") process.exit(status);
