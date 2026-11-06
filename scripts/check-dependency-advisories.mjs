#!/usr/bin/env node
/**
 * Offline advisory gate for the vendored REA dependency closure.
 *
 * `scripts/setup.mjs` installs `rea-agents` into `<root>/vendor` from
 * `vendor-lock/package-lock.json`. That lock is the only thing that decides which
 * zod / minimatch / glob the vendored REA actually runs on, and it is regenerated
 * by hand, so it can silently fall behind the advisories it was created for. This
 * gate is the part that fails loudly:
 *
 *   - every copy of each advisory-affected package in the lock must be at or above
 *     the first fixed version;
 *   - the lock must still pin the REA version the manifest asks for (a stale lock
 *     would install the wrong server, and setup.mjs would skip the lock only after
 *     burning a run);
 *   - the `overrides` that setup.mjs falls back to and the `overrides` recorded in
 *     vendor-lock/package.json must agree with each other and with the lock, so the
 *     degraded install path cannot resolve something the audited path would not.
 *
 * It reads files only: no registry, no network, no npm. Run it in CI next to the
 * test suite (`node ./scripts/check-dependency-advisories.mjs`), or by hand after
 * changing a pin.
 *
 * Exit codes: 0 = every floor met, 1 = a floor is violated / the lock is stale or
 * inconsistent, 2 = the lockfile could not be read at all.
 *
 * Regenerating the lock after an upstream pin bump:
 *
 *   cd scripts/vendor-lock
 *   npm install --package-lock-only --ignore-scripts
 *
 * and commit the resulting package-lock.json together with the manifest change.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/**
 * First fixed version per advisory, with the advisory that set it. The floors are
 * the lower bound of "not affected"; the pins in vendor-lock are the versions the
 * closure actually resolves and are expected to sit above them.
 */
export const ADVISORY_FLOORS = [
  {
    name: "zod",
    floor: "4.6.6",
    advisory: "GHSA-mrhx-c7xc-m3w5",
    impact: "memory exhaustion while validating oversized constrained collections",
  },
  {
    name: "minimatch",
    floor: "11.0.1",
    advisory: "GHSA-g3hv-75wg-m249",
    impact: "globparts amplification on an attacker-chosen pattern",
  },
  {
    name: "glob",
    floor: "14.0.2",
    advisory: "GHSA-3g3m-2fjr-6pw4",
    impact: "AbortSignal cancellation bypass keeps traversing after a timeout",
  },
];

/* Same comparison setup.mjs uses: dotted numerics, prerelease suffix ignored. */
export function compareVersions(left, right) {
  const parts = (value) => String(value).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index] ?? 0;
    const other = b[index] ?? 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}

/** Every installed copy of `name` in a lockfile, including nested duplicates. */
export function lockCopies(lock, name) {
  const suffix = `node_modules/${name}`;
  const found = [];
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key !== suffix && !key.endsWith(`/${suffix}`)) continue;
    found.push({ location: key, version: entry?.version ?? null });
  }
  return found;
}

/**
 * Judge one parsed lockfile.
 *
 * `setupSource` and `lockPackageSource` are raw texts (or null); the overrides they
 * declare are compared against each other and against the resolved versions.
 */
export function evaluateAdvisories(lock, { manifestPin = null, setupSource = null, lockPackageSource = null } = {}) {
  const rows = [];
  const problems = [];

  for (const advisory of ADVISORY_FLOORS) {
    const copies = lockCopies(lock, advisory.name);
    if (copies.length === 0) {
      rows.push({ ...advisory, status: "absent", copies, detail: "not in the closure; no advisory applies" });
      continue;
    }
    const below = copies.filter((copy) => !copy.version || compareVersions(copy.version, advisory.floor) < 0);
    if (below.length > 0) {
      rows.push({
        ...advisory,
        status: "unsafe",
        copies,
        detail: `${below.map((copy) => `${copy.version ?? "unknown"} at ${copy.location}`).join(", ")} is below ${advisory.floor}`,
      });
      problems.push(`${advisory.name}: ${below.map((copy) => copy.version ?? "unknown").join(", ")} < ${advisory.floor} (${advisory.advisory})`);
      continue;
    }
    const distinct = [...new Set(copies.map((copy) => copy.version))].join(", ");
    rows.push({
      ...advisory,
      status: "ok",
      copies,
      detail: `${distinct} across ${copies.length} cop${copies.length === 1 ? "y" : "ies"}`,
    });
  }

  /* The lock has to match the manifest, or provisioning installs a different REA. */
  const lockedRea = lock?.packages?.[""]?.dependencies?.["rea-agents"] ?? null;
  if (manifestPin && lockedRea !== manifestPin) {
    problems.push(
      `the lock pins rea-agents@${lockedRea ?? "nothing"} but the manifest pins ${manifestPin}; regenerate scripts/vendor-lock/package-lock.json`,
    );
  }

  /*
   * setup.mjs falls back to `npm install` with its own overrides when the lock
   * cannot be replayed. That path must not be able to resolve anything the audited
   * one would refuse, so the same floors are applied to it, and the two override
   * sets must name the same versions.
   */
  const declared = [];
  const fromSetup = setupSource ? parseOverrides(setupSource, "const CLOSURE_OVERRIDES") : null;
  const fromLockPackage = lockPackageSource ? parseOverrides(lockPackageSource, '"overrides"') : null;
  if (fromSetup) declared.push({ origin: "scripts/setup.mjs", overrides: fromSetup });
  if (fromLockPackage) declared.push({ origin: "vendor-lock/package.json", overrides: fromLockPackage });
  for (const { origin, overrides } of declared) {
    for (const advisory of ADVISORY_FLOORS) {
      const pinned = overrides[advisory.name];
      if (!pinned) continue;
      if (compareVersions(pinned, advisory.floor) < 0) {
        problems.push(`${origin} overrides ${advisory.name} to ${pinned}, below the ${advisory.floor} floor (${advisory.advisory})`);
      }
      const resolved = lockCopies(lock, advisory.name).map((copy) => copy.version);
      if (resolved.length > 0 && !resolved.every((version) => version === pinned)) {
        problems.push(
          `${origin} overrides ${advisory.name} to ${pinned} but the lock resolves ${[...new Set(resolved)].join(", ")}; the degraded install path would not match the audited one`,
        );
      }
    }
  }
  if (declared.length === 2) {
    for (const advisory of ADVISORY_FLOORS) {
      const [first, second] = declared.map((entry) => entry.overrides[advisory.name] ?? null);
      if (first !== second) {
        problems.push(`overrides disagree for ${advisory.name}: setup.mjs ${first ?? "unset"} vs vendor-lock/package.json ${second ?? "unset"}`);
      }
    }
  }

  return { ok: problems.length === 0, rows, problems, lockedRea };
}

/**
 * Reads a `{ name: "version", ... }` object out of JavaScript source or JSON text.
 *
 * setup.mjs is a script, not a module, so its override table is read as text; this
 * is deliberately tolerant (it only fails when a key of interest is unreadable).
 */
export function parseOverrides(source, anchor) {
  const objectStart = source.indexOf(anchor);
  if (objectStart < 0) return null;
  const braceAt = source.indexOf("{", objectStart + anchor.length);
  const braceEnd = source.indexOf("}", braceAt);
  if (braceAt < 0 || braceEnd < 0) return null;
  const body = source.slice(braceAt + 1, braceEnd);
  const overrides = {};
  // JSON form: "zod": "4.6.7"   |   JS form: zod: "4.6.7" (also '"key": "value"')
  for (const match of body.matchAll(/"?(?<name>[A-Za-z0-9@/._-]+)"?\s*:\s*"(?<version>[^"]+)"/g)) {
    overrides[match.groups.name] = match.groups.version;
  }
  return overrides;
}

/** The shipped lock, or a caller-supplied one. */
export function resolveLockPath(candidates) {
  const searched = candidates ?? [
    path.join(HERE, "vendor-lock", "package-lock.json"),
    path.join(PLUGIN_ROOT, "vendor-lock", "package-lock.json"),
  ];
  return searched.find((file) => existsSync(file)) ?? null;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("usage: node ./scripts/check-dependency-advisories.mjs [--lock <package-lock.json>] [--json]\n");
    return 0;
  }
  const lockFlag = argv.indexOf("--lock");
  const lockPath = lockFlag >= 0 ? path.resolve(argv[lockFlag + 1] ?? "") : resolveLockPath();
  if (!lockPath || !existsSync(lockPath)) {
    process.stderr.write(
      `dependency advisories: no lockfile at ${lockPath ?? "scripts/vendor-lock/package-lock.json"}\n` +
        "  the vendored closure is unverifiable without it; regenerate it with\n" +
        "  cd scripts/vendor-lock && npm install --package-lock-only --ignore-scripts\n",
    );
    return 2;
  }

  let lock;
  try {
    lock = readJson(lockPath);
  } catch (error) {
    process.stderr.write(`dependency advisories: ${lockPath} is not readable JSON: ${String(error?.message ?? error)}\n`);
    return 2;
  }

  const manifestPath = path.join(PLUGIN_ROOT, "manifest", "bundle.manifest.json");
  const manifestPin = existsSync(manifestPath) ? (readJson(manifestPath)?.pins?.reaAgents ?? null) : null;
  const setupPath = path.join(PLUGIN_ROOT, "scripts", "setup.mjs");
  const lockPackagePath = path.join(path.dirname(lockPath), "package.json");
  const verdict = evaluateAdvisories(lock, {
    manifestPin,
    setupSource: existsSync(setupPath) ? readFileSync(setupPath, "utf8") : null,
    lockPackageSource: existsSync(lockPackagePath) ? readFileSync(lockPackagePath, "utf8") : null,
  });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ lock: lockPath, manifestPin, ...verdict }, null, 2)}\n`);
    return verdict.ok ? 0 : 1;
  }

  const relative = path.relative(PLUGIN_ROOT, lockPath) || lockPath;
  process.stdout.write("dependency advisories — vendored REA closure\n");
  process.stdout.write(`  lock      ${relative} (lockfileVersion ${lock?.lockfileVersion ?? "?"}, ${Object.keys(lock?.packages ?? {}).length} entries)\n`);
  process.stdout.write(`  manifest  rea-agents@${manifestPin ?? "unpinned"}, lock pins ${verdict.lockedRea ?? "nothing"}\n`);
  for (const row of verdict.rows) {
    const label = row.status === "ok" ? "ok  " : row.status === "absent" ? "n/a " : "FAIL";
    process.stdout.write(`  ${label} ${row.name.padEnd(10)} ${row.detail}  [floor ${row.floor}, ${row.advisory}]\n`);
  }
  if (!verdict.ok) {
    for (const problem of verdict.problems) process.stderr.write(`FAIL ${problem}\n`);
    return 1;
  }
  process.stdout.write("ok: every advisory-affected package is at or above its fixed version\n");
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
