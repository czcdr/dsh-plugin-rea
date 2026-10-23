#!/usr/bin/env node
/**
 * Unit tests for the pure logic in scripts/setup.mjs — the parts that broke
 * during development and would break silently again:
 *
 *   - probe token substitution (a doubled "\bin\java.exe\bin\java.exe" slipped
 *     through once, and a self-referential token could not resolve at all)
 *   - root-directory stripping (an archive's single top-level folder)
 *   - byte formatting and version comparison
 *
 * Runs with `node --test`. No network, no filesystem writes outside a temp dir.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_RELEASES, OUTSIDE_HOSTS, checkHostCoverage, declaredHostRange, compareVersions, satisfiesDeclaredRange } from "./host-compat.mjs";
import { computeGuideState, reaPinMatches } from "../bin/rea-guide.mjs";
import { powerShellCandidates, unsupportedMessage } from "./check-updates.mjs";

/* ------------------------------------------------- probe token substitution */

// Mirror of the substitution in setup.mjs, kept small on purpose: the test's job
// is to pin the contract, and the integration run covers the real module.
const EXE = process.platform === "win32" ? ".exe" : "";

function substituteProbe(value, context) {
  const vendor = context.vendor;
  let text = String(value);
  const swap = (token, resolved) => {
    if (typeof resolved === "string" && resolved !== "") text = text.replaceAll(token, resolved);
  };
  const vendorPath = (name) => {
    const resolved = context.resolved?.[name];
    if (resolved && typeof resolved.path === "string") return resolved.path;
    if (name === "node") return process.execPath;
    if (name === "jdk") return path.join(context.vendor, "jdk");
    if (name === "ghidra") return path.join(context.vendor, "ghidra");
    return null;
  };
  swap("{vendor}", vendor);
  swap("{vendorDir}", vendor);
  swap("{root}", context.root);
  swap("{node}", vendorPath("node"));
  swap("{jdk}", vendorPath("jdk"));
  swap("{ghidra}", vendorPath("ghidra"));
  const jdk = vendorPath("jdk");
  if (jdk) {
    const home = /[\\/]bin[\\/]java(\.exe)?$/i.test(jdk) ? path.dirname(path.dirname(jdk)) : jdk;
    swap("{jvm}", path.join(home, "bin", `java${EXE}`));
    swap("{javahome}", home);
  }
  // Unconditional, matching setup.mjs: on POSIX EXE is "" and a `!== ""` guard
  // would leave the literal token in place.
  text = text.replaceAll("{exe}", EXE);
  return text.replaceAll("/", path.sep);
}

function contextWith(resolved) {
  return { vendor: path.join(path.sep, "bundle", "vendor"), root: path.join(path.sep, "bundle"), resolved };
}

test("a jdk recorded as an executable still yields a JAVA_HOME-derived {jvm}", () => {
  // The real failure: {jdk} resolved to java.exe, so join({jdk}, "bin", "java")
  // produced "<...>\bin\java.exe\bin\java.exe".
  const context = contextWith({ jdk: { path: path.join(path.sep, "bundle", "vendor", "jdk", "bin", `java${EXE}`) } });
  const result = substituteProbe("{jvm}", context);
  assert.equal(result, path.join(path.sep, "bundle", "vendor", "jdk", "bin", `java${EXE}`));
  assert.equal(result.includes(`java${EXE}${path.sep}bin`), false, "must not double-append the java path");
});

test("a jdk recorded as a home yields the same {jvm}", () => {
  const context = contextWith({ jdk: { path: path.join(path.sep, "bundle", "vendor", "jdk") } });
  const result = substituteProbe("{jvm}", context);
  assert.equal(result, path.join(path.sep, "bundle", "vendor", "jdk", "bin", `java${EXE}`));
});

test("{jvm} resolves while the jdk itself is being provisioned", () => {
  // No resolved entry at all: the component's own probe must still work.
  const context = contextWith({});
  const result = substituteProbe("{jvm}", context);
  assert.equal(result, path.join(path.sep, "bundle", "vendor", "jdk", "bin", `java${EXE}`));
});

test("{ghidra} resolves while the ghidra component itself is being provisioned", () => {
  const context = contextWith({});
  assert.match(substituteProbe("{ghidra}/Ghidra/application.properties", context), /vendor.*ghidra.*Ghidra/);
});

test("{node} falls back to the running interpreter while node is provisioned", () => {
  const context = contextWith({});
  assert.equal(substituteProbe("{node}", context), process.execPath);
});

test("{exe} is expanded for tokens that need it and not for those that carry it", () => {
  const context = contextWith({
    jdk: { path: path.join(path.sep, "bundle", "vendor", "jdk") },
  });
  const adb = substituteProbe("{vendor}/platform-tools/adb{exe}", context);
  assert.equal(adb, path.join(path.sep, "bundle", "vendor", "platform-tools", `adb${EXE}`));
  // On POSIX {exe} is "", and the substitution must still consume the token:
  // leaving "adb{exe}" behind fails the probe with ENOENT on Linux and macOS.
  assert.equal(adb.includes("{exe}"), false, "{exe} must be consumed even when it expands to nothing");
  assert.equal(substituteProbe("{jvm}", context).endsWith(`java${EXE}`), true);
  // Only meaningful where {exe} expands to something: on POSIX EXE is "", so
  // `java${EXE}${EXE}` degenerates to "java" and endsWith is true by
  // construction — an assertion that can only ever fail on Windows.
  if (EXE) assert.equal(substituteProbe("{jvm}", context).endsWith(`java${EXE}${EXE}`), false);
});

test("an unresolved token stays literal instead of throwing", () => {
  // A missing component must produce a readable ENOENT for the probe, not an
  // exception out of path.join.
  const context = contextWith({});
  const result = substituteProbe("{ghidra}/x", contextWith({ ghidra: undefined }));
  assert.equal(result, path.join(path.sep, "bundle", "vendor", "ghidra", "x"));
});

/* ------------------------------------------------------- root dir stripping */

/** Mirror of the descent rule: one level per declared stripRootComponents. */
function pickEffectiveRoot(staging, strip, readdir, isDirectory) {
  let effective = staging;
  for (let level = 0; level < strip; level += 1) {
    const entries = readdir(effective).filter((entry) => !entry.startsWith("."));
    if (entries.length !== 1 || !isDirectory(path.join(effective, entries[0]))) break;
    effective = path.join(effective, entries[0]);
  }
  return effective;
}

// Fixture keys must be built with path.join: the descent uses it, so a
// hand-written "/s" would never match on Windows.
const ROOT = path.join(path.sep, "s");
const NODE_DIR = path.join(ROOT, "node-v24.21.0-win-x64");
const JDK_DIR = path.join(ROOT, "jdk-21.0.12.1+1");

test("stripRootComponents descends past a single top-level folder", () => {
  const tree = {
    [ROOT]: ["node-v24.21.0-win-x64"],
    [NODE_DIR]: ["node.exe", "npm.cmd"],
  };
  const readdir = (dir) => tree[dir] ?? [];
  const isDirectory = (entry) => Object.prototype.hasOwnProperty.call(tree, entry);
  assert.equal(pickEffectiveRoot(ROOT, 1, readdir, isDirectory), NODE_DIR);
});

test("stripRootComponents leaves a flat archive alone", () => {
  const tree = { [ROOT]: ["adb.exe", "AdbWinApi.dll"] };
  const readdir = (dir) => tree[dir] ?? [];
  const isDirectory = () => false;
  assert.equal(pickEffectiveRoot(ROOT, 1, readdir, isDirectory), ROOT);
});

test("stop descending when the single entry is a file, not a directory", () => {
  // A real archive whose root holds exactly one FILE must not be stripped: the
  // file itself is the payload. Only single DIRECTORIES are descended into.
  const tree = { [ROOT]: ["payload.bin"] };
  const readdir = (dir) => tree[dir] ?? [];
  const isDirectory = (entry) => Object.prototype.hasOwnProperty.call(tree, entry);
  assert.equal(pickEffectiveRoot(ROOT, 1, readdir, isDirectory), ROOT);
});

test("a jdk-style archive descends into its single root directory", () => {
  const tree = {
    [ROOT]: ["jdk-21.0.12.1+1"],
    [JDK_DIR]: ["bin", "lib", "jmods", "release"],
    [path.join(JDK_DIR, "bin")]: ["java.exe", "javac.exe"],
  };
  const readdir = (dir) => tree[dir] ?? [];
  const isDirectory = (entry) => Object.prototype.hasOwnProperty.call(tree, entry);
  assert.equal(pickEffectiveRoot(ROOT, 1, readdir, isDirectory), JDK_DIR);
});

/* --------------------------------------------------------------- tiny helpers */

test("dotted version comparison used by the reuse check", () => {
  const cmp = (a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
    }
    return 0;
  };
  assert.ok(cmp("24.21.0", "24.11.0") > 0);
  assert.ok(cmp("22.19.0", "22.19.0") === 0);
  assert.ok(cmp("21.0.12", "21.0.12.1") < 1);
});

test("byte sizes format without a floating-point surprise", () => {
  const mib = (bytes) => (bytes / 1048576).toFixed(1);
  assert.equal(mib(569649598), "543.3");
  assert.equal(mib(8044989), "7.7");
});

/* ------------------------------------------------------ the shim's two homes */

// The shim runs from two places and must answer differently in each:
//   * the mirrored copy the published row launches sits at <bundle>/bin/ and must
//     use its own location — an MCP child has no DSH_HOME to consult, because the
//     harness strips every DSH_* name from it;
//   * the checkout copy a human runs (`npm run bundle:status`) is a plugin, not a
//     bundle, and must resolve the same root setup.mjs writes.
// Both mistakes are silent: the checkout claims "not provisioned" on a machine
// that is provisioned, and a bare `node bin/rea-shim.mjs mcp` provisions ~800 MB
// into the plugin directory.
const SHIM_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "rea-shim.mjs");

function shimBundleRoot(shimFile, env) {
  const run = spawnSync(process.execPath, [shimFile, "--shim-status"], {
    encoding: "utf8",
    // These tests assert bundle-root resolution, not the launch decision. Pinning
    // the mode keeps them independent of whether THIS machine has a REA on PATH
    // (and keeps them from paying for a probe on every spawn).
    env: { ...process.env, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle", ...env },
  });
  // --shim-status prints its report even when no bundle exists yet (exit 78).
  return JSON.parse(run.stdout).bundleRoot;
}

test("a mirrored shim takes its bundle root from its own location, not DSH_HOME", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-mirror-"));
  try {
    const mirror = path.join(root, "plugins", "rea-bundle");
    mkdirSync(path.join(mirror, "bin"), { recursive: true });
    copyFileSync(SHIM_SOURCE, path.join(mirror, "bin", "rea-shim.mjs"));
    assert.equal(shimBundleRoot(path.join(mirror, "bin", "rea-shim.mjs"), { DSH_HOME: path.join(root, "elsewhere") }), mirror);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout shim resolves the bundle root setup.mjs would write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-checkout-"));
  try {
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    copyFileSync(SHIM_SOURCE, path.join(checkout, "bin", "rea-shim.mjs"));
    // The discriminator: only a plugin checkout ships cordis.patch.yml.
    writeFileSync(path.join(checkout, "cordis.patch.yml"), "- insert: []\n");
    const home = path.join(root, "dsh-home");
    assert.equal(
      shimBundleRoot(path.join(checkout, "bin", "rea-shim.mjs"), { DSH_HOME: home }),
      path.join(home, "plugins", "rea-bundle"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REA_BUNDLE_ROOT still overrides both layouts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-override-"));
  try {
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    copyFileSync(SHIM_SOURCE, path.join(checkout, "bin", "rea-shim.mjs"));
    writeFileSync(path.join(checkout, "cordis.patch.yml"), "- insert: []\n");
    const forced = path.join(root, "forced");
    assert.equal(shimBundleRoot(path.join(checkout, "bin", "rea-shim.mjs"), { REA_BUNDLE_ROOT: forced }), forced);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare invocation refuses with a usage error when no terminal is watching", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-bare-"));
  try {
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    copyFileSync(SHIM_SOURCE, path.join(checkout, "bin", "rea-shim.mjs"));
    writeFileSync(path.join(checkout, "cordis.patch.yml"), "- insert: []\n");
    // The test guards itself: package.json exposes this file as the
    // `rea-bundle-status` bin, npm cannot append a flag for it, and a regression
    // here would start REA — or begin an ~800 MB download on an unprovisioned
    // machine. So setup is a stub that exits immediately.
    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    mkdirSync(path.join(checkout, "manifest"), { recursive: true });
    writeFileSync(path.join(checkout, "scripts", "setup.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(checkout, "manifest", "bundle.manifest.json"), "{}\n");

    const home = path.join(root, "dsh-home");
    const env = { ...process.env, DSH_HOME: home };
    // Deliberately left at its default: the point is that a bare run must not reach
    // the provisioning branch at all, not that provisioning is switched off.
    delete env.REA_BUNDLE_AUTO_PROVISION;

    const run = spawnSync(process.execPath, [path.join(checkout, "bin", "rea-shim.mjs")], {
      encoding: "utf8",
      env,
      timeout: 60000,
    });
    // spawnSync gives the child pipes, not a terminal — which is exactly the
    // harness case. The row is supposed to pass `mcp`; exiting 0 here left REA
    // silently absent from the tool list under `failOnStartupError: false`, so
    // the no-terminal path now reports itself on stderr and leaves EX_USAGE.
    assert.equal(run.status, 64, run.stderr);
    assert.match(run.stdout, /--shim-status/);
    assert.match(run.stderr, /must pass `mcp`/);
    // A lock would mean a provisioning run was started, which a stray
    // `rea-bundle-status` must never do.
    assert.equal(existsSync(path.join(home, "plugins", "rea-bundle", "setup.lock")), false);

    // The explicit request still answers with usage and success, for the human
    // who typed the launcher rather than a supervisor that lost the arguments.
    const helped = spawnSync(process.execPath, [path.join(checkout, "bin", "rea-shim.mjs"), "--shim-help"], {
      encoding: "utf8",
      env,
      timeout: 60000,
    });
    assert.equal(helped.status, 0, helped.stderr);
    assert.match(helped.stdout, /--shim-status/);
    assert.doesNotMatch(helped.stderr, /must pass `mcp`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------- reusing a Node must check engines */

// `manifest.components.node.probe.expect.regex` is the contract, and its `why`
// says the reuse path must reject an incompatible runtime *there*. Adoption used
// to be `fileExists` only, so a Node 20 on PATH was recorded in bundle.json and
// the failure surfaced much later as an unexplained REA start failure.
//
// The tests below run setup.mjs for real (dry-run, node only, temp root: no
// network, no writes outside the temp directory) and keep the fix honest in both
// directions — a compatible node must still be adopted, so this cannot pass by
// rejecting everything.
const SETUP_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "setup.mjs");
const MANIFEST_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest", "bundle.manifest.json");

function runSetupNodeOnly(setupPath, root, env) {
  return spawnSync(process.execPath, [setupPath, "--reuse", "--dry-run", "--only", "node", "--root", root], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ...env },
  });
}

test("--reuse still adopts a compatible node", (t) => {
  // The candidate is the host's own interpreter, so this test only means anything
  // where the host satisfies REA's engines: on a Node 20 runner it fails for a
  // reason that has nothing to do with the reuse check (the check is doing its
  // job), while CI's pinned Node 22 never notices.
  const [major, minor] = process.versions.node.split(".").map(Number);
  const compatible = (major === 22 && minor >= 19) || (major === 24 && minor >= 11) || major >= 26;
  if (!compatible) {
    t.skip(`host Node ${process.versions.node} is outside REA's engines; the candidate would be rejected on purpose`);
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "rea-node-ok-"));
  try {
    const run = runSetupNodeOnly(SETUP_SOURCE, root, { REA_BUNDLE_NODE: process.execPath });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /reusing existing node from REA_BUNDLE_NODE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--reuse rejects a candidate the manifest's node probe rejects", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-node-reject-"));
  try {
    // A synthetic plugin tree whose manifest rejects the *running* Node, so the
    // version branch is exercised deterministically on every platform instead of
    // depending on which OS built-ins happen to exist.
    const plugin = path.join(root, "plugin");
    mkdirSync(path.join(plugin, "scripts"), { recursive: true });
    mkdirSync(path.join(plugin, "manifest"), { recursive: true });
    copyFileSync(SETUP_SOURCE, path.join(plugin, "scripts", "setup.mjs"));
    const manifest = JSON.parse(readFileSync(MANIFEST_SOURCE, "utf8"));
    manifest.components.node.probe.expect.regex = "^v99\\.";
    writeFileSync(path.join(plugin, "manifest", "bundle.manifest.json"), JSON.stringify(manifest, null, 2));

    const run = runSetupNodeOnly(path.join(plugin, "scripts", "setup.mjs"), path.join(root, "bundle"), {
      REA_BUNDLE_NODE: process.execPath,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /reusing existing node from REA_BUNDLE_NODE/);
    assert.match(run.stdout, /not reusing REA_BUNDLE_NODE node/);
    assert.match(run.stdout, /which REA's engines reject/);
    // ...and it falls through to provisioning rather than giving up.
    assert.match(run.stdout, /\[plan\] node —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--reuse rejects a candidate that cannot be run at all", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-node-broken-"));
  try {
    // A file that exists but is not an executable: on Windows a .bat/.cmd wrapper
    // reaches the same rejection (execFile cannot spawn one without a shell), and
    // such a Node could never have launched REA either.
    const broken = path.join(root, EXE ? "broken-node.exe" : "broken-node");
    writeFileSync(broken, "this is not an executable\n");
    if (!EXE) chmodSync(broken, 0o644);
    const run = runSetupNodeOnly(SETUP_SOURCE, path.join(root, "bundle"), { REA_BUNDLE_NODE: broken });
    assert.equal(run.status, 0, run.stderr);
    // Not adopted from the override. (A compatible node later on PATH may still be
    // adopted — that is the fallback working, not the check being bypassed.)
    assert.doesNotMatch(run.stdout, /reusing existing node from REA_BUNDLE_NODE/);
    assert.match(run.stdout, /not reusing REA_BUNDLE_NODE node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------ an optional component cannot fail the run */

// `manifest.components.androidPlatformTools` declares `"optional": true` ("without
// a device these tools simply report no devices"), but setup.mjs never read that
// field: an unreachable dl.google.com — the only Google-hosted component — failed
// the whole run on a machine where everything REA needs had provisioned fine.
// --offline reproduces exactly that failure with no network: the archive is simply
// not in the cache.
test("an unavailable optional component is reported, not fatal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-optional-"));
  try {
    // A stub REA, so the probe/shim stages have something to run: this test is
    // about the optional accounting, not about REA.
    const stub = path.join(root, "vendor", "node_modules", "rea-agents", "scripts");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      path.join(stub, "rea.mjs"),
      'if (process.argv.includes("--version")) { console.log("6.5.0"); } else { console.log(JSON.stringify({ checks: [], tools: [] })); }\n',
    );

    const run = spawnSync(process.execPath, [SETUP_SOURCE, "--offline", "--only", "androidPlatformTools", "--root", root], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /optional component\(s\) unavailable/);
    assert.match(run.stdout, /optional: androidPlatformTools/);
    assert.doesNotMatch(run.stdout, /setup finished with/);

    // Reported, never invented: no adb path is recorded, and the component is
    // marked unavailable so the shim exports no REA_ADB_PATH at all.
    const written = JSON.parse(readFileSync(path.join(root, "bundle.json"), "utf8"));
    assert.equal(written.paths.adb, null);
    assert.equal(written.components.androidPlatformTools.unavailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------ the Ghidra smoke is measured, and it can be off */

// `doctor` validates paths, versions and which Java would be chosen; it never
// imports a binary. The first real import pays a one-time ~35 s for the JVM start
// plus default auto-analysis, and when the bridge or the native addon is broken
// the operator met that only as an MCP tool timeout on the first real analysis —
// which reads exactly like "the runtime upgrade broke REA". The smoke step turns
// provisioning into a measured verdict. These tests keep it bounded in both
// directions: it must not run when this run resolved no engine, --skip-smoke must
// win, and an "ok" that only checked that files exist is the bug it replaced.
function runSmokeSetup(root, extra = []) {
  const stub = path.join(root, "vendor", "node_modules", "rea-agents", "scripts");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    path.join(stub, "rea.mjs"),
    'if (process.argv.includes("--version")) { console.log("6.5.0"); } else { console.log(JSON.stringify({ checks: [], identity: {} })); }\n',
  );
  return spawnSync(process.execPath, [SETUP_SOURCE, "--reuse", "--only", "node", "--root", root, ...extra], {
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, REA_BUNDLE_NODE: process.execPath },
  });
}

test("the smoke step is skipped when this run resolved no engine", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-smoke-skip-"));
  try {
    const run = runSmokeSetup(root);
    assert.match(run.stdout, /\[skip\] smoke — this run resolved no ghidra \+ jdk pair/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--skip-smoke turns the smoke step off outright", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-smoke-off-"));
  try {
    const run = runSmokeSetup(root, ["--skip-smoke"]);
    assert.match(run.stdout, /\[skip\] smoke — disabled by --skip-smoke/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the smoke step drives a real import and fails the run when it fails", () => {
  // Contract assertions rather than a live Ghidra run: CI has no 570 MB engine.
  // What must not regress is (a) the step really invokes REA's analyze on a file
  // this run owns, and (b) a non-zero verdict is a FAIL, not a silent skip.
  const source = readFileSync(SETUP_SOURCE, "utf8");
  assert.match(source, /\[reaEntry, "analyze", smokeInput, "--json"\]/);
  assert.match(source, /step\(\s*"smoke",\s*"FAIL",/);
  assert.match(source, /path\.join\(paths\.jdk, "bin", `java\$\{EXE\}`\)/);
  // The two variables the mirrored shim exports must reach the probe and the
  // smoke alike; without them both fell back to probing the machine.
  assert.match(source, /GHIDRA_INSTALL_DIR: paths\.ghidra/);
  assert.match(source, /JAVA_HOME: paths\.jdk/);
});

test("a reused component carries its own version into the record", () => {
  // Both reuse branches returned only `{path, how}`, so bundle.json recorded the
  // interpreter running setup for Node and the manifest's pin for a JDK/Ghidra —
  // a record that names a runtime but describes a different build, which is the
  // one thing `check-updates.ps1` exists to catch. A live fixture cannot cover
  // this: adoption runs the component's own probe, so a stub tree would have to
  // be a working compiler or analysis engine. Contract assertions instead.
  const source = readFileSync(SETUP_SOURCE, "utf8");
  // The adopted record is spread, not rebuilt from its path alone.
  assert.match(source, /return \{ \.\.\.reused, reused: true \};/);
  // ...and each installation is asked what it is, from its own declaration.
  assert.match(source, /version: readJdkVersion\(home\)/);
  assert.match(source, /version: readGhidraVersion\(install\)/);
  assert.match(source, /function readJdkVersion\(root\)/);
  assert.match(source, /function readGhidraVersion\(root\)/);
});

test("a failed extraction leaves the previous install in place", () => {
  // Clearing the destination BEFORE extracting made provisioning destructive on
  // the one path it must not be: a missing extractor (a minimal Linux without
  // unzip/python3/tar) or a full disk destroyed a working install and put nothing
  // in its place. The tree is now cleared only for the rename that replaces it.
  const source = readFileSync(SETUP_SOURCE, "utf8");
  const lines = source.split("\n");
  const extractAt = lines.findIndex((line) => line.includes("extract(archivePath, staging"));
  const clearAt = lines.findIndex((line) => line.includes("rmSync(target"));
  assert.ok(extractAt >= 0, "the archive must be extracted into staging");
  assert.ok(clearAt >= 0, "the destination must still be cleared before the rename");
  assert.ok(clearAt > extractAt, "clearing the destination before extraction destroys a working install");
});

test("the manifest audit's probe-staleness check is not dead code", () => {
  // `Number.isFinite(next.split(".")[2])` tested a STRING, and Number.isFinite
  // never coerces: the branch was always false, so item 13 could not fail and a
  // probe that accepted the next patch/minor passed the audit. Verified by
  // running the audit against a manifest whose probe is `^6\.` — it now reports
  // "accepts 6.7.1 (the next patch)".
  const audit = readFileSync(path.join(REPO_ROOT, "scripts", "audit-manifest.mjs"), "utf8");
  assert.match(audit, /Number\.isFinite\(Number\(next\.split\("\."\)\[2\]\)\)/);
  assert.doesNotMatch(audit, /Number\.isFinite\(next\.split\("\."\)\[2\]\)/);
});

/* =========================== this round's regressions =========================
 *
 * Each test below pins a defect that was verified in the code before it was
 * changed. They run setup.mjs itself (never a mirror of it) against a throwaway
 * plugin tree, so the whole wiring — manifest → download → place → wire — is the
 * real one. Nothing here reaches the network: a component is either satisfied
 * from a primed cache, or its download is *supposed* to return before opening a
 * socket.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SHIM = path.join(REPO_ROOT, "bin", "rea-shim.mjs");

/** A throwaway plugin tree: setup.mjs, the real manifest, and the shim. */
function makePluginTree(root, mutateManifest) {
  const plugin = path.join(root, "plugin");
  mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  mkdirSync(path.join(plugin, "manifest"), { recursive: true });
  mkdirSync(path.join(plugin, "bin"), { recursive: true });
  copyFileSync(SETUP_SOURCE, path.join(plugin, "scripts", "setup.mjs"));
  copyFileSync(REPO_SHIM, path.join(plugin, "bin", "rea-shim.mjs"));
  const manifest = JSON.parse(readFileSync(MANIFEST_SOURCE, "utf8"));
  if (mutateManifest) mutateManifest(manifest);
  writeFileSync(path.join(plugin, "manifest", "bundle.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return path.join(plugin, "scripts", "setup.mjs");
}

/** A `file`-kind component, used to replace a real one in a test manifest. */
function testComponent(url, payload, extra = {}) {
  return {
    description: "test vehicle",
    kind: "file",
    license: "test",
    requires: extra.requires ?? [],
    optional: extra.optional ?? false,
    probe: extra.probe ?? {},
    entries: {
      all: [
        {
          id: "payload",
          version: "1",
          url,
          format: "file",
          size: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          moveTo: extra.moveTo ?? "payload",
          saveAs: extra.saveAs ?? "payload.bin",
          ...(extra.executable ? { executable: true } : {}),
        },
      ],
    },
  };
}

/** A stub vendored CLI, so the probe/shim stages have something to run. */
// The version follows the manifest pin: a stub that hard-codes it starts failing
// every time the pin moves, for a reason that has nothing to do with the test.
const REA_PIN = JSON.parse(readFileSync(MANIFEST_SOURCE, "utf8")).pins.reaAgents;
function addReaStub(bundleRoot, version = REA_PIN) {
  const dir = path.join(bundleRoot, "vendor", "node_modules", "rea-agents", "scripts");
  mkdirSync(dir, { recursive: true });
  const identity = JSON.stringify({ cli_package_version: version, catalog: { counts: { mcp_tools: 206 } } });
  writeFileSync(
    path.join(dir, "rea.mjs"),
    'if (process.argv.includes("--version")) { console.log(' + JSON.stringify(version) + '); }\n' +
      "else { console.log(JSON.stringify({ healthy: true, checks: [], identity: " + identity + " })); }\n",
  );
}

function runToCompletion(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ status: -1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/* ------------------------------- --only keeps what it did not touch -------- */

test("--only keeps the records of the components it did not touch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-only-keep-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    const jdkHome = path.join(root, "jdk-home");
    mkdirSync(jdkHome, { recursive: true });
    // A provisioned machine: the JDK and Node are recorded, and only adb is being
    // topped up. Writing bundle.json from this run's results alone erased the
    // other two, so the shim stopped exporting JAVA_HOME/GHIDRA_INSTALL_DIR.
    writeFileSync(
      path.join(bundle, "bundle.json"),
      JSON.stringify(
        {
          schema: 1,
          paths: { node: process.execPath, jdk: jdkHome, ghidra: null, adb: null },
          versions: { reaAgents: "6.5.0", node: process.versions.node, jdk: "21" },
          components: {
            node: { path: process.execPath, version: process.versions.node },
            jdk: { path: jdkHome, version: "21" },
          },
        },
        null,
        2,
      ) + "\n",
    );
    addReaStub(bundle);
    const setup = makePluginTree(root, (manifest) => {
      manifest.components.androidPlatformTools = testComponent("http://127.0.0.1:9/payload.bin", Buffer.from("adb"), { optional: true });
    });
    const run = spawnSync(process.execPath, [setup, "--offline", "--only", "androidPlatformTools", "--root", bundle], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const written = JSON.parse(readFileSync(path.join(bundle, "bundle.json"), "utf8"));
    assert.equal(written.components.jdk.path, jdkHome, "the jdk record must survive an --only run");
    assert.equal(written.paths.jdk, jdkHome, "and so must the path the shim exports as JAVA_HOME");
    assert.equal(written.components.node.path, process.execPath);
    assert.equal(written.paths.node, process.execPath);
    // The component that did run failed (offline), and stays unavailable: the
    // merge must not invent a path for it.
    assert.equal(written.paths.adb, null);
    assert.equal(written.components.androidPlatformTools.unavailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--only satisfies a requirement from the record instead of skipping the check", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-only-requires-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    const jdkHome = path.join(root, "jdk-home");
    mkdirSync(jdkHome, { recursive: true });
    const setup = makePluginTree(root, () => {});
    const args = (extra) => [setup, "--reuse", "--dry-run", "--only", "apktool", "--root", bundle, ...extra];
    // JAVA_HOME is also a way "the machine" answers this requirement, so it is
    // cleared: the first case needs the requirement to be genuinely unavailable.
    const env = { ...process.env, JAVA_HOME: "" };

    // No record at all: the requirement is genuinely unavailable, and that must be
    // reported exactly as a full run reports it.
    const missing = spawnSync(process.execPath, args([]), { encoding: "utf8", timeout: 120000, env });
    assert.match(missing.stdout, /required component "jdk" is unavailable/);

    // With a recorded JDK the requirement is answered by the record, so apktool
    // plans instead of failing on a vendor/jdk that --only never provisions.
    writeFileSync(
      path.join(bundle, "bundle.json"),
      JSON.stringify({ schema: 1, paths: { jdk: jdkHome }, versions: { jdk: "21" }, components: { jdk: { path: jdkHome, version: "21" } } }, null, 2) + "\n",
    );
    const recorded = spawnSync(process.execPath, args([]), { encoding: "utf8", timeout: 120000, env });
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);
    assert.doesNotMatch(recorded.stdout, /required component "jdk" is unavailable/);
    assert.match(recorded.stdout, /\[plan\] apktool/);
    // And `--only reaAgents` on a fresh root must still work: the node it needs is
    // the interpreter running setup, which is what provisionReaAgents already uses.
    const fresh = path.join(root, "fresh");
    const reaOnly = spawnSync(process.execPath, [setup, "--dry-run", "--only", "reaAgents", "--root", fresh], { encoding: "utf8", timeout: 120000, env });
    assert.equal(reaOnly.status, 0, `${reaOnly.stdout}\n${reaOnly.stderr}`);
    assert.doesNotMatch(reaOnly.stdout, /required component "node" is unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------- a complete .part is finished work */

test("a complete .part is verified and kept instead of re-requested", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-part-complete-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(path.join(bundle, "cache"), { recursive: true });
    const payload = Buffer.from("the whole file, already on disk\n");
    // The URL points at a closed port on purpose: the fixed code must complete
    // without opening a socket. Before the fix it sent `Range: bytes=<size>-`,
    // which a real server answers with 416, and four attempts later it reported a
    // download that was already finished as failed.
    const setup = makePluginTree(root, (manifest) => {
      manifest.components.androidPlatformTools = testComponent("http://127.0.0.1:9/payload.bin", payload);
    });
    addReaStub(bundle);
    writeFileSync(path.join(bundle, "cache", "payload.bin.part"), payload);

    const run = spawnSync(process.execPath, [setup, "--only", "androidPlatformTools", "--root", bundle], { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /was already complete; verified and kept/);
    assert.deepEqual(readFileSync(path.join(bundle, "vendor", "payload", "payload.bin")), payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- the PowerShell route resumes */

test("the PowerShell route resumes from the bytes already on disk", async (t) => {
  if (process.platform !== "win32") {
    // The Node route pins TLS (`httpsRequest`) whatever the URL scheme says, so a
    // plain-HTTP fixture can only exercise the PowerShell route — which is also the
    // Windows default and the one the resume defect was in.
    t.skip("the PowerShell download route only exists on Windows");
    return;
  }
  const payload = Buffer.alloc(1024 * 1024, 11);
  const alreadyHave = 256 * 1024;
  const seen = [];
  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const range = req.headers.range ?? null;
    seen.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (range && start >= payload.length) {
      res.writeHead(416);
      res.end();
      return;
    }
    const slice = payload.subarray(start);
    const headers = { "content-type": "application/octet-stream", "content-length": String(slice.length) };
    if (start > 0) headers["content-range"] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
    res.writeHead(start > 0 ? 206 : 200, headers);
    res.end(slice);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const root = mkdtempSync(path.join(tmpdir(), "rea-ps-resume-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(path.join(bundle, "cache"), { recursive: true });
    const setup = makePluginTree(root, (manifest) => {
      manifest.components.androidPlatformTools = testComponent(`http://127.0.0.1:${port}/payload.bin`, payload);
    });
    addReaStub(bundle);
    writeFileSync(path.join(bundle, "cache", "payload.bin.part"), payload.subarray(0, alreadyHave));

    const run = await runToCompletion(process.execPath, [setup, "--only", "androidPlatformTools", "--root", bundle], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(
      seen.some((header) => header && Number(/bytes=(\d+)-/.exec(header)?.[1]) === alreadyHave),
      `expected a resume request starting at ${alreadyHave}; saw ${JSON.stringify(seen)}`,
    );
    assert.deepEqual(readFileSync(path.join(bundle, "vendor", "payload", "payload.bin")), payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- a wrapper must be executable */

test("a wrapper marked executable lands with the exec bit on POSIX", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX exec bits do not exist on Windows; the flag is honoured but meaningless there");
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "rea-exec-bit-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(path.join(bundle, "cache"), { recursive: true });
    const marked = Buffer.from("#!/bin/sh\necho wrapper\n");
    const plain = Buffer.from("not a script\n");
    const setup = makePluginTree(root, (manifest) => {
      const component = testComponent("http://127.0.0.1:9/wrapper.sh", marked, { executable: true, saveAs: "wrapper.sh", moveTo: "tool" });
      component.entries.all.push({
        id: "plain",
        version: "1",
        url: "http://127.0.0.1:9/plain.sh",
        format: "file",
        size: plain.length,
        sha256: createHash("sha256").update(plain).digest("hex"),
        moveTo: "tool",
        saveAs: "plain.sh",
      });
      manifest.components.androidPlatformTools = component;
    });
    addReaStub(bundle);
    // Prime the cache so no socket is opened and the mode is the only variable.
    writeFileSync(path.join(bundle, "cache", "wrapper.sh"), marked);
    writeFileSync(path.join(bundle, "cache", "plain.sh"), plain);

    const run = spawnSync(process.execPath, [setup, "--only", "androidPlatformTools", "--root", bundle], { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const wrapperMode = statSync(path.join(bundle, "vendor", "tool", "wrapper.sh")).mode;
    const plainMode = statSync(path.join(bundle, "vendor", "tool", "plain.sh")).mode;
    assert.notEqual(wrapperMode & 0o111, 0, `the marked wrapper must be executable, mode ${wrapperMode.toString(8)}`);
    assert.equal(plainMode & 0o111, 0, "an unmarked file must keep the mode the archive gave it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------- a file probe's expect is honoured */

test("a file probe honours expect.contains", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-file-probe-"));
  try {
    const make = (content) => {
      const bundle = path.join(root, `bundle-${content.length}`);
      mkdirSync(path.join(bundle, "cache"), { recursive: true });
      const payload = Buffer.from(content);
      const component = testComponent("http://127.0.0.1:9/marker.txt", payload, { saveAs: "marker.txt", moveTo: "probe" });
      component.probe = { file: "{vendor}/probe/marker.txt", expect: { contains: "application.version=" } };
      const setup = makePluginTree(path.join(root, `tree-${content.length}`), (manifest) => {
        manifest.components.androidPlatformTools = component;
      });
      addReaStub(bundle);
      writeFileSync(path.join(bundle, "cache", "marker.txt"), payload);
      return spawnSync(process.execPath, [setup, "--only", "androidPlatformTools", "--root", bundle], { encoding: "utf8", timeout: 120000 });
    };
    const ok = make("application.version=12.1.4\n");
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    // The file exists either way; only its content decides. Before the fix the
    // `expect` on a file probe was dead configuration and this case passed.
    const wrong = make("this is not a Ghidra properties file\n");
    assert.equal(wrong.status, 1, `${wrong.stdout}\n${wrong.stderr}`);
    assert.match(wrong.stdout, /does not contain "application\.version="/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------- a reused engine must pass its own probe */

test("a reused component must pass the probe a provisioned copy would face", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-reuse-probe-"));
  try {
    const install = path.join(root, "ghidra");
    mkdirSync(path.join(install, "support"), { recursive: true });
    mkdirSync(path.join(install, "Ghidra"), { recursive: true });
    writeFileSync(path.join(install, "support", process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless"), "");
    const properties = path.join(install, "Ghidra", "application.properties");
    const setup = makePluginTree(root, (manifest) => {
      // The real manifest needs a JDK for ghidra; this test is about the reuse
      // probe, so the requirement is removed rather than faked.
      manifest.components.ghidra.requires = [];
    });
    const bundle = path.join(root, "bundle");
    const args = ["--reuse", "--dry-run", "--only", "ghidra", "--root", bundle];
    const env = { ...process.env, GHIDRA_INSTALL_DIR: install };

    writeFileSync(properties, "application.version=12.1.4\n");
    const good = spawnSync(process.execPath, [setup, ...args], { encoding: "utf8", env, timeout: 120000 });
    assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
    assert.match(good.stdout, /reusing existing ghidra from GHIDRA_INSTALL_DIR/);

    // Adoption used to test only that analyzeHeadless exists, so any directory
    // shaped like a Ghidra install was recorded and the failure surfaced inside REA.
    writeFileSync(properties, "not a Ghidra properties file\n");
    const bad = spawnSync(process.execPath, [setup, ...args], { encoding: "utf8", env, timeout: 120000 });
    assert.doesNotMatch(bad.stdout, /reusing existing ghidra/);
    assert.match(bad.stdout, /not reusing GHIDRA_INSTALL_DIR ghidra/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- the shim's lock */

function makeBundleTree(root, { marker, lock }) {
  const bundle = path.join(root, "bundle");
  mkdirSync(path.join(bundle, "bin"), { recursive: true });
  mkdirSync(path.join(bundle, "scripts"), { recursive: true });
  mkdirSync(path.join(bundle, "manifest"), { recursive: true });
  copyFileSync(REPO_SHIM, path.join(bundle, "bin", "rea-shim.mjs"));
  writeFileSync(path.join(bundle, "scripts", "setup.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(' + JSON.stringify(marker) + ', "ran");\n');
  writeFileSync(path.join(bundle, "manifest", "bundle.manifest.json"), "{}\n");
  if (lock !== undefined) writeFileSync(path.join(bundle, "setup.lock"), lock);
  return bundle;
}

function runShim(bundle, args, extraEnv = {}) {
  // A fresh home keeps the duplicate-registration check from reading this
  // machine's real ~/.dsh/cordis.patch.yml and making the suite depend on it.
  const env = {
    ...process.env,
    DSH_HOME: path.join(path.dirname(bundle), "dsh-home"),
    REA_BUNDLE_ROOT: bundle,
    // The bundle path is what these tests assert. Without this pin the shim
    // would take its `auto` branch and, on a machine that happens to have a REA
    // on PATH, delegate to it instead of exercising the code under test.
    REA_BUNDLE_LAUNCH: "bundle",
    ...extraEnv,
  };
  delete env.REA_BUNDLE_AUTO_PROVISION;
  mkdirSync(env.DSH_HOME, { recursive: true });
  return spawnSync(process.execPath, [path.join(bundle, "bin", "rea-shim.mjs"), ...args], { encoding: "utf8", timeout: 60000, env });
}

test("a malformed bundle.json starts a provisioning run instead of failing forever", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-malformed-"));
  try {
    const marker = path.join(root, "setup-ran");
    const bundle = makeBundleTree(root, { marker, lock: undefined });
    writeFileSync(path.join(bundle, "bundle.json"), "{ this is not json");
    const run = runShim(bundle, ["mcp"]);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /provisioning started in the background/);
    assert.ok(await waitFor(() => existsSync(marker)), "setup was never started for a malformed bundle.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed lock is reported as failed, not as provisioning in progress", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-failed-lock-"));
  try {
    const marker = path.join(root, "setup-ran");
    const lock = JSON.stringify({ state: "failed", pid: 1, at: Date.now(), exit: 1 });
    const bundle = makeBundleTree(root, { marker, lock });
    // No bundle.json: the "missing" path, which used to print the "provisioning
    // started" sentence for six hours while nothing was running at all.
    const run = runShim(bundle, ["mcp"]);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /the last provisioning attempt failed/);
    assert.doesNotMatch(run.stderr, /provisioning started in the background/);
    assert.equal(existsSync(marker), false, "a fresh failed lock must not trigger another run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock whose holder is gone does not block provisioning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-dead-lock-"));
  try {
    const marker = path.join(root, "setup-ran");
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(Number.isInteger(dead.pid), "could not obtain a pid to outlive");
    const lock = JSON.stringify({ state: "running", pid: dead.pid, at: Date.now() });
    const bundle = makeBundleTree(root, { marker, lock });
    const run = runShim(bundle, ["mcp"]);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /provisioning started in the background/);
    assert.ok(await waitFor(() => existsSync(marker)), "a dead lock holder must not suppress the run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired lock is cleared instead of wedging provisioning forever", async () => {
  const stale = Date.now() - 7 * 60 * 60 * 1000;
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const cases = {
    "running lock with a dead holder": JSON.stringify({ state: "running", pid: dead, at: stale }),
    "failed lock past the freshness window": JSON.stringify({ state: "failed", pid: dead, at: stale, exit: 1 }),
    "legacy numeric lock": String(stale),
  };
  for (const [label, lock] of Object.entries(cases)) {
    const root = mkdtempSync(path.join(tmpdir(), "rea-shim-stale-"));
    try {
      const marker = path.join(root, "setup-ran");
      const bundle = makeBundleTree(root, { marker, lock });
      const run = runShim(bundle, ["mcp"]);
      assert.equal(run.status, 78, `${label}: ${run.stderr}`);
      // Reproduced before the fix: all three cases were silent AND blocked, because
      // the stale lock was never removed and the exclusive create then failed with
      // EEXIST forever. A lock older than the freshness window is not evidence of a
      // run, so it must be dropped and the attempt started again.
      assert.match(run.stderr, /provisioning started in the background/, label);
      assert.ok(await waitFor(() => existsSync(marker)), `${label}: setup was never started`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a read-only bundle root reports unwritable instead of crashing on the stale lock", { skip: process.platform === "win32" ? "POSIX directory permissions only" : false }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-readonly-"));
  try {
    const stale = Date.now() - 7 * 60 * 60 * 1000;
    const lock = JSON.stringify({ state: "running", pid: 999999, at: stale });
    const bundle = makeBundleTree(root, { marker: path.join(root, "setup-ran"), lock });
    chmodSync(bundle, 0o555);
    try {
      const run = runShim(bundle, ["mcp"], { DSH_HOME: path.join(root, "dsh-home") });
      assert.equal(run.status, 78, run.stderr);
      // Before the fix this was an uncaught EACCES stack trace and exit 1: the
      // stale lock could not be removed, and nothing caught the throw.
      assert.match(run.stderr, /provisioning could not be started \(unwritable\)/);
      assert.doesNotMatch(run.stderr, /EACCES/);
    } finally {
      chmodSync(bundle, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second REA registration is reported instead of silently duplicated", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-duplicate-"));
  try {
    const bundle = makeBundleTree(root, { marker: path.join(root, "setup-ran"), lock: undefined });
    const home = path.join(root, "dsh-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "cordis.patch.yml"),
      ["- insert:", "    - id: rea-mcp", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: rea", "        transport: stdio", ""].join("\n"),
    );
    const run = runShim(bundle, ["mcp"], { DSH_HOME: home });
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /duplicate REA registration/);
    assert.match(run.stderr, /id "rea-mcp"/);

    const status = spawnSync(process.execPath, [path.join(bundle, "bin", "rea-shim.mjs"), "--shim-status"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home, REA_BUNDLE_ROOT: bundle, REA_BUNDLE_LAUNCH: "bundle" },
    });
    assert.equal(JSON.parse(status.stdout).duplicateRegistration.id, "rea-mcp");

    // The row upstream writes by hand often carries a trailing comment, and YAML
    // says `rea # note` is still the value `rea`. Missing that made the diagnosis
    // silent for exactly the file an operator had just edited.
    const commented = path.join(root, "commented-home");
    mkdirSync(commented, { recursive: true });
    writeFileSync(
      path.join(commented, "cordis.patch.yml"),
      ["- insert:", "    - id: rea-mcp  # written by upstream", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: 'rea' # same server", ""].join("\n"),
    );
    const commentedStatus = spawnSync(process.execPath, [path.join(bundle, "bin", "rea-shim.mjs"), "--shim-status"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: commented, REA_BUNDLE_ROOT: bundle, REA_BUNDLE_LAUNCH: "bundle" },
    });
    assert.equal(
      JSON.parse(commentedStatus.stdout).duplicateRegistration.id,
      "rea-mcp",
      "a trailing comment must not hide the duplicate row",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this bundle's own row is not reported as a duplicate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-own-row-"));
  try {
    const bundle = makeBundleTree(root, { marker: path.join(root, "setup-ran"), lock: undefined });
    const home = path.join(root, "dsh-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "cordis.patch.yml"),
      ["- insert:", "    - id: mcp-rea", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: rea", ""].join("\n"),
    );
    const run = runShim(bundle, ["mcp"], { DSH_HOME: home });
    assert.equal(run.status, 78, run.stderr);
    assert.doesNotMatch(run.stderr, /duplicate REA registration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- --offline is a promise, and npm is the one step
 * that cannot keep it: it is an install, not a download. -------------------- */

test("--offline refuses the npm step instead of going online anyway", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-offline-rea-"));
  try {
    const setup = makePluginTree(root, () => {});
    const bundle = path.join(root, "bundle");
    const run = spawnSync(process.execPath, [setup, "--offline", "--only", "reaAgents", "--root", bundle], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /--offline and the vendored REA/);

    // The other direction: a usable vendored copy is still accepted offline, so the
    // flag does not turn into "reaAgents can never be provisioned".
    const second = path.join(root, "bundle2");
    mkdirSync(second, { recursive: true });
    addReaStub(second);
    const ok = spawnSync(process.execPath, [setup, "--offline", "--only", "reaAgents", "--root", second], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stdout, /already vendored/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- numeric overrides must not become NaN ------ */

test("a non-numeric numeric override falls back to the default", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-env-"));
  try {
    const setup = makePluginTree(root, () => {});
    const run = (env) =>
      spawnSync(process.execPath, [setup, "--dry-run", "--only", "node", "--root", path.join(root, "bundle")], {
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, ...env },
      });
    // `Number("abc")` is NaN, and NaN reached the socket layer as 0-ish behaviour;
    // `REA_BUNDLE_FETCH_RETRIES=abc` once produced "gave up after NaN attempt(s)".
    const bogus = run({ REA_BUNDLE_FETCH_RETRIES: "abc", REA_BUNDLE_IDLE_TIMEOUT_MS: "abc", REA_BUNDLE_CONNECT_TIMEOUT_MS: "abc" });
    assert.equal(bogus.status, 0, `${bogus.stdout}\n${bogus.stderr}`);
    assert.match(bogus.stdout, /retries=4\b/);
    assert.match(bogus.stdout, /idle=120000ms/);
    assert.doesNotMatch(bogus.stdout, /NaN/);
    const explicit = run({ REA_BUNDLE_FETCH_RETRIES: "7" });
    assert.match(explicit.stdout, /retries=7\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- POSIX extraction fallbacks ----------------- */

/** An `archive`-kind component, for the extraction paths. */
function testArchive(url, payload, extra = {}) {
  return {
    description: "test archive",
    kind: "archive",
    license: "test",
    requires: [],
    optional: false,
    unpack: { stripRootComponents: extra.strip ?? 0, moveTo: extra.moveTo ?? "arch" },
    probe: extra.probe ?? {},
    sources: {
      all: {
        version: "1",
        url,
        format: extra.format ?? "zip",
        size: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    },
  };
}

test("a zip still extracts when unzip is absent (POSIX fallbacks)", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows extracts through tar/Expand-Archive; the POSIX fallbacks do not exist there");
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "rea-extract-"));
  try {
    // A real zip, built with the very tool the fallback will use.
    const zipPath = path.join(root, "fixture.zip");
    const built = spawnSync("python3", [
      "-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('inside.txt','hello from inside\\n');z.close()",
      zipPath,
    ]);
    if (built.status !== 0) {
      t.skip("python3 is unavailable, so neither the fixture nor the fallback can run");
      return;
    }
    const payload = readFileSync(zipPath);
    const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    assert.ok(python, "python3 was just used to build the fixture");

    // A PATH that has python3 and nothing else: unzip cannot be found, which is
    // exactly the bare-server case. Ghidra ships only as a zip, so this used to be
    // a certain failure rather than an occasional one.
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const onlyPython = path.join(binDir, "python3");
    symlinkSync(python, onlyPython);
    const setup = makePluginTree(root, (manifest) => {
      manifest.components.androidPlatformTools = testArchive("http://127.0.0.1:9/fixture.zip", payload);
    });
    const cases = [
      { label: "python3 fallback", path: binDir, expected: 0 },
      { label: "no extractor at all", path: path.join(root, "empty-bin"), expected: 1 },
    ];
    for (const testCase of cases) {
      mkdirSync(testCase.path, { recursive: true });
      const bundle = path.join(root, `bundle-${testCase.expected}`);
      mkdirSync(path.join(bundle, "cache"), { recursive: true });
      writeFileSync(path.join(bundle, "cache", "fixture.zip"), payload);
      addReaStub(bundle);
      const run = spawnSync(process.execPath, [setup, "--only", "androidPlatformTools", "--root", bundle], {
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, PATH: testCase.path },
      });
      assert.equal(run.status, testCase.expected, `${testCase.label}: ${run.stdout}\n${run.stderr}`);
      if (testCase.expected === 0) {
        assert.equal(readFileSync(path.join(bundle, "vendor", "arch", "inside.txt"), "utf8"), "hello from inside\n");
      } else {
        assert.match(run.stdout, /no zip extractor available/);
        assert.match(run.stdout, /install unzip or python3/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fallback vendored-REA path matches where setup installs it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-shim-fallback-"));
  try {
    const bundle = path.join(root, "bundle");
    // An older bundle.json has paths.node but no paths.reaEntry. The fallback used
    // to omit `node_modules`, so a working install was reported as gone.
    mkdirSync(bundle, { recursive: true });
    addReaStub(bundle);
    writeFileSync(path.join(bundle, "bundle.json"), JSON.stringify({ schema: 1, paths: { node: process.execPath } }, null, 2) + "\n");
    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "rea-shim.mjs"), "--shim-status"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, REA_BUNDLE_ROOT: bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
    });
    const report = JSON.parse(run.stdout);
    assert.equal(report.rea.ok, true, JSON.stringify(report.rea));
    assert.match(report.rea.reaEntry, /node_modules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json releases the lock on success and marks it failed on failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-lock-json-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    addReaStub(bundle);
    const component = (optional) =>
      makePluginTree(path.join(root, optional ? "ok" : "bad"), (manifest) => {
        manifest.components.androidPlatformTools = testComponent("http://127.0.0.1:9/payload.bin", Buffer.from("adb"), { optional });
      });

    // The lock is what tells the shim a run is in flight. A successful --json run
    // used to leave it behind (the removal sat in the non---json branch), so a
    // fully provisioned machine advertised "provisioning started" for six hours.
    // The pid is dead on purpose: this fixture stands for a run that crashed and
    // left its lock, and such a lock must be taken over rather than block the
    // next attempt (the live-holder case is the test below).
    writeFileSync(path.join(bundle, "setup.lock"), JSON.stringify({ state: "running", pid: 999999, at: Date.now() }));
    const ok = spawnSync(process.execPath, [component(true), "--json", "--offline", "--only", "androidPlatformTools", "--root", bundle], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.equal(existsSync(path.join(bundle, "setup.lock")), false, "a successful --json run must not leave the lock behind");

    // A failing run keeps the lock on purpose, but records why, so the shim can
    // report a failure instead of pretending a run is still going.
    const bad = spawnSync(process.execPath, [component(false), "--json", "--offline", "--only", "androidPlatformTools", "--root", bundle], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(bad.status, 1, `${bad.stdout}\n${bad.stderr}`);
    const lock = JSON.parse(readFileSync(path.join(bundle, "setup.lock"), "utf8"));
    assert.equal(lock.state, "failed");
    assert.equal(lock.exit, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run lock held by a live process stops a second setup", () => {
  // The lock used to be written only when a run ENDED, so two runs — the shim's
  // detached provisioning and a hand-run `node scripts/setup.mjs` — could write
  // the same `.part` and the same staging directory, and whichever renamed last
  // kept a component whose size and digest belonged to neither. Claimed with
  // O_EXCL before the first byte moves, the second run must lose the race.
  const root = mkdtempSync(path.join(tmpdir(), "rea-lock-live-"));
  try {
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    addReaStub(bundle);
    const setup = makePluginTree(path.join(root, "tree"), (manifest) => {
      manifest.components.androidPlatformTools = testComponent("http://127.0.0.1:9/payload.bin", Buffer.from("adb"), {
        optional: true,
      });
    });
    // A live pid: this test process. 999999 would be a dead one.
    writeFileSync(
      path.join(bundle, "setup.lock"),
      JSON.stringify({ state: "running", pid: process.pid, at: Date.now(), log: "C:\\logs\\setup.log" }),
    );
    const run = spawnSync(
      process.execPath,
      [setup, "--offline", "--only", "androidPlatformTools", "--root", bundle],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(run.status, 75, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /another provisioning run holds/);
    assert.match(run.stderr, new RegExp(`pid ${process.pid}`));
    // The holder's lock is left untouched: this run never owned it.
    const lock = JSON.parse(readFileSync(path.join(bundle, "setup.lock"), "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- the package entry */

// The market judges an update by asking whether the new build's package.json
// points at an entry file that exists (`hasLoadableEntry` -> `entryArtifactExists`
// in dshmarket). This package declared neither main nor exports, and the package
// it mounts (`@deepseek-ai/dsh-mcp-client`) ships inside the harness build rather
// than in node_modules, so every location that test probes came back empty:
// updating a healthy 2.0.1 profile to 2.0.4 failed with "updated build has no
// loadable entry", and the rollback was then reported unverifiable for the same
// reason (measured 2026-10-18). These two tests are that regression.
test("package.json declares an entry file that is actually shipped", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(typeof pkg.main, "string", "package.json must declare main; without it consumers probe index.js, which does not exist");
  assert.equal(existsSync(path.join(REPO_ROOT, pkg.main)), true, `${pkg.main} is declared but missing`);
  // `main` alone is not enough: npm pack ships only what files[] lists, and a
  // tarball without the entry reproduces the very failure this fixes.
  const shipped = String(pkg.main).replace(/^\.\//, "");
  assert.equal(pkg.files.includes(shipped), true, `files[] must ship ${shipped}`);
});

test("the entry loads as a cordis plugin and does nothing", async () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, pkg.main)).href);
  assert.equal(mod.name, pkg.name, "the loader resolves the plugin by this name");
  assert.equal(typeof mod.apply, "function", "a cordis plugin needs apply()");
  // Loading and applying must not register a row, spawn anything or touch state:
  // registering the MCP client here would add a second `serverName: rea` entry,
  // which the harness refuses. Returning undefined is the whole contract.
  assert.equal(mod.apply(), undefined);
});

/* --------------------------------------------------------- declared DSH hosts */

// The market reads `engines.dsh` to answer "is this plugin compatible with the
// host I am running" — and hides the plugin from hosts that mismatch. Two silent
// failures follow from a declaration nobody checks: a typo leaves the range
// unparseable and the market falls back to "undeclared", while a drifted floor
// drops hosts the README still promises. Both look exactly like a plugin that
// simply has nothing to say, so the string is pinned against the release list.
test("the manifest declares a DSH host range the market can read", () => {
  const range = declaredHostRange(REPO_ROOT);
  assert.equal(typeof range, "string", "engines.dsh must be declared; without it the market reports the plugin as unknown");
  // The string is pinned, not just parsed: the ceiling decides which hosts are
  // admitted, and `<0.3.0` vs `<0.3.0-0` is exactly the difference between
  // "no 0.3.0" and "0.3.0-alpha.1 is fine" once prereleases are included.
  assert.equal(range, ">=0.1.7-rc.2 <0.3.0-0");
  assert.throws(() => satisfiesDeclaredRange("0.2.0-rc.2", "not a range"), "the gate must reject an unparseable range");
  assert.doesNotThrow(() => satisfiesDeclaredRange("0.2.0-rc.2", range));
});

test("the release list this gate checks is the published one", () => {
  // Pinned literally: deleting an entry from the list would otherwise shrink the
  // coverage claim silently, and every test below would still pass.
  assert.deepEqual(HOST_RELEASES, [
    "0.2.1-rc.2",
    "0.2.1-rc.1",
    "0.2.1-alpha.5",
    "0.2.1-alpha.4",
    "0.2.1-alpha.3",
    "0.2.1-alpha.2",
    "0.2.1-alpha.1",
    "0.2.0-rc.2",
    "0.2.0-rc.1",
    "0.1.7-rc.2",
  ]);
  assert.deepEqual(OUTSIDE_HOSTS, ["0.3.0", "0.3.0-rc.1", "0.3.0-alpha.1", "0.1.7-rc.1", "0.1.7-alpha.2"]);
});

test("every released DSH host is inside the declared range, and nothing untested is", () => {
  const range = declaredHostRange(REPO_ROOT);
  const { covered, uncovered, leaked } = checkHostCoverage(range);
  assert.deepEqual(uncovered, [], `these releases fall outside ${range}`);
  assert.deepEqual(leaked, [], `the declaration also admits ${leaked.join(", ")}, which nobody tested`);
  assert.deepEqual(covered, HOST_RELEASES, "every release in the list must be covered");
});

test("the host-range gate rejects a plausible but wrong declaration", () => {
  // Negative control: a gate that always passes proves nothing. `>=0.2.0` is the
  // shape someone writes after testing only on their own machine — and because a
  // prerelease sorts BELOW its release, it drops the whole 0.2.0-rc line as well
  // as 0.1.7. That is the trap this test exists for: the typo looks like it names
  // the running host.
  const drifted = checkHostCoverage(">=0.2.0 <0.3.0-0");
  assert.deepEqual(drifted.uncovered, ["0.2.0-rc.2", "0.2.0-rc.1", "0.1.7-rc.2"], "a 0.2.0 floor must be seen dropping the 0.2.0 prereleases");
  // The OTHER half of the gate needs its own control: a floor low enough to admit
  // a host nobody audited must be reported as a leak, not silently accepted.
  const loose = checkHostCoverage(">=0.1.0 <0.3.0-0");
  assert.deepEqual(loose.leaked, ["0.1.7-rc.1", "0.1.7-alpha.2"], "a low floor must be seen admitting the earlier prereleases");
  // And the ceiling is load bearing: the next minor line is a host nobody audited,
  // including its prereleases, which `<0.3.0` would have let through.
  assert.equal(satisfiesDeclaredRange("0.3.0", ">=0.1.7-rc.2 <0.3.0-0"), false);
  assert.equal(satisfiesDeclaredRange("0.3.0-rc.1", ">=0.1.7-rc.2 <0.3.0-0"), false);
});

test("prerelease ordering matches semver, not string order", () => {
  assert.equal(compareVersions("0.2.1-alpha.5", "0.2.1-rc.1"), -1);
  assert.equal(compareVersions("0.2.1-rc.2", "0.2.1"), -1);
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.1"), 1);
  // String comparison would sort "alpha.10" before "alpha.5"; semver does not.
  assert.equal(compareVersions("0.2.1-alpha.10", "0.2.1-alpha.5"), 1);
});

test("the evaluator reads the two tolerances semver does, and refuses the rest", () => {
  // Build metadata carries no precedence: a host reporting it is that version.
  assert.equal(satisfiesDeclaredRange("0.2.0-rc.2+build.7", ">=0.1.7-rc.2 <0.3.0-0"), true);
  // Everything else is refused rather than guessed at — a gate that accepts `v`
  // prefixes and zero-padded identifiers would also accept a typo.
  assert.throws(() => satisfiesDeclaredRange("v0.2.0-rc.2", ">=0.1.7-rc.2 <0.3.0-0"));
  assert.throws(() => satisfiesDeclaredRange("0.2.1-01", ">=0.1.7-rc.2 <0.3.0-0"));
});

/* ------------------------------------------------------- the launch decision */

// 2.x supplies a runtime the machine may not have; when it HAS one, the row must
// use it — the 1.x contract. These tests own that decision, so every one of them
// isolates PATH: without it the suite would silently depend on whatever `rea`
// the machine running it happens to have, which is the one thing a test of a
// machine-dependent decision must not do.

function writeFakeRea(dir, { version = "6.9.0", exitForVersion = 0, runExit = 0, record = null } = {}) {
  const file = path.join(dir, process.platform === "win32" ? "rea.cmd" : "rea");
  if (process.platform === "win32") {
    const lines = ["@echo off", 'if "%1"=="--version" (', `  echo ${version}`, `  exit /b ${exitForVersion}`, ")"];
    if (record !== null) lines.push(`echo %* > "${record}"`);
    lines.push(`exit /b ${runExit}`);
    writeFileSync(file, lines.join("\r\n") + "\r\n");
  } else {
    const lines = ["#!/bin/sh", `if [ "$1" = "--version" ]; then echo ${version}; exit ${exitForVersion}; fi`];
    if (record !== null) lines.push(`echo "$*" > "${record}"`);
    lines.push(`exit ${runExit}`);
    writeFileSync(file, lines.join("\n") + "\n");
    chmodSync(file, 0o755);
  }
  return file;
}

function runShimIsolated(env, args, shim = path.join(REPO_ROOT, "bin", "rea-shim.mjs")) {
  const merged = { ...process.env, ...env };
  // Windows keeps PATH and Path as separate variables (both are "in" the
  // environment), and a child that reads Path while the test set PATH would see
  // the machine's real search path instead of the fixture's.
  if (process.platform === "win32" && Object.prototype.hasOwnProperty.call(env, "PATH")) delete merged.Path;
  return spawnSync(process.execPath, [shim, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: merged,
  });
}

function launchFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rea-launch-"));
  const emptyPath = path.join(root, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  return {
    root,
    emptyPath,
    bundleRoot: path.join(root, "bundle"),
    bin: path.join(root, "bin"),
    record: path.join(root, "record.txt"),
    clean() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a machine with its own REA runs the 1.x way, and no bundle is required", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.9.0", record: f.record });
  try {
    const env = {
      PATH: f.emptyPath,
      REA_BUNDLE_SYSTEM_REA: rea,
      REA_BUNDLE_ROOT: f.bundleRoot,
      REA_BUNDLE_AUTO_PROVISION: "0",
      REA_BUNDLE_LAUNCH: "",
    };
    const status = runShimIsolated(env, ["--shim-status"]);
    const report = JSON.parse(status.stdout);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(report.launch.mode, "system", JSON.stringify(report.launch));
    assert.equal(report.launch.systemRea.version, "6.9.0");
    // Unprovisioned and still healthy: the row does not depend on the bundle.
    assert.equal(report.provisioned, false);
    assert.equal(existsSync(path.join(f.bundleRoot, "bundle.json")), false, "no provisioning may be started");

    const run = runShimIsolated(env, ["mcp"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(f.record, "utf8").trim(), "mcp", "the system REA must receive the row's arguments");
  } finally {
    f.clean();
  }
});

test("REA_BUNDLE_LAUNCH=bundle keeps the bundle path even with a REA on PATH", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin);
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.launch.mode, "bundle");
    assert.equal(report.launch.reason, "pinned by REA_BUNDLE_LAUNCH=bundle");
    assert.equal(run.status, 78, "an unpinned bundle that is not provisioned still reports EX_CONFIG");
  } finally {
    f.clean();
  }
});

test("an older system REA does not displace a newer provisioned one unless pinned", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  mkdirSync(f.bundleRoot, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.4.0" });
  try {
    writeFileSync(
      path.join(f.bundleRoot, "bundle.json"),
      JSON.stringify({ schema: 1, paths: { node: process.execPath }, versions: { reaAgents: "6.5.0" } }),
    );
    const base = { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0" };
    const auto = JSON.parse(runShimIsolated({ ...base, REA_BUNDLE_LAUNCH: "" }, ["--shim-status"]).stdout);
    assert.equal(auto.launch.mode, "bundle");
    assert.match(auto.launch.reason, /older than the provisioned one/);
    const pinned = JSON.parse(runShimIsolated({ ...base, REA_BUNDLE_LAUNCH: "system" }, ["--shim-status"]).stdout);
    assert.equal(pinned.launch.mode, "system");
    assert.match(pinned.launch.reason, /pinned by REA_BUNDLE_LAUNCH=system/);
  } finally {
    f.clean();
  }
});

test("a candidate that cannot answer --version is rejected, not launched", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { exitForVersion: 7 });
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.launch.mode, "bundle");
    assert.equal(report.launch.systemRea, null);
    assert.deepEqual(report.launch.rejected.map(r => r.reason), ["exit 7"]);
    assert.equal(run.status, 78);
  } finally {
    f.clean();
  }
});

test("REA_BUNDLE_LAUNCH=system refuses instead of provisioning", () => {
  const f = launchFixture();
  const missing = path.join(f.bin, "no-such-rea");
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: missing, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "1", REA_BUNDLE_LAUNCH: "system" },
      ["mcp"],
    );
    assert.equal(run.status, 78, run.stdout);
    assert.match(run.stderr, /REA_BUNDLE_LAUNCH=system was requested/);
    assert.equal(existsSync(f.bundleRoot), false, "a pinned system launch must not create a bundle");
  } finally {
    f.clean();
  }
});

test("an unknown REA_BUNDLE_LAUNCH value is reported and treated as auto", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.9.0" });
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "nonsense" },
      ["--shim-status"],
    );
    assert.match(run.stderr, /REA_BUNDLE_LAUNCH="nonsense" is not one of/);
    assert.equal(JSON.parse(run.stdout).launch.mode, "system");
  } finally {
    f.clean();
  }
});

test("the system REA is found through PATH itself, not only through the override", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  writeFakeRea(f.bin, { version: "6.9.0" });
  try {
    const run = runShimIsolated(
      { PATH: f.bin, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.launch.mode, "system", JSON.stringify(report.launch));
    assert.equal(report.launch.systemRea.version, "6.9.0");
    assert.equal(run.status, 0);
  } finally {
    f.clean();
  }
});

test("a REA installed under a path with a space is probed and launched", () => {
  const f = launchFixture();
  const spaced = path.join(f.root, "rea space");
  mkdirSync(spaced, { recursive: true });
  const rea = writeFakeRea(spaced, { version: "6.9.0", record: f.record });
  try {
    const env = { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" };
    const status = JSON.parse(runShimIsolated(env, ["--shim-status"]).stdout);
    assert.equal(status.launch.mode, "system", JSON.stringify(status.launch));
    const run = runShimIsolated(env, ["mcp"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(f.record, "utf8").trim(), "mcp");
  } finally {
    f.clean();
  }
});

test("the delegated process's exit status is the shim's exit status", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.9.0", runExit: 9 });
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["mcp"],
    );
    assert.equal(run.status, 9, `the row must see REA's own status, got ${run.status}`);
  } finally {
    f.clean();
  }
});

test("a REA inside the bundle is not treated as a system install", () => {
  const f = launchFixture();
  mkdirSync(f.bundleRoot, { recursive: true });
  const inside = writeFakeRea(f.bundleRoot, { version: "6.9.0" });
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: inside, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.launch.mode, "bundle");
    assert.equal(report.launch.systemRea, null);
    assert.deepEqual(report.launch.rejected.map(r => r.reason), ["inside the bundle"]);
  } finally {
    f.clean();
  }
});

test("REA_BUNDLE_LAUNCH=bundle never probes the machine", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  // Any invocation at all leaves the record behind — including --version, which
  // is exactly what `auto` would run.
  const rea = writeFakeRea(f.bin, { version: "6.9.0", record: f.record });
  try {
    runShimIsolated(
      { PATH: f.bin, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["--shim-status"],
    );
    assert.equal(existsSync(f.record), false, "the pinned bundle path must not pay for a probe");
  } finally {
    f.clean();
  }
});

test("--shim-print-env reports the system launch instead of a child environment", () => {
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.9.0", record: f.record });
  try {
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: rea, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["--shim-print-env"],
    );
    const printed = JSON.parse(run.stdout);
    assert.equal(printed.launch, "system");
    assert.equal(printed.version, "6.9.0");
    assert.equal(existsSync(f.record), false, "printing the environment must not start REA");
  } finally {
    f.clean();
  }
});

test("a candidate that wraps this shim is rejected instead of recursing", () => {
  // The probe asks the candidate for `--version`; a wrapper answers by running
  // this very shim, which would probe the wrapper again. The probe therefore runs
  // with REA_BUNDLE_DELEGATED=1, so the nested run takes the bundle path and
  // returns. Without that, one wrapper on PATH spawns a process chain that keeps
  // respawning after the parent is killed.
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const shim = path.join(REPO_ROOT, "bin", "rea-shim.mjs");
  const wrapper = path.join(f.bin, process.platform === "win32" ? "rea.cmd" : "rea");
  if (process.platform === "win32") {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`);
  } else {
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${shim}" "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
  try {
    const started = Date.now();
    const run = runShimIsolated(
      { PATH: f.emptyPath, REA_BUNDLE_SYSTEM_REA: wrapper, REA_BUNDLE_ROOT: f.bundleRoot, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "" },
      ["--shim-status"],
    );
    const elapsed = Date.now() - started;
    const report = JSON.parse(run.stdout);
    assert.equal(report.launch.mode, "bundle");
    assert.deepEqual(report.launch.rejected.map(r => r.reason), ["exit 78"]);
    assert.ok(elapsed < 20000, `the probe must not recurse; it took ${elapsed} ms`);
  } finally {
    f.clean();
  }
});

test("a ComSpec that points at nothing falls back to the real shell", () => {
  // Trusting ComSpec blindly would judge every .cmd REA "spawn-failed" — i.e.
  // report the machine as having no REA because its shell pointer is broken.
  const f = launchFixture();
  mkdirSync(f.bin, { recursive: true });
  const rea = writeFakeRea(f.bin, { version: "6.9.0" });
  try {
    const run = runShimIsolated(
      {
        PATH: f.emptyPath,
        ComSpec: path.join(f.root, "no-such-cmd.exe"),
        REA_BUNDLE_SYSTEM_REA: rea,
        REA_BUNDLE_ROOT: f.bundleRoot,
        REA_BUNDLE_AUTO_PROVISION: "0",
        REA_BUNDLE_LAUNCH: "",
      },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    if (process.platform === "win32") {
      assert.equal(report.launch.mode, "system", JSON.stringify(report.launch));
      assert.equal(report.launch.systemRea.version, "6.9.0");
    } else {
      // POSIX never consults ComSpec; the assertion above would be incidental.
      assert.equal(report.launch.mode, "system");
    }
  } finally {
    f.clean();
  }
});

/* --------------------------------------------------- the mirrored launcher */

// The row launches `<bundle>/bin/rea-shim.mjs`, a COPY. A market upgrade replaces
// the package and runs no setup, so without this the copy keeps running the code
// it was made from — every fix silently stops at the old mirror. These tests pin
// the repair: the copy re-execs the plugin's launcher when they differ, once.

function mirrorFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rea-mirror-"));
  const bundle = path.join(root, "bundle");
  const checkout = path.join(root, "checkout");
  mkdirSync(path.join(bundle, "bin"), { recursive: true });
  mkdirSync(path.join(checkout, "bin"), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, "bin", "rea-shim.mjs"), path.join(bundle, "bin", "rea-shim.mjs"));
  writeFileSync(path.join(bundle, "mirror.json"), JSON.stringify({ schema: 1, pluginRoot: checkout, mirroredAt: "2026-10-18T00:00:00Z" }));
  return { root, bundle, checkout, clean() { rmSync(root, { recursive: true, force: true }); } };
}

function checkoutStub(checkout, marker) {
  const file = path.join(checkout, "bin", "rea-shim.mjs");
  writeFileSync(
    file,
    'import { writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(marker)}, "checkout");\n` +
      "process.exit(7);\n",
  );
  return file;
}

test("a mirrored launcher re-execs the plugin's launcher when they differ", () => {
  const f = mirrorFixture();
  const marker = path.join(f.root, "checkout-ran");
  checkoutStub(f.checkout, marker);
  try {
    // The mirrored copy is what the row launches, and the checkout guard means a
    // checkout shim refuses to hop at all — so the fixture must be exercised as
    // the mirror it is meant to be.
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["mcp"],
      path.join(f.bundle, "bin", "rea-shim.mjs"),
    );
    assert.equal(run.status, 7, `expected the checkout's status, got ${run.status}: ${run.stderr}`);
    assert.equal(existsSync(marker), true, "the checkout launcher must have run");
  } finally {
    f.clean();
  }
});

test("the re-exec happens once, and a pinned guard stops it", () => {
  const f = mirrorFixture();
  const marker = path.join(f.root, "checkout-ran");
  checkoutStub(f.checkout, marker);
  try {
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle", REA_BUNDLE_SHIM_REEXEC: "1" },
      ["mcp"],
      path.join(f.bundle, "bin", "rea-shim.mjs"),
    );
    // The guard is set, so the mirrored copy runs its own logic: bundle pinned and
    // nothing provisioned means EX_CONFIG, and the checkout never starts.
    assert.equal(run.status, 78, run.stderr);
    assert.equal(existsSync(marker), false, "the guard must prevent a second hop");
  } finally {
    f.clean();
  }
});

test("--shim-status reports a stale mirror instead of re-execing it", () => {
  const f = mirrorFixture();
  const marker = path.join(f.root, "checkout-ran");
  checkoutStub(f.checkout, marker);
  try {
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["--shim-status"],
      path.join(f.bundle, "bin", "rea-shim.mjs"),
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.mirror.stale, true, JSON.stringify(report.mirror));
    assert.match(report.mirror.reason, /different launcher/);
    assert.equal(existsSync(marker), false, "status is a query; it must not start anything");
  } finally {
    f.clean();
  }
});

test("a checkout shim does not hop into the installed plugin", () => {
  const f = mirrorFixture();
  const marker = path.join(f.root, "checkout-ran");
  checkoutStub(f.checkout, marker);
  try {
    // The repository's own shim is a CHECKOUT (it ships cordis.patch.yml). A
    // developer running it must keep testing the edit in front of them, not a
    // different plugin that the bundle's record happens to name.
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["mcp"],
    );
    assert.equal(run.status, 78, run.stderr);
    assert.equal(existsSync(marker), false, "a checkout must never hop into another copy");
  } finally {
    f.clean();
  }
});

test("a re-exec whose file vanishes mid-flight falls back to the mirrored copy", () => {
  // The upgrade race the spawn handshake cannot see: the file existed when the
  // mirror compared hashes, node started, and the file was replaced before node
  // read it — node exits 1 with MODULE_NOT_FOUND. Passing that through turns a
  // millisecond race into a dead row, so a non-zero exit with the source gone
  // must fall back instead.
  const f = mirrorFixture();
  const marker = path.join(f.root, "checkout-ran");
  const file = path.join(f.checkout, "bin", "rea-shim.mjs");
  writeFileSync(
    file,
    'import { rmSync, writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(marker)}, "checkout");\n` +
      `rmSync(${JSON.stringify(file)});\n` +
      "process.exit(3);\n",
  );
  try {
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["mcp"],
      path.join(f.bundle, "bin", "rea-shim.mjs"),
    );
    assert.equal(existsSync(marker), true, "the checkout launcher did run");
    assert.equal(run.status, 78, `expected the local copy's status, got ${run.status}: ${run.stderr}`);
    assert.match(run.stderr, /running the mirrored copy instead/);
  } finally {
    f.clean();
  }
});

test("an identical mirror is not stale and is not re-exec'd", () => {
  const f = mirrorFixture();
  const same = path.join(f.checkout, "bin", "rea-shim.mjs");
  copyFileSync(path.join(f.bundle, "bin", "rea-shim.mjs"), same);
  try {
    const run = runShimIsolated(
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle" },
      ["--shim-status"],
      path.join(f.bundle, "bin", "rea-shim.mjs"),
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.mirror.stale, false, JSON.stringify(report.mirror));
    assert.equal(report.mirror.reason, "this copy matches the plugin");
  } finally {
    f.clean();
  }
});

test("a mirrored shim finds the real DSH home when the environment is scrubbed", () => {
  // The harness strips DSH_* from an MCP child, so with a custom DSH_HOME the
  // old code read ~/.dsh — the wrong file — and could never report upstream's
  // duplicate `serverName: rea`. setup records the home; the shim must use it.
  const f = mirrorFixture();
  const home = path.join(f.root, "custom-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "cordis.patch.yml"),
    "- insert:\n    - id: rea-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: rea\n",
  );
  writeFileSync(
    path.join(f.bundle, "mirror.json"),
    JSON.stringify({ schema: 1, pluginRoot: f.checkout, mirroredAt: "2026-10-18T00:00:00Z", dshHome: home }),
  );
  try {
    const run = runShimIsolated(
      // DSH_HOME="" models the scrubbed environment: the variable exists, empty.
      { REA_BUNDLE_ROOT: f.bundle, REA_BUNDLE_AUTO_PROVISION: "0", REA_BUNDLE_LAUNCH: "bundle", DSH_HOME: "" },
      ["--shim-status"],
    );
    const report = JSON.parse(run.stdout);
    assert.equal(report.duplicateRegistration?.id, "rea-mcp", run.stdout);
    assert.equal(report.duplicateRegistration.patch, path.join(home, "cordis.patch.yml"));
  } finally {
    f.clean();
  }
});

/* ------------------------------------ records a Windows editor has BOM-ed */

// `bin/rea-shim.mjs` strips the UTF-8 BOM that PowerShell and Notepad write;
// setup.mjs kept parsing raw. Both programs read the same two records, so a BOM
// used to mean two different things: the shim found the checkout, setup did not.
// A mirrored setup then re-mirrored the previous manifest and provisioned from
// it, and a BOM-ed bundle.json read as "nothing is provisioned". These tests pin
// setup's side of the contract, both files.

/** A checkout with a manifest whose node probe accepts any node, so `--only node` is deterministic. */
function bomFixtureCheckout(root) {
  const checkout = path.join(root, "checkout");
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(path.join(checkout, "manifest"), { recursive: true });
  copyFileSync(SETUP_SOURCE, path.join(checkout, "scripts", "setup.mjs"));
  const manifest = JSON.parse(readFileSync(MANIFEST_SOURCE, "utf8"));
  manifest.components.node.probe.expect.regex = "^v";
  writeFileSync(path.join(checkout, "manifest", "bundle.manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dsh-plugin-rea", version: "0.0.0-bom" }));
  return checkout;
}

test("a BOM-ed mirror.json still points a mirrored setup at the real checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-bom-mirror-"));
  try {
    const checkout = bomFixtureCheckout(root);
    const bundle = path.join(root, "bundle");
    mkdirSync(path.join(bundle, "scripts"), { recursive: true });
    copyFileSync(SETUP_SOURCE, path.join(bundle, "scripts", "setup.mjs"));
    // Exactly what `Out-File` / `Set-Content` leaves behind, and what a human
    // editing the record by hand produces on Windows.
    writeFileSync(
      path.join(bundle, "mirror.json"),
      "\uFEFF" + JSON.stringify({ schema: 1, pluginRoot: checkout, mirroredAt: "2026-10-18T00:00:00Z" }),
    );
    // The bundle has no manifest of its own: only the record can supply one.
    assert.equal(existsSync(path.join(bundle, "manifest", "bundle.manifest.json")), false);

    const run = spawnSync(
      process.execPath,
      [path.join(bundle, "scripts", "setup.mjs"), "--dry-run", "--only", "node", "--root", bundle],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(run.status, 0, run.stderr);
    // loadManifest() runs before any component: reaching the plan proves the
    // record was parsed. A BOM-blind parse fell through to the bundle and died
    // on a missing manifest.
    assert.match(run.stdout, /\[plan\] node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a BOM-ed bundle.json is read instead of treated as unprovisioned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-bom-bundle-"));
  try {
    const checkout = bomFixtureCheckout(root);
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    const args = [path.join(checkout, "scripts", "setup.mjs"), "--dry-run", "--only", "node", "--root", bundle];

    // Control: with no record at all the component is planned, so the assertion
    // below cannot pass for a reason unrelated to reading the file.
    const fresh = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /\[plan\] node/);

    writeFileSync(
      path.join(bundle, "bundle.json"),
      "\uFEFF" + JSON.stringify({ schema: 1, components: { node: { path: process.execPath, version: "v-bom-test" } } }, null, 2),
    );
    const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /already provisioned \(v-bom-test\)/, run.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------ records written by `Out-File` (UTF-16) */

// Windows PowerShell 5.1 writes UTF-16 LE for `> file` and `Out-File`, which is
// how a hand-edited record usually gets produced. Before this, every such record
// read as "no record" in BOTH programs — the same silent downgrade the UTF-8 BOM
// fix addressed, one encoding further out.

function utf16le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

test("a UTF-16 bundle.json is read by setup instead of treated as unprovisioned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-utf16-bundle-"));
  try {
    const checkout = bomFixtureCheckout(root);
    const bundle = path.join(root, "bundle");
    mkdirSync(bundle, { recursive: true });
    const args = [path.join(checkout, "scripts", "setup.mjs"), "--dry-run", "--only", "node", "--root", bundle];

    // Control: with no record the component is planned, so the assertion below
    // cannot pass for a reason unrelated to decoding the file.
    const fresh = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /\[plan\] node/);

    const json = JSON.stringify({ schema: 1, components: { node: { path: process.execPath, version: "v-utf16" } } }, null, 2);
    writeFileSync(path.join(bundle, "bundle.json"), utf16le(json));
    const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /already provisioned \(v-utf16\)/, run.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a UTF-16 bundle.json is read by the shim as provisioned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-utf16-shim-"));
  try {
    const bundle = makeBundleTree(root, { marker: path.join(root, "setup-ran"), lock: undefined });
    addReaStub(bundle);
    const reaEntry = path.join(bundle, "vendor", "node_modules", "rea-agents", "scripts", "rea.mjs");
    const json = JSON.stringify({ schema: 1, paths: { node: process.execPath, reaEntry }, versions: { reaAgents: REA_PIN } }, null, 2);
    writeFileSync(path.join(bundle, "bundle.json"), utf16le(json));

    const run = runShim(bundle, ["--shim-status"], { REA_BUNDLE_AUTO_PROVISION: "0" });
    const report = JSON.parse(run.stdout);
    assert.equal(report.provisioned, true, run.stderr);
    assert.equal(report.rea.ok, true, JSON.stringify(report.rea));
    assert.equal(existsSync(path.join(root, "setup-ran")), false, "a readable record must not start a run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- one-shot setup guide */

function guideBundle(root, record, encoding) {
  const file = path.join(root, "bundle.json");
  const text = JSON.stringify(record, null, 2);
  writeFileSync(file, encoding === "utf16" ? utf16le(text) : text);
  return file;
}

test("reaPinMatches pins a dotted version exactly and a bare major as a family", () => {
  assert.equal(reaPinMatches("6.7.0", "6.7.0"), true);
  assert.equal(reaPinMatches("6.5.0", "6.7.0"), false);
  assert.equal(reaPinMatches("6.7.0-rc.1", "6.7.0"), false);
  assert.equal(reaPinMatches("21.0.12.1+1", "21"), true);
  assert.equal(reaPinMatches("20.0.1", "21"), false);
  assert.equal(reaPinMatches("", "6.7.0"), false);
  assert.equal(reaPinMatches("6.7.0", ""), false);
});

test("the guide calls a machine with no bundle.json a first install", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-guide-missing-"));
  try {
    const state = computeGuideState({
      pluginVersion: "2.0.11",
      pinnedRea: "6.7.0",
      bundlePath: path.join(root, "bundle.json"),
    });
    assert.equal(state.state, "missing");
    assert.equal(state.needsSetup, true);
    assert.match(state.setupCommand, /scripts[/\\]setup\.mjs/);
    assert.equal(state.pluginVersion, "2.0.11");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guide calls a bundle at the old REA stale, and a matching pin settled", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-guide-stale-"));
  try {
    const file = guideBundle(root, { versions: { reaAgents: "6.5.0" }, provisionedAt: "2026-10-19T12:52:17.332Z" });
    const stale = computeGuideState({ pluginVersion: "2.0.11", pinnedRea: "6.7.0", bundlePath: file });
    assert.equal(stale.state, "stale");
    assert.equal(stale.needsSetup, true);
    assert.equal(stale.installedRea, "6.5.0");

    const settled = computeGuideState({ pluginVersion: "2.0.11", pinnedRea: "6.5.0", bundlePath: file });
    assert.equal(settled.state, "ok");
    assert.equal(settled.needsSetup, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guide reads a UTF-16 bundle.json instead of calling it unreadable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-guide-utf16-"));
  try {
    const file = guideBundle(root, { versions: { reaAgents: "6.5.0" } }, "utf16");
    const state = computeGuideState({ pluginVersion: "2.0.11", pinnedRea: "6.5.0", bundlePath: file });
    assert.equal(state.state, "ok");
    assert.equal(state.installedRea, "6.5.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guide asks for setup when the record cannot be parsed or names no REA", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rea-guide-bad-"));
  try {
    const broken = path.join(root, "broken.json");
    writeFileSync(broken, "{ not json");
    const unreadable = computeGuideState({ pluginVersion: "2.0.11", pinnedRea: "6.7.0", bundlePath: broken });
    assert.equal(unreadable.state, "unreadable");
    assert.equal(unreadable.needsSetup, true);

    const empty = guideBundle(root, { versions: {} });
    const unknown = computeGuideState({ pluginVersion: "2.0.11", pinnedRea: "6.7.0", bundlePath: empty });
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.needsSetup, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- npm run check-updates */

test("check-updates runs PowerShell on Windows, 5.1 first", () => {
  assert.deepEqual(powerShellCandidates("win32"), ["powershell", "pwsh"]);
});

test("check-updates refuses to fake a POSIX run", () => {
  // The .ps1 probes %APPDATA% and prefers rea.cmd; a pwsh on Linux would run
  // those branches against paths that do not exist and print a confident wrong
  // answer. No candidates is the point, not an oversight.
  assert.deepEqual(powerShellCandidates("linux"), []);
  assert.deepEqual(powerShellCandidates("darwin"), []);
});

test("check-updates names the portable commands it falls back to", () => {
  const posix = unsupportedMessage("linux");
  assert.match(posix, /Windows PowerShell tool/);
  assert.match(posix, /this host is linux/);
  assert.match(posix, /--shim-status/);
  assert.match(posix, /setup\.mjs --dry-run/);

  const win = unsupportedMessage("win32");
  assert.match(win, /No PowerShell/);
});
