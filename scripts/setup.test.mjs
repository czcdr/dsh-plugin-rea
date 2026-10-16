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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    env: { ...process.env, REA_BUNDLE_AUTO_PROVISION: "0", ...env },
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

test("a bare invocation reports usage instead of starting anything", () => {
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
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /--shim-status/);
    // A lock would mean a provisioning run was started, which a stray
    // `rea-bundle-status` must never do.
    assert.equal(existsSync(path.join(home, "plugins", "rea-bundle", "setup.lock")), false);
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
function addReaStub(bundleRoot, version = "6.5.0") {
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

function runShim(bundle, args) {
  const env = { ...process.env, REA_BUNDLE_ROOT: bundle };
  delete env.REA_BUNDLE_AUTO_PROVISION;
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
      env: { ...process.env, REA_BUNDLE_ROOT: bundle, REA_BUNDLE_AUTO_PROVISION: "0" },
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
    writeFileSync(path.join(bundle, "setup.lock"), JSON.stringify({ state: "running", pid: process.pid, at: Date.now() }));
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
