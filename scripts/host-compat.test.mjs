#!/usr/bin/env node
/**
 * Tests for scripts/host-compat.mjs — the gate that compares the declared
 * `engines.dsh` string against the list of DSH releases this bundle was adapted
 * to.
 *
 * Every test here exists because one of these failures is silent. The gate has
 * no runtime feedback: it prints a line per release and exits, and the wrong
 * verdict looks exactly like the right one in a CI log nobody reads closely. So
 * each way it can lie gets a test that names the lie:
 *
 *   - a range that is unparseable reads as `unknown` (an undeclared plugin,
 *     not a mis-declared one) — so the parser refuses shapes it cannot judge
 *   - a floor that drifted drops hosts the README still promises — so the
 *     drifted-floor control asserts the exact set it loses
 *   - a ceiling of `<0.3.0` admits `0.3.0-rc.1`, because a prerelease sorts
 *     BELOW its release once prereleases are included — the single most
 *     expensive mistake this package ever shipped
 *   - a zero-padded prerelease or a `v` prefix is a typo, and a gate that
 *     guesses at one puts the guess in charge of what the market advertises
 *   - an appended release lands in the wrong place in the list, so the next
 *     person reads the coverage claim backwards
 *
 * Runs with `node --test`. No network, no filesystem writes.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOST_RELEASES,
  OUTSIDE_HOSTS,
  checkHostCoverage,
  compareVersions,
  declaredHostRange,
  parseVersion,
  satisfiesDeclaredRange,
} from "./host-compat.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

/** The declaration this package actually ships; pinned by its own test too. */
const RANGE = ">=0.1.7-rc.2 <0.3.0-0";

/* --------------------------------------------------------- parseVersion */

test("parseVersion splits the tuple and keeps a prerelease", () => {
  assert.deepEqual(parseVersion("0.2.1-rc.2"), { parts: [0, 2, 1], pre: ["rc", 2] });
  assert.deepEqual(parseVersion("0.1.7-rc.2"), { parts: [0, 1, 7], pre: ["rc", 2] });
  // A numeric prerelease identifier becomes a number, not the string "2": the
  // comparison in compareVersions branches on that type.
  assert.deepEqual(parseVersion("0.2.1-alpha.10"), { parts: [0, 2, 1], pre: ["alpha", 10] });
});

test("parseVersion drops build metadata, because precedence has none", () => {
  // A host reporting `0.2.0-rc.2+build.7` is running 0.2.0-rc.2. node-semver and
  // this file both ignore the suffix; a gate that kept it would compare the
  // string "7" against an alpha identifier and answer with nonsense.
  assert.deepEqual(parseVersion("0.2.0-rc.2+build.7"), { parts: [0, 2, 0], pre: ["rc", 2] });
  assert.deepEqual(parseVersion("0.2.0+build.7"), { parts: [0, 2, 0], pre: [] });
  assert.equal(compareVersions("0.2.0-rc.2+build.7", "0.2.0-rc.2"), 0);
});

test("parseVersion refuses the shapes a typo produces instead of guessing", () => {
  // Zero-padded numeric identifier: semver forbids it. Accepting one would let
  // `0.2.1-01` compare equal to `0.2.1-1` and hide a typo in the release list.
  assert.equal(parseVersion("0.2.1-01"), null);
  assert.equal(parseVersion("0.2.1-rc.01"), null);
  // A leading `v` is a tag, not a version.
  assert.equal(parseVersion("v0.2.0-rc.2"), null);
  // Too few / too many components, and outright garbage.
  assert.equal(parseVersion("0.2"), null);
  assert.equal(parseVersion("0.2.0.1"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion("latest"), null);
});

test("parseVersion accepts a single zero and a prerelease of one identifier", () => {
  // `0` is legal and is load bearing: `<0.3.0-0` ends at the bare zero
  // identifier, which is what makes every 0.3.0 prerelease sort above it.
  assert.deepEqual(parseVersion("0.3.0-0"), { parts: [0, 3, 0], pre: [0] });
  assert.deepEqual(parseVersion("0.2.1-rc"), { parts: [0, 2, 1], pre: ["rc"] });
});

/* ------------------------------------------------------- compareVersions */

test("a prerelease sorts below its release", () => {
  assert.equal(compareVersions("0.2.1-rc.2", "0.2.1"), -1);
  assert.equal(compareVersions("0.2.1", "0.2.1-rc.2"), 1);
  assert.equal(compareVersions("0.2.2-rc.1", "0.2.2"), -1);
  assert.equal(compareVersions("0.2.1", "0.2.1"), 0);
});

test("prerelease identifiers order the way semver says, not the way strings do", () => {
  // Numeric identifiers sort below alphanumeric ones.
  assert.equal(compareVersions("0.3.0-0", "0.3.0-alpha.1"), -1);
  assert.equal(compareVersions("0.3.0-rc.1", "0.3.0-0"), 1);
  // alpha < rc. String order agrees with this one, so it alone proves nothing.
  assert.equal(compareVersions("0.2.1-alpha.5", "0.2.1-rc.1"), -1);
  // But string order DISAGREES here: "alpha.10" < "alpha.5" as text, and semver
  // compares 10 > 5. This is the assertion that catches a localeCompare slip.
  assert.equal(compareVersions("0.2.1-alpha.10", "0.2.1-alpha.5"), 1);
  // A shorter identifier list sorts below a longer one that shares its prefix.
  assert.equal(compareVersions("0.2.1-rc", "0.2.1-rc.1"), -1);
  assert.equal(compareVersions("0.2.1-rc.2", "0.2.1-rc.1"), 1);
});

test("compareVersions compares the tuple before the prerelease", () => {
  // 0.2.2-alpha.3 is NEWER than 0.2.1-rc.5 even though "alpha" < "rc": the
  // tuple decides first. The release list's one ordering exception depends on
  // the opposite direction of this rule, so get it pinned.
  assert.equal(compareVersions("0.2.2-alpha.3", "0.2.1-rc.5"), 1);
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.2-alpha.2"), -1);
});

test("compareVersions refuses unparseable input rather than returning a verdict", () => {
  assert.throws(() => compareVersions("v0.2.0", "0.2.0"), /not a version/);
  assert.throws(() => compareVersions("0.2.0", "0.2.1-01"), /not a version/);
});

/* ------------------------------------------------ satisfiesDeclaredRange */

test("the declared range admits every release from the floor up", () => {
  assert.equal(satisfiesDeclaredRange("0.1.7-rc.2", RANGE), true, "the floor itself is inside");
  assert.equal(satisfiesDeclaredRange("0.2.0-rc.1", RANGE), true);
  assert.equal(satisfiesDeclaredRange("0.2.1-rc.5", RANGE), true);
  assert.equal(satisfiesDeclaredRange("0.2.2-rc.1", RANGE), true, "the host this list was last measured on");
});

test("the next minor line falls outside, prereleases included", () => {
  // This is the assertion the `<0.3.0-0` ceiling exists for. With
  // `includePrerelease: true`, `0.3.0-rc.1 < 0.3.0` is true, so a plain
  // `<0.3.0` ceiling would have admitted a host nobody audited.
  assert.equal(satisfiesDeclaredRange("0.3.0", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.3.0-rc.1", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.3.0-alpha.1", RANGE), false);
  // And the boundary node itself is excluded: `< 0.3.0-0` is strict.
  assert.equal(satisfiesDeclaredRange("0.3.0-0", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.4.0", RANGE), false);
});

test("versions below the floor fall outside", () => {
  assert.equal(satisfiesDeclaredRange("0.1.7-rc.1", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.1.7-alpha.2", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.1.6-alpha.2", RANGE), false);
  assert.equal(satisfiesDeclaredRange("0.1.7", RANGE), true, "the release of the floor line is above its rc");
});

test("build metadata does not change the verdict", () => {
  assert.equal(satisfiesDeclaredRange("0.2.0-rc.2+build.7", RANGE), true);
  assert.equal(satisfiesDeclaredRange("0.3.0-rc.1+build.7", RANGE), false);
});

test("only the `>=X <Y` shape is evaluated; anything else is refused", () => {
  // Deliberately narrow. A wider parser here could disagree with the market's
  // semver implementation on a range the manifest would then be trusted for,
  // and the disagreement would surface as a wrong "compatible" badge.
  for (const range of ["^0.2.0", "~0.2.0", "0.2.0", ">=0.1.7-rc.2", "<0.3.0-0", ">=0.1.7-rc.2 <0.3.0-0 || >=0.4.0-0", ">= 0.1.7-rc.2 <0.3.0-0 <0.4.0-0"]) {
    assert.throws(() => satisfiesDeclaredRange("0.2.0-rc.2", range), /unsupported host range/, `must refuse ${range}`);
  }
});

test("extra whitespace around the two comparators is tolerated", () => {
  // A pasted range often carries it, and node-semver tolerates it too.
  assert.equal(satisfiesDeclaredRange("0.2.0-rc.2", "  >=0.1.7-rc.2   <0.3.0-0  "), true);
});

/* ------------------------------------------------------ declaredHostRange */

test("declaredHostRange reads the real manifest and returns null when absent", () => {
  assert.equal(typeof declaredHostRange(REPO_ROOT), "string");
  assert.equal(declaredHostRange(path.join(HERE, "no-such-root-for-host-compat")), null);
});

/* ----------------------------------------------------- checkHostCoverage */

test("every listed release is covered and no outsider leaks in", () => {
  const { covered, uncovered, leaked } = checkHostCoverage(RANGE);
  assert.deepEqual(uncovered, [], `these releases fall outside ${RANGE}`);
  assert.deepEqual(leaked, [], `the declaration also admits ${leaked.join(", ")}, which nobody tested`);
  assert.deepEqual(covered, HOST_RELEASES, "covered must report the list in list order");
});

test("the drifted-floor control loses exactly the hosts a 0.2.0 floor would drop", () => {
  // A negative control: a gate that always passes proves nothing. `>=0.2.0` is
  // the shape someone writes after testing only on their own machine — and
  // because a prerelease sorts BELOW its release, it drops the whole 0.2.0-rc
  // line as well as 0.1.7, while looking like it names the running host.
  const { uncovered } = checkHostCoverage(">=0.2.0 <0.3.0-0");
  assert.deepEqual(uncovered, ["0.2.0-rc.2", "0.2.0-rc.1", "0.1.7-rc.2"]);
});

test("the leaked-host control notices a low floor and a raised ceiling", () => {
  assert.deepEqual(checkHostCoverage(">=0.1.0 <0.3.0-0").leaked, ["0.1.7-rc.1", "0.1.7-alpha.2"]);
  // The other half: a ceiling that reaches into 0.3.0 must be reported, not
  // silently accepted. Every 0.3.0 entry has to show up.
  assert.deepEqual(checkHostCoverage(">=0.1.7-rc.2 <0.4.0-0").leaked, ["0.3.0", "0.3.0-rc.1", "0.3.0-alpha.1"]);
  // A plain `<0.3.0` ceiling is the expensive one: it admits the 0.3.0
  // prereleases while still excluding 0.3.0 itself, so only the two prerelease
  // entries surface. That asymmetry is exactly why this list is pinned.
  assert.deepEqual(checkHostCoverage(">=0.1.7-rc.2 <0.3.0").leaked, ["0.3.0-rc.1", "0.3.0-alpha.1"]);
});

test("checkHostCoverage propagates the refusal for an unparseable range", () => {
  assert.throws(() => checkHostCoverage("^0.2.0"), /unsupported host range/);
});

/* ------------------------------------------------------- the release list */

test("the 2026-11-06 adaptation is present, and the newest six are in front", () => {
  const added = ["0.2.2-rc.1", "0.2.2-alpha.3", "0.2.1-rc.5", "0.2.2-alpha.2", "0.2.1-rc.4", "0.2.1-rc.3"];
  assert.deepEqual(HOST_RELEASES.slice(0, added.length), added, "newest-first by publish date");
  for (const version of added) {
    assert.ok(HOST_RELEASES.includes(version), `${version} must be listed; an unlisted release is an unchecked one`);
  }
  // 0.2.2-rc.1 is the host this adaptation was measured on: if it is not the
  // first entry, someone prepended without a reason.
  assert.equal(HOST_RELEASES[0], "0.2.2-rc.1");
});

test("the list stays newest-first, with exactly one documented publication-order exception", () => {
  // "Newest first" means by publish date. That is semver-descending everywhere
  // EXCEPT 0.2.1-rc.5 (published after 0.2.2-alpha.2), which is the one
  // inversion the list carries on purpose. Pinning the exception list rather
  // than the whole array keeps this test from being a third copy of the data
  // while still catching an append in the wrong place.
  const inversions = [];
  for (let index = 1; index < HOST_RELEASES.length; index += 1) {
    const previous = HOST_RELEASES[index - 1];
    const current = HOST_RELEASES[index];
    if (compareVersions(previous, current) <= 0) inversions.push(`${previous} < ${current}`);
  }
  assert.deepEqual(inversions, ["0.2.1-rc.5 < 0.2.2-alpha.2"]);
});

test("the floor is still 0.1.7-rc.2, the oldest release ever adapted to", () => {
  // Raising the floor silently drops hosts the README promises, which is the
  // failure the file header calls out. If a future adaptation really does drop
  // 0.1.7, this test is where the decision gets recorded.
  assert.equal(HOST_RELEASES[HOST_RELEASES.length - 1], "0.1.7-rc.2");
  // And the list never runs below the floor it claims.
  for (const version of HOST_RELEASES) {
    assert.ok(compareVersions(version, "0.1.7-rc.2") >= 0, `${version} sorts below the floor`);
  }
});

test("the list carries no duplicate and every entry parses", () => {
  assert.equal(new Set(HOST_RELEASES).size, HOST_RELEASES.length, "a duplicate would double-count coverage");
  for (const version of HOST_RELEASES) {
    assert.notEqual(parseVersion(version), null, `${version} is not a version this gate can evaluate`);
  }
});

test("the outsider list is the audited one, and none of it is a shipped release", () => {
  // Pinned so that "make the gate pass" can never be done by deleting an
  // outsider. These five are the ones a wrong ceiling or a wrong floor admits.
  assert.deepEqual(OUTSIDE_HOSTS, ["0.3.0", "0.3.0-rc.1", "0.3.0-alpha.1", "0.1.7-rc.1", "0.1.7-alpha.2"]);
  for (const version of OUTSIDE_HOSTS) {
    assert.ok(!HOST_RELEASES.includes(version), `${version} is both covered and required to be outside`);
  }
});

test("the newest release stays inside the declared ceiling, without the ceiling moving", () => {
  // The declared range is the thing the market reads. An adaptation that needed
  // a wider ceiling would have to change `engines.dsh` — a decision for a human,
  // and this assertion is what forces it to be one.
  assert.equal(declaredHostRange(REPO_ROOT), RANGE);
  assert.equal(satisfiesDeclaredRange(HOST_RELEASES[0], RANGE), true);
});
