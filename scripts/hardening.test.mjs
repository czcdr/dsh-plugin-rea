#!/usr/bin/env node
/**
 * Regression tests for the "script consistency / state integrity" fixes.
 *
 * Three defects, one theme: a tool that answers for a *different* machine state
 * than the one in front of it.
 *
 *  1. `check-updates.ps1` printed "无需动作" (and exited 0) while the same run
 *     had already reported a pin drift. Green now requires no actions, no
 *     drift, no unrecorded versions and no warning — and the exit code follows.
 *  2. `bin/rea-guide.mjs` ignored REA_BUNDLE_ROOT, so a custom-root machine was
 *     reported `missing` by the one screen that exists to decide "run setup?".
 *  3. `scripts/ghidra-gate-override.mjs` ignored REA_BUNDLE_ROOT too, patched
 *     files before it wrote the recovery record, and trusted `entry.file` from
 *     that record without keeping the target inside the bundle.
 *
 * The PowerShell tests build a throwaway bundle in a temp directory and point
 * REA_BUNDLE_ROOT at it — the live install under DSH_HOME is never touched. The
 * registry is a local stub, so these tests do not need the network and do not
 * turn "upstream published a newer version today" into a red build.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const GUIDE = path.join(PLUGIN_ROOT, "bin", "rea-guide.mjs");
const GHIDRA_OVERRIDE = path.join(PLUGIN_ROOT, "scripts", "ghidra-gate-override.mjs");
const CHECK_UPDATES = path.join(PLUGIN_ROOT, "check-updates.ps1");

const MANIFEST = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "manifest", "bundle.manifest.json"), "utf8"));
const PINS = MANIFEST.pins;

/** A temp directory that removes itself when the test ends. */
function tempDir(t, label) {
  const dir = mkdtempSync(path.join(tmpdir(), `rea-hardening-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run one Node script and return its UTF-8 output. */
function runNode(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/* ------------------------------------------------------- 2. bin/rea-guide.mjs */

test("rea-guide: REA_BUNDLE_ROOT is the root the guide answers for", (t) => {
  const base = tempDir(t, "guide-root");
  const home = path.join(base, "home");
  const root = path.join(base, "custom-root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "bundle.json"), JSON.stringify({ versions: { reaAgents: PINS.reaAgents } }));

  const env = { DSH_HOME: home, REA_BUNDLE_ROOT: root };
  const run = runNode(GUIDE, ["--json"], env);
  assert.equal(run.status, 0, run.output);
  const state = JSON.parse(run.output);

  assert.equal(state.state, "ok", `a provisioned custom root must not read as missing: ${run.output}`);
  assert.equal(path.resolve(state.bundlePath), path.resolve(root, "bundle.json"));
  assert.equal(path.resolve(state.bundleRoot), path.resolve(root));
  // The remedy has to name the root it is talking about, or the copy-pasted
  // command provisions the default root and leaves this one untouched.
  assert.match(state.setupCommand, /--root/);
  assert.ok(state.setupCommand.includes(root), state.setupCommand);
});

test("rea-guide: a missing custom root is reported as missing, still with --root", (t) => {
  const base = tempDir(t, "guide-missing");
  const home = path.join(base, "home");
  const root = path.join(base, "never-provisioned");
  mkdirSync(home, { recursive: true });

  const run = runNode(GUIDE, ["--json"], { DSH_HOME: home, REA_BUNDLE_ROOT: root });
  assert.equal(run.status, 0, run.output);
  const state = JSON.parse(run.output);
  assert.equal(state.state, "missing");
  assert.match(state.setupCommand, /--root/);
});

test("rea-guide: the default root keeps producing the plain --reuse command", (t) => {
  const home = tempDir(t, "guide-default");
  const run = runNode(GUIDE, ["--json"], { DSH_HOME: home, REA_BUNDLE_ROOT: "" });
  assert.equal(run.status, 0, run.output);
  const state = JSON.parse(run.output);
  assert.equal(state.state, "missing");
  assert.equal(path.resolve(state.bundlePath), path.resolve(home, "plugins", "rea-bundle", "bundle.json"));
  assert.doesNotMatch(state.setupCommand, /--root/);
});

test("rea-guide: --root overrides both the environment and the default", (t) => {
  const base = tempDir(t, "guide-flag");
  const root = path.join(base, "from-flag");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "bundle.json"), JSON.stringify({ versions: { reaAgents: PINS.reaAgents } }));
  const run = runNode(GUIDE, ["--json", "--root", root], { DSH_HOME: path.join(base, "home") });
  assert.equal(run.status, 0, run.output);
  const state = JSON.parse(run.output);
  assert.equal(state.state, "ok", run.output);
  assert.equal(path.resolve(state.bundlePath), path.resolve(root, "bundle.json"));
});

/* --------------------------------------------- 3/4/5. ghidra-gate-override.mjs */

const FILES = ["dist/a-policy.js", "dist/b-cli.js", "dist/c-mcp.js"];

/** A throwaway vendored rea-agents tree with the gate constant in three files. */
function makeVendor(t, label) {
  const base = tempDir(t, label);
  const root = path.join(base, "root");
  const vendor = path.join(root, "vendor", "node_modules", "rea-agents");
  mkdirSync(vendor, { recursive: true });
  for (const relative of FILES) {
    mkdirSync(path.join(vendor, path.dirname(relative)), { recursive: true });
    writeFileSync(path.join(vendor, relative), `const SUPPORTED_GHIDRA_VERSION = "12.1.4";\n`);
  }
  writeFileSync(path.join(root, "bundle.json"), JSON.stringify({ paths: { ghidra: path.join(base, "ghidra") } }));
  return { base, root, vendor, env: { DSH_HOME: path.join(base, "home"), REA_BUNDLE_ROOT: root } };
}

function declared(vendor) {
  return FILES.map((relative) => {
    const match = /SUPPORTED_GHIDRA_VERSION = "([^"]+)"/.exec(readFileSync(path.join(vendor, relative), "utf8"));
    return match ? match[1] : null;
  });
}

test("ghidra-gate-override: REA_BUNDLE_ROOT and --root select the root", (t) => {
  const fixture = makeVendor(t, "gate-status");
  const fromEnv = runNode(GHIDRA_OVERRIDE, ["--status"], fixture.env);
  assert.equal(fromEnv.status, 0, fromEnv.output);
  assert.equal(path.resolve(JSON.parse(fromEnv.output).root), path.resolve(fixture.root));

  const fromFlag = runNode(GHIDRA_OVERRIDE, ["--status", "--root", fixture.root], {
    DSH_HOME: path.join(fixture.base, "elsewhere"),
    REA_BUNDLE_ROOT: "",
  });
  assert.equal(fromFlag.status, 0, fromFlag.output);
  assert.equal(path.resolve(JSON.parse(fromFlag.output).root), path.resolve(fixture.root));
});

test("ghidra-gate-override: --enable then --disable round-trips on a custom root", (t) => {
  const fixture = makeVendor(t, "gate-roundtrip");

  const enable = runNode(GHIDRA_OVERRIDE, ["--enable", "--version", "12.2"], fixture.env);
  assert.equal(enable.status, 0, enable.output);
  assert.deepEqual(declared(fixture.vendor), ["12.2", "12.2", "12.2"]);

  const recordPath = path.join(fixture.root, "ghidra-gate-override.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(record.status, "applied");
  assert.equal(record.files.length, FILES.length);
  for (const entry of record.files) {
    // The point of recording first: --disable can prove it restored the bytes.
    assert.equal(typeof entry.originalSha256, "string");
    assert.equal(entry.originalSha256.length, 64);
  }

  const disable = runNode(GHIDRA_OVERRIDE, ["--disable"], fixture.env);
  assert.equal(disable.status, 0, disable.output);
  assert.deepEqual(declared(fixture.vendor), ["12.1.4", "12.1.4", "12.1.4"]);
  assert.equal(existsSync(recordPath), false);
});

test("ghidra-gate-override: originals are recorded before the first patch", (t) => {
  const fixture = makeVendor(t, "gate-record-first");
  // A read-only last file fails the third write. The first two must be rolled
  // back, and the run must say so — a half-applied patch with no record is what
  // the old order produced when it died in the middle.
  const readOnly = path.join(fixture.vendor, FILES[FILES.length - 1]);
  chmodSync(readOnly, 0o444);
  let enable;
  try {
    enable = runNode(GHIDRA_OVERRIDE, ["--enable", "--version", "12.2"], fixture.env);
  } finally {
    chmodSync(readOnly, 0o666);
  }
  assert.equal(enable.status, 1, enable.output);
  assert.match(enable.output, /rolled back 2 file\(s\), nothing left changed/);
  assert.deepEqual(declared(fixture.vendor), ["12.1.4", "12.1.4", "12.1.4"]);
  assert.equal(existsSync(path.join(fixture.root, "ghidra-gate-override.json")), false);
});

test("ghidra-gate-override: --disable refuses a record that escapes the vendor tree", (t) => {
  const fixture = makeVendor(t, "gate-escape");
  const outside = path.join(fixture.base, "outside.js");
  writeFileSync(outside, `const SUPPORTED_GHIDRA_VERSION = "12.2";\n`);
  const escape = path.relative(fixture.vendor, outside); // ../../../../outside.js
  writeFileSync(
    path.join(fixture.root, "ghidra-gate-override.json"),
    JSON.stringify({
      schema: 1,
      requestedVersion: "12.2",
      originalVersion: "12.1.4",
      files: [{ file: escape, original: "12.1.4", patched: "12.2" }],
    }),
  );

  const disable = runNode(GHIDRA_OVERRIDE, ["--disable"], fixture.env);
  assert.equal(disable.status, 1, disable.output);
  assert.match(disable.output, /escapes/);
  assert.match(readFileSync(outside, "utf8"), /"12\.2"/);
});

test("ghidra-gate-override: --disable refuses a record that goes through a symlink", (t) => {
  const fixture = makeVendor(t, "gate-symlink");
  const outside = path.join(fixture.base, "outside-dir");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "x.js"), `const SUPPORTED_GHIDRA_VERSION = "12.2";\n`);
  const link = path.join(fixture.vendor, "linked");
  try {
    symlinkSync(outside, link, "junction");
  } catch (error) {
    t.skip(`this host cannot create a link: ${error.code || error.message}`);
    return;
  }
  writeFileSync(
    path.join(fixture.root, "ghidra-gate-override.json"),
    JSON.stringify({
      schema: 1,
      requestedVersion: "12.2",
      originalVersion: "12.1.4",
      files: [{ file: "linked/x.js", original: "12.1.4", patched: "12.2" }],
    }),
  );

  const disable = runNode(GHIDRA_OVERRIDE, ["--disable"], fixture.env);
  assert.equal(disable.status, 1, disable.output);
  assert.match(disable.output, /symbolic link/);
  assert.match(readFileSync(path.join(outside, "x.js"), "utf8"), /"12\.2"/);
});

/* ------------------------------------------------ 1. check-updates.ps1 (drift) */

function powerShell() {
  const candidates = process.platform === "win32" ? ["powershell", "pwsh"] : [];
  for (const command of candidates) {
    const probe = spawnSync(command, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true });
    if (!probe.error && probe.status === 0) return command;
  }
  return null;
}

/**
 * Windows PowerShell 5.1 writes host output in the console code page, so the
 * bytes are not always UTF-8. Decode as UTF-8 first and fall back to GBK when
 * the result contains replacement characters.
 */
function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return "";
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return utf8;
  }
}

function runPowerShell(command, args, env) {
  // Force UTF-8 out of the host process.
  //
  // A Windows CI runner answers in CP437, where every CJK character collapses to
  // "?" — irreversibly, so `decodeOutput`'s GBK fallback cannot rescue it and
  // every assertion below fails on a host where the script is perfectly fine.
  // (Measured: the conclusion line arrived as
  // `[??] ????:pin ?? 1 ?;?? 2 ?(????)`.) Setting this in the CHILD keeps the
  // shipped script's behaviour untouched — a test harness must not change what
  // the product prints just to make its own assertions match.
  // Parameter NAMES must stay unquoted: `& 'script.ps1' '-Registry' 'url'` hands
  // PowerShell a positional string "-Registry" instead of binding the parameter,
  // which then became $Registry's VALUE and turned the lookup into a request for
  // "-Registry/rea-agents/latest" (measured: a 502 and a red suite). `-File` did
  // the parsing for us; `-Command` does not.
  const token = (value) =>
    String(value).startsWith("-") ? String(value) : `"${String(value).replace(/"/g, '""')}"`;
  const invocation = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$OutputEncoding=[System.Text.Encoding]::UTF8;",
    `& "${CHECK_UPDATES}"`,
    ...args.map(token),
  ].join(" ");
  const result = spawnSync(command, ["-NoProfile", "-Command", invocation], {
    env: { ...process.env, ...env },
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, output: decodeOutput(result.stdout) + decodeOutput(result.stderr) };
}

function lastMeaningfulLine(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .pop();
}

/** A bundle whose recorded versions all equal the manifest pins. */
function makeBundleFixture(t, label) {
  const base = tempDir(t, label);
  const root = path.join(base, "bundle");
  const vendor = path.join(root, "vendor", "node_modules", "rea-agents");
  const ghidra = path.join(root, "ghidra");
  mkdirSync(path.join(vendor, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "manifest"), { recursive: true });
  mkdirSync(path.join(ghidra, "Ghidra"), { recursive: true });

  writeFileSync(
    path.join(vendor, "package.json"),
    JSON.stringify({ name: "rea-agents", version: PINS.reaAgents, engines: { node: PINS.nodeEngines } }),
  );
  // An empty entry is enough: the script only needs the path to exist, and an
  // empty CLI exits 0, so the doctor section degrades to "cannot parse".
  writeFileSync(path.join(vendor, "scripts", "rea.mjs"), "");
  writeFileSync(path.join(ghidra, "Ghidra", "application.properties"), "application.version=12.1.4\n");
  copyFileSync(path.join(PLUGIN_ROOT, "bin", "rea-shim.mjs"), path.join(root, "bin", "rea-shim.mjs"));
  copyFileSync(
    path.join(PLUGIN_ROOT, "manifest", "bundle.manifest.json"),
    path.join(root, "manifest", "bundle.manifest.json"),
  );
  writeFileSync(
    path.join(root, "mirror.json"),
    JSON.stringify({ schema: 1, pluginRoot: PLUGIN_ROOT, mirroredAt: "2026-10-26T13:15:52.351Z", dshHome: base }),
  );

  const bundle = {
    schema: 1,
    provisionedAt: "2026-10-26T13:15:52.343Z",
    paths: { reaEntry: path.join(vendor, "scripts", "rea.mjs"), ghidra },
    versions: {
      reaAgents: PINS.reaAgents,
      ghidra: "12.1.4",
      jdk: "21.0.12",
      apktool: PINS.apktool,
      jadxHeadlessMcp: PINS.jadxHeadlessMcp,
      node: PINS.node,
    },
    components: {
      node: { path: "node", how: "PATH", version: PINS.node, reused: true },
      apktool: { path: path.join(root, "vendor", "apktool"), jarName: "apktool.jar", version: PINS.apktool, tofu: false },
      jadxHeadlessMcp: { path: path.join(root, "vendor", "jadx"), jarName: "jadx.jar", version: PINS.jadxHeadlessMcp, tofu: false },
    },
    unverifiedChecksums: [],
  };
  writeFileSync(path.join(root, "bundle.json"), JSON.stringify(bundle, null, 2));

  const home = path.join(base, "home");
  const profile = path.join(home, "profiles", "desktop");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "dsh-plugin-rea": `file:${PLUGIN_ROOT.replace(/\\/g, "/")}` },
      dsh: { profile: { bundles: ["dsh-plugin-rea"] } },
    }),
  );
  writeFileSync(path.join(profile, "cordis.patch.yml"), "plugins:\n  - id: mcp-rea\n");

  const env = { DSH_HOME: path.join(home), REA_BUNDLE_ROOT: root, DSH_PROFILE_DIR: profile };
  return { base, root, vendor, ghidra, bundle, env };
}

/** A registry stub that answers the pin, so these tests never need the network. */
async function stubRegistry(t) {
  const server = createServer((req, res) => {
    if (req.url === "/rea-agents/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: PINS.reaAgents }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("check-updates: a clean bundle is the only green run", async (t) => {
  const command = powerShell();
  if (!command) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const registry = await stubRegistry(t);
  const fixture = makeBundleFixture(t, "check-clean");

  const run = runPowerShell(command, ["-Registry", registry], fixture.env);
  assert.equal(run.status, 0, `clean bundle must exit 0:\n${run.output}`);
  assert.match(lastMeaningfulLine(run.output), /无需动作/, run.output);
});

test("check-updates: a pin drift is reported as needing action, not as green", async (t) => {
  const command = powerShell();
  if (!command) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const registry = await stubRegistry(t);
  const fixture = makeBundleFixture(t, "check-drift");
  const bundle = JSON.parse(readFileSync(path.join(fixture.root, "bundle.json"), "utf8"));
  bundle.versions.apktool = "3.0.2"; // pin says 3.0.3
  writeFileSync(path.join(fixture.root, "bundle.json"), JSON.stringify(bundle, null, 2));

  const run = runPowerShell(command, ["-Registry", registry], fixture.env);
  assert.equal(run.status, 1, `drift must not exit 0:\n${run.output}`);
  assert.doesNotMatch(run.output, /无需动作/, run.output);
  assert.match(run.output, /apktool 盘上为 3\.0\.2/);
  const last = lastMeaningfulLine(run.output);
  assert.match(last, /需要动作/, last);
  assert.match(last, /pin 漂移 1 项/, last);
});

function hasFileHash(command) {
  // The stale-mirror warning below is produced by comparing two file hashes, so a
  // host without `Get-FileHash` (hosted Windows runners, restricted language mode)
  // cannot construct that scenario at all. Skip honestly instead of asserting on a
  // warning the platform can never emit — the script itself already reports the
  // missing capability as [上游] rather than as "needs action".
  const probe = spawnSync(command, ["-NoProfile", "-Command", "if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"], {
    windowsHide: true,
  });
  return probe.status === 0;
}

test("check-updates: a warning alone is enough to stop the green verdict", async (t) => {
  const command = powerShell();
  if (!command) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  if (!hasFileHash(command)) {
    t.skip("this host has no Get-FileHash, so the stale-mirror warning cannot be produced");
    return;
  }
  const registry = await stubRegistry(t);
  const fixture = makeBundleFixture(t, "check-warn");
  // Every pin matches; only the mirrored shim is stale (plugin upgraded, setup
  // not re-run). That used to be a warning next to a green verdict.
  writeFileSync(path.join(fixture.root, "bin", "rea-shim.mjs"), "// stale mirror\n");

  const run = runPowerShell(command, ["-Registry", registry], fixture.env);
  assert.equal(run.status, 1, `a warning must not exit 0:\n${run.output}`);
  assert.doesNotMatch(run.output, /无需动作/, run.output);
  assert.match(run.output, /镜像 shim 落后于插件/);
  const last = lastMeaningfulLine(run.output);
  assert.match(last, /需要动作/, last);
  assert.match(last, /提醒/, last);
});

test("check-updates: an action item also produces a non-zero exit", async (t) => {
  const command = powerShell();
  if (!command) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const registry = await stubRegistry(t);
  const fixture = makeBundleFixture(t, "check-action");
  // components.node.reused stays true, but the recorded runtime no longer
  // satisfies REA's engines — the case that used to print an action and exit 0.
  const bundle = JSON.parse(readFileSync(path.join(fixture.root, "bundle.json"), "utf8"));
  bundle.versions.node = "16.20.2";
  writeFileSync(path.join(fixture.root, "bundle.json"), JSON.stringify(bundle, null, 2));

  const run = runPowerShell(command, ["-Registry", registry], fixture.env);
  assert.equal(run.status, 1, `an unhealthy node must not exit 0:\n${run.output}`);
  const last = lastMeaningfulLine(run.output);
  assert.match(last, /需要动作/, last);
});

/* ------------------------------------------------------------------- safety net */

test("check-updates: a recorded gate override is not drift", async (t) => {
  const command = powerShell();
  if (!command) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const registry = await stubRegistry(t);
  const fixture = makeBundleFixture(t, "check-override");
  // Ghidra pinned at 12.1.4 would match anyway; record 12.2 plus its override to
  // prove the pair is reported as a deliberate local divergence, never as drift.
  const bundle = JSON.parse(readFileSync(path.join(fixture.root, "bundle.json"), "utf8"));
  bundle.versions.ghidra = "12.2";
  writeFileSync(path.join(fixture.root, "bundle.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(path.join(fixture.ghidra, "Ghidra", "application.properties"), "application.version=12.2\n");
  writeFileSync(
    path.join(fixture.root, "ghidra-gate-override.json"),
    JSON.stringify({ schema: 1, requestedVersion: "12.2", originalVersion: "12.1.4", files: [] }),
  );

  const run = runPowerShell(command, ["-Registry", registry], fixture.env);
  assert.doesNotMatch(run.output, /ghidra 盘上为 12\.2/, run.output);
  // The version gate still knows REA pins 12.1.x; it must attribute the 12.2 to
  // the recorded override instead of printing an action item.
  assert.match(run.output, /本机 --enable 的覆盖/);
  assert.equal(run.status, 0, `a recorded override is not a defect:\n${run.output}`);
  const last = lastMeaningfulLine(run.output);
  assert.doesNotMatch(last, /pin 漂移/, last);
});
