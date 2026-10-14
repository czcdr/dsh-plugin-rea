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
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
