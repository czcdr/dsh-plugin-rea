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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EX_CONFIG = 78;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";

/** DSH home: env first, then the conventional location. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homedir(), ".dsh");
}

/** Where setup writes the machine-local truth. Overridable for testing. */
function bundleRoot() {
  const override = process.env.REA_BUNDLE_ROOT;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(dshHome(), "plugins", "rea-bundle");
}

/**
 * On first run there is nothing to launch. Provisioning is a long download, so
 * it is started detached: the harness may kill this row (or the whole session)
 * long before 800 MB arrive, and the downloader is resumable and idempotent, so
 * a killed attempt is simply continued on the next start.
 *
 * Set REA_BUNDLE_AUTO_PROVISION=0 to require an explicit `setup.mjs` run.
 * Returns the log path when a run was started, otherwise null.
 */
function maybeAutoProvision(root) {
  if (process.env.REA_BUNDLE_AUTO_PROVISION === "0") return null;
  const setupScript = path.join(PLUGIN_ROOT, "scripts", "setup.mjs");
  if (!existsSync(setupScript)) return null;
  const lock = path.join(root, "setup.lock");
  const logPath = path.join(root, "logs", "setup.log");
  if (existsSync(lock)) {
    // A crashed run must not wedge provisioning forever: honour the lock only
    // while it is fresh; setup removes it itself when it finishes cleanly.
    let age = Infinity;
    try {
      age = Date.now() - Number(readFileSync(lock, "utf8").trim() || 0);
    } catch {
      age = Infinity;
    }
    if (Number.isFinite(age) && age < 6 * 60 * 60 * 1000) return logPath;
  }
  try {
    mkdirSync(path.join(root, "logs"), { recursive: true });
    writeFileSync(lock, String(Date.now()));
  } catch {
    /* a read-only bundle root must never break the harness */
    return null;
  }
  try {
    const child = spawn(process.execPath, [setupScript, "--root", root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return logPath;
  } catch {
    return null;
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
  lines.push(
    "",
    "  Finish setup with:",
    "    node \"" + path.join(PLUGIN_ROOT, "scripts", "setup.mjs") + "\"",
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
  const reaEntry = paths.reaEntry
    ?? path.join(root, "vendor", "rea-agents", "scripts", "rea.mjs");

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

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--shim-help")) {
    process.stdout.write(
      [
        "rea-shim: launches the vendored REA MCP server for a DSH MCP row.",
        "",
        "  node bin/rea-shim.mjs [rea arguments...]   (normal use: 'mcp')",
        "  node bin/rea-shim.mjs --shim-status        provisioning status, no launch",
        "  node bin/rea-shim.mjs --shim-print-env     the environment it would export",
        "",
        `  bundle root: ${bundleRoot()}`,
        `  plugin root: ${PLUGIN_ROOT}`,
        "",
      ].join("\n"),
    );
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
    const logPath = loaded.code === "missing" ? maybeAutoProvision(root) : null;
    if (logPath) {
      process.stderr.write(
        `\n  dsh-plugin-rea (bundle): first run — provisioning started in the background.\n  progress: ${logPath}\n`,
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
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  return null;
}

const status = main();
if (typeof status === "number") process.exit(status);
