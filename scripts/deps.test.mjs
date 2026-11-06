#!/usr/bin/env node
/**
 * Tests for the vendored dependency closure: the audited lockfile, the advisory
 * gate that guards it, and the provisioning path that replays it.
 *
 * The defect these pin, measured on the closure `rea-agents@6.8.0` resolves from
 * the registry alone: it pins zod exactly (`"zod": "4.4.3"`), 4.4.3 is inside
 * GHSA-mrhx-c7xc-m3w5 (fixed in 4.6.6), and its `.max()` array validators turn a
 * malformed tool call into an issue-object amplifier — 25 elements into a
 * `.max(2)` schema produced 26 issues on 4.4.3 and 1 on 4.6.7. The same closure
 * carried minimatch@10.2.6 (GHSA-g3hv-75wg-m249) and glob@13.0.7
 * (GHSA-3g3m-2fjr-6pw4) through @electron/asar and frida, and nothing recorded
 * which versions an install produced, so two machines a month apart disagreed.
 *
 * No network and no npm: every check here is a file read or a spawned script.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADVISORY_FLOORS,
  compareVersions,
  evaluateAdvisories,
  lockCopies,
  parseOverrides,
} from "./check-dependency-advisories.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_DIR = path.join(REPO_ROOT, "scripts", "vendor-lock");
const LOCK_PATH = path.join(LOCK_DIR, "package-lock.json");
const SETUP_SOURCE = path.join(REPO_ROOT, "scripts", "setup.mjs");
const GATE = path.join(REPO_ROOT, "scripts", "check-dependency-advisories.mjs");
const MANIFEST = path.join(REPO_ROOT, "manifest", "bundle.manifest.json");

const REA_PIN = JSON.parse(readFileSync(MANIFEST, "utf8")).pins.reaAgents;
const readLock = () => JSON.parse(readFileSync(LOCK_PATH, "utf8"));
const cloneLock = () => JSON.parse(JSON.stringify(readLock()));

/** Runs the gate as CI would, against a caller-selected lockfile. */
function runGate(lockFile, extra = []) {
  return spawnSync(process.execPath, [GATE, "--lock", lockFile, ...extra], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
}

/** Writes `lock` into a throwaway directory and returns the file path. */
function fixtureLock(lock) {
  const dir = mkdtempSync(path.join(tmpdir(), "rea-deps-lock-"));
  const file = path.join(dir, "package-lock.json");
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return { dir, file };
}

/* ------------------------------------------- the shipped closure is not advisory-affected */

test("the shipped lock resolves zod, minimatch and glob at or above every floor", () => {
  const lock = readLock();
  for (const advisory of ADVISORY_FLOORS) {
    const copies = lockCopies(lock, advisory.name);
    assert.ok(copies.length > 0, `${advisory.name} must stay in the closure; the escape hatch below would hide its removal`);
    for (const copy of copies) {
      assert.ok(
        compareVersions(copy.version, advisory.floor) >= 0,
        `${advisory.name}@${copy.version} at ${copy.location} is below the ${advisory.floor} floor of ${advisory.advisory}`,
      );
    }
  }
});

test("the lock pins the REA the manifest names", () => {
  // A lock that pins a different REA is not a fix, it is a different server: the
  // closure is resolved for one exact tarball's dependency list.
  assert.equal(readLock().packages[""].dependencies["rea-agents"], REA_PIN);
});

test("every advisory-affected package resolves to exactly one version", () => {
  // Two copies would mean one of them is the unpatched one; the gate checks all
  // copies, and this asserts the closure does not rely on that leniency.
  const lock = readLock();
  for (const advisory of ADVISORY_FLOORS) {
    const versions = [...new Set(lockCopies(lock, advisory.name).map((copy) => copy.version))];
    assert.deepEqual(versions.length, 1, `${advisory.name} resolves to ${versions.join(", ")}`);
  }
});

/* --------------------------------------------------------------- the gate itself */

test("the gate passes the shipped lock and prints the three rows", () => {
  const run = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /dependency advisories/);
  for (const advisory of ADVISORY_FLOORS) {
    assert.match(run.stdout, new RegExp(`${advisory.name}\\s+\\S+`), `the report must name ${advisory.name}`);
    assert.match(run.stdout, new RegExp(advisory.advisory), `the report must cite ${advisory.advisory}`);
  }
  assert.doesNotMatch(run.stderr, /FAIL/);
});

test("the gate fails a copy below the zod floor", () => {
  const lock = cloneLock();
  lock.packages["node_modules/zod"].version = "4.4.3";
  const fixture = fixtureLock(lock);
  try {
    const run = runGate(fixture.file);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /zod: 4\.4\.3 < 4\.6\.6 \(GHSA-mrhx-c7xc-m3w5\)/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the gate fails a NESTED copy below the minimatch floor even when the top copy is fine", () => {
  // The amplification advisory is about whichever copy is imported; a patched
  // top-level package with an unpatched duplicate underneath is the realistic
  // regression when an upstream dependency gains its own minimatch.
  const lock = cloneLock();
  lock.packages["node_modules/incur/node_modules/minimatch"] = { version: "10.2.6", resolved: "fixture", integrity: "" };
  const fixture = fixtureLock(lock);
  try {
    const run = runGate(fixture.file);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /minimatch: 10\.2\.6 < 11\.0\.1 \(GHSA-g3hv-75wg-m249\)/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the gate fails a glob below the AbortSignal floor", () => {
  const lock = cloneLock();
  lock.packages["node_modules/glob"].version = "14.0.1";
  const fixture = fixtureLock(lock);
  try {
    const run = runGate(fixture.file);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /glob: 14\.0\.1 < 14\.0\.2 \(GHSA-3g3m-2fjr-6pw4\)/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a missing lockfile is unverifiable, not safe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rea-deps-missing-"));
  try {
    const run = runGate(path.join(dir, "package-lock.json"));
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /no lockfile/);
    assert.match(run.stderr, /npm install --package-lock-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package that left the closure is reported, and is not a violation", () => {
  // An upstream REA that stops depending on minimatch must not leave a gate that
  // fails forever for a package nobody imports.
  const lock = cloneLock();
  delete lock.packages["node_modules/minimatch"];
  const fixture = fixtureLock(lock);
  try {
    const run = runGate(fixture.file);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /n\/a\s+minimatch\s+not in the closure/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a lock that lags the manifest is refused as stale", () => {
  const verdict = evaluateAdvisories(readLock(), { manifestPin: "6.9.0" });
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.problems.some((problem) => /pins rea-agents@6\.8\.0 but the manifest pins 6\.9\.0/.test(problem)),
    verdict.problems.join("\n"),
  );
});

/* --------------------------------- the degraded install path cannot undo the fix */

test("setup.mjs's fallback overrides sit at or above the floors", () => {
  const overrides = parseOverrides(readFileSync(SETUP_SOURCE, "utf8"), "const CLOSURE_OVERRIDES");
  assert.ok(overrides, "provisionReaAgents must keep a readable CLOSURE_OVERRIDES table for the no-lock fallback");
  for (const advisory of ADVISORY_FLOORS) {
    assert.equal(typeof overrides[advisory.name], "string", `${advisory.name} must be overridden explicitly`);
    assert.ok(
      compareVersions(overrides[advisory.name], advisory.floor) >= 0,
      `setup.mjs overrides ${advisory.name} to ${overrides[advisory.name]}, below ${advisory.floor}`,
    );
  }
});

test("setup.mjs and vendor-lock/package.json declare the same overrides", () => {
  const fromSetup = parseOverrides(readFileSync(SETUP_SOURCE, "utf8"), "const CLOSURE_OVERRIDES");
  const fromLockPackage = parseOverrides(readFileSync(path.join(LOCK_DIR, "package.json"), "utf8"), '"overrides"');
  for (const advisory of ADVISORY_FLOORS) {
    assert.equal(
      fromSetup[advisory.name],
      fromLockPackage[advisory.name],
      `the lock and the fallback disagree on ${advisory.name}; one of the two install paths would resolve differently`,
    );
  }
});

test("an override below a floor is caught even when the lock is clean", () => {
  // The lock is what runs when `ci` works; the override table is what runs when it
  // does not, and only the second one is edited by hand.
  const sabotaged = `const CLOSURE_OVERRIDES = { zod: "4.4.3", minimatch: "10.2.6", glob: "13.0.7" };\n`;
  const verdict = evaluateAdvisories(readLock(), {
    manifestPin: REA_PIN,
    setupSource: sabotaged,
    lockPackageSource: readFileSync(path.join(LOCK_DIR, "package.json"), "utf8"),
  });
  assert.equal(verdict.ok, false);
  for (const advisory of ADVISORY_FLOORS) {
    assert.ok(
      verdict.problems.some((problem) => problem.includes(advisory.name) && problem.includes(advisory.floor)),
      `expected a floor complaint for ${advisory.name}; got:\n${verdict.problems.join("\n")}`,
    );
  }
});

test("setup.mjs's own zod floor is the advisory's fixed version", () => {
  // ZOD_FLOOR decides whether a provisioned closure is accepted, so it has to be
  // the advisory's number, not a value that drifted with a pin bump.
  const source = readFileSync(SETUP_SOURCE, "utf8");
  const match = source.match(/const ZOD_FLOOR = "([^"]+)";/);
  assert.ok(match, "provisionReaAgents must verify the resolved zod against an explicit floor");
  const zodFloor = ADVISORY_FLOORS.find((advisory) => advisory.name === "zod").floor;
  assert.equal(compareVersions(match[1], zodFloor), 0, `setup.mjs floor ${match[1]} != advisory floor ${zodFloor}`);
});

/* ---------------------------------------------- provisioning replays the lock, in staging */

test("provisionReaAgents installs from the shipped lock, after staging, and never blind", () => {
  const source = readFileSync(SETUP_SOURCE, "utf8");
  const start = source.indexOf("async function provisionReaAgents(component, context) {");
  assert.ok(start > 0, "provisionReaAgents must still exist");
  const end = source.slice(start).search(/\r?\n\}\r?\n/);
  assert.ok(end > 0, "provisionReaAgents must have a closing brace");
  const body = source.slice(start, start + end);

  // The old shape: one `npm install rea-agents@x --no-save` straight into the live
  // vendor tree, which is neither reproducible nor safe to interrupt.
  assert.doesNotMatch(body, /--no-save/, "a replayed lock replaces the blind `--no-save` install");
  assert.match(body, /vendor-lock/, "the function must look for the audited lock");
  assert.match(body, /npmRun\("ci"\)/, "the lock must be replayed with `npm ci`");
  assert.match(body, /--ignore-scripts/, "lifecycle scripts stay off on both routes");

  // Staging before the swap: `npm ci` deletes node_modules first, so running it in
  // place would destroy a working install on any network failure.
  const stagingAt = body.indexOf('.npm-staging');
  const swapAt = body.indexOf("renameSync(modules, live)");
  assert.ok(stagingAt > 0 && swapAt > stagingAt, "the closure must be installed into staging and renamed in afterwards");

  // The fallback route must keep the patched pins, and the result is verified
  // whatever route produced it.
  assert.match(body, /npmRun\("install"\)/);
  assert.match(body, /atLeast\(zodVersion, ZOD_FLOOR\)/);
});

test("compareVersions orders dotted versions numerically, not as strings", () => {
  assert.equal(compareVersions("4.6.7", "4.6.6"), 1);
  assert.equal(compareVersions("4.4.3", "4.6.6"), -1);
  assert.equal(compareVersions("4.6.6", "4.6.6"), 0);
  assert.equal(compareVersions("11.0.5", "11.0.1"), 1);
  assert.equal(compareVersions("14.0.4", "14.0.2"), 1);
  // The string-comparison trap: "10" < "9" lexically, but 10 is newer than 9.
  assert.equal(compareVersions("10.2.6", "9.9.9"), 1);
});

test("the shipped lock is what the gate reads by default", () => {
  assert.ok(existsSync(LOCK_PATH), "scripts/vendor-lock/package-lock.json must be committed");
  assert.ok(existsSync(path.join(LOCK_DIR, "package.json")), "the lock's package.json must be committed next to it");
});
