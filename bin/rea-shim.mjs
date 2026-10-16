#!/usr/bin/env node
/**
 * rea-shim — the process the DSH MCP row launches.
 *
 * Why this exists: the published `cordis.patch.yml` must carry no machine path,
 * yet REA needs absolute paths for every dependency. The shim is the seam: it
 * reads one machine-local JSON file, exports exactly the variables REA reads,
 * and execs the vendored REA CLI with the arguments the row was given.
 *
 * It downloads nothing, writes nothing, and never touches PATH.
 *
 * Exit codes:  0 child exited normally   * child's own status
 *              78 EX_CONFIG  bundle not provisioned (or unusable) — the row has
 *                            `failOnStartupError: false`, so the harness stays up
 *                            and the message is the operator's remediation.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 *    bundle sitting right next to it — and start a second ~800 MB run there.
 *  * The **checkout** copy (`<plugin>/bin/rea-shim.mjs`) is what a human runs, e.g.
 *    `npm run bundle:status`, from a shell where DSH_HOME *is* visible. Its own
 *    directory is the plugin, not the bundle, so resolving to itself would report
 *    "not provisioned" on a fully provisioned machine — and a bare
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
 * usable, and fall back to the local copy — which is also all a first run has.
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
 * The provisioning lock is a small JSON record: { state, pid, at, exit? }.
 * `state: "running"` is written when a run is started (setup's own pid once it
 * exists), and the failing run rewrites it as `state: "failed"` — it is kept on
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
 * Returns { started, reason, logPath } — the caller words its message from
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
    // freshness rule — without it the exclusive create below failed with EEXIST
    // *forever*, auto-provisioning never ran again, and main() printed nothing at
    // all for that outcome. The lock's own "honour it only while it is fresh"
    // comment described behaviour the code did not have.
    rmSync(lock, { force: true });
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
  // with — and a bundle mirrored before the manifest travelled with it has no
  // usable copy at all, so the honest answer is then "run the plugin's own script".
  const setupScript = provisioningScript(bundleRoot());
  lines.push(
    "",
    "  Finish setup with:",
    setupScript
      ? "    node \"" + setupScript + "\""
      : "    node \"<installed plugin directory>/scripts/setup.mjs\"",
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
  // fires when an older bundle.json has no paths.reaEntry — which is exactly when
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
 * Usage text, also what a bare invocation prints.
 *
 * `package.json` exposes this file as the `rea-bundle-status` bin, and npm's bin
 * shim can only forward the arguments a user typed — it cannot append a flag. So a
 * bare `rea-bundle-status`, which is exactly what that name invites, used to fall
 * through to the launch path: it started REA, and on an unprovisioned machine it
 * began an ~800 MB download. Reporting usage instead makes the command's behaviour
 * match its name, and the row is unaffected because it always passes `mcp`.
 */
function usage() {
  return [
    "rea-shim: launches the vendored REA MCP server for a DSH MCP row.",
    "",
    "  node bin/rea-shim.mjs [rea arguments...]   (normal use: 'mcp')",
    "  node bin/rea-shim.mjs --shim-status        provisioning status, no launch",
    "  node bin/rea-shim.mjs --shim-print-env     the environment it would export",
    "",
    `  bundle root: ${bundleRoot()}`,
    `  plugin root: ${PLUGIN_ROOT}`,
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

  if (argv.includes("--shim-status")) {
    const report = {
      bundleRoot: root,
      bundleFile: loaded.file,
      provisioned: loaded.ok,
      reason: loaded.ok ? undefined : loaded.code,
      autoProvision: process.env.REA_BUNDLE_AUTO_PROVISION ?? "(default)",
    };
    if (loaded.ok) {
      report.paths = loaded.config.paths ?? {};
      report.versions = loaded.config.versions ?? {};
      report.rea = resolveRea(loaded.config, root);
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return loaded.ok ? 0 : EX_CONFIG;
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
        `\n  dsh-plugin-rea (bundle): first run — provisioning started in the background.\n  progress: ${provisioning.logPath}\n`,
      );
    } else if (provisioning.reason === "last-run-failed") {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): the last provisioning attempt failed (exit ${provisioning.exit ?? "?"}).\n` +
          `  Nothing is running right now — read the log, then re-run setup.\n  log: ${provisioning.logPath}\n`,
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
          `  Run it by hand:\n    node "${path.join(root, "scripts", "setup.mjs")}"\n`,
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
