#!/usr/bin/env node
/**
 * ghidra-gate-override — run a Ghidra release REA has not verified, on purpose.
 *
 * Why this exists
 *   REA ships `SUPPORTED_GHIDRA_VERSION` (dist/ghidra/GhidraReleasePolicy.js, inlined
 *   into the CLI and MCP bundles). A build outside that major.minor is reported as
 *   `unsupported` and the whole Ghidra family is withdrawn, even when the bridge
 *   compiles and analyses fine against the newer jars. On 2026-10-26 Ghidra 12.2 was
 *   measured to produce byte-identical segments, procedure inventory and `entry`
 *   pseudocode on a PE sample, so the block is upstream's *unverified*, not broken.
 *
 *   The release that fixes Ghidra 12.1.4's four CVEs is 12.2, so staying on 12.1.4 is
 *   a choice to keep an unpatched decompiler/loader in the chain. This script makes
 *   the opposite choice explicit, recorded and reversible — it never happens silently.
 *
 * What it changes
 *   Only the version constant inside the *vendored* rea-agents copy, and only for the
 *   files that declare it. Every original value — plus the SHA-256 of each original
 *   file — is written to <root>/ghidra-gate-override.json BEFORE the first byte is
 *   patched, so an interrupted run is recoverable and --disable can prove it restored
 *   exactly what was there. A patch that fails partway through rolls back the files it
 *   already wrote and says so.
 *
 * What it does NOT do
 *   It does not verify the new release for you. Everything REA's own gate would have
 *   protected against — bridge API drift, decompiler-hook drift, non-PE loaders — is
 *   now your risk. Re-running `setup.mjs` re-provisions rea-agents and removes the
 *   patch, which puts the bundle back on the pinned, verified release.
 *
 * Usage
 *   node scripts/ghidra-gate-override.mjs --status [--root <dir>]
 *   node scripts/ghidra-gate-override.mjs --enable --version 12.2 [--root <dir>]
 *   node scripts/ghidra-gate-override.mjs --disable [--root <dir>]
 *
 *   The root is `--root`, else REA_BUNDLE_ROOT, else <DSH_HOME>/plugins/rea-bundle,
 *   else <home>/.dsh/plugins/rea-bundle — the same chain setup.mjs, the shim and
 *   scripts/rea-bundle-bootstrap.ps1 use.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CONSTANT = "SUPPORTED_GHIDRA_VERSION";
const RECORD = "ghidra-gate-override.json";

function parseArgs(argv) {
  const out = { mode: "status", version: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--enable") out.mode = "enable";
    else if (arg === "--disable") out.mode = "disable";
    else if (arg === "--status") out.mode = "status";
    else if (arg === "--version") out.version = argv[++i] ?? null;
    else if (arg === "--root") out.root = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") out.mode = "help";
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/**
 * Same root rule as scripts/setup.mjs, bin/rea-shim.mjs and
 * scripts/rea-bundle-bootstrap.ps1: `--root`, then REA_BUNDLE_ROOT, then
 * <DSH_HOME>/plugins/rea-bundle, then <home>/.dsh/plugins/rea-bundle.
 *
 * REA_BUNDLE_ROOT used to be ignored here, so on a machine that provisions into
 * a custom root `--status` (and every patch) silently addressed the default
 * root: either "no vendored REA" or — worse — a different installation.
 */
function defaultRoot() {
  const override = process.env.REA_BUNDLE_ROOT;
  if (override && override.trim() !== "") return path.resolve(override);
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? path.resolve(process.env.DSH_HOME) : null;
  if (home) return path.join(home, "plugins", "rea-bundle");
  const profile = process.env.USERPROFILE || (process.env.HOMEDRIVE ?? "") + (process.env.HOMEPATH ?? "") || process.env.HOME;
  return path.join(profile || homedir(), ".dsh", "plugins", "rea-bundle");
}

/** Case-insensitive on Windows, where two spellings can name one directory. */
function within(base, target) {
  const norm = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const from = norm(base);
  const to = norm(target);
  return to === from || to.startsWith(from + path.sep);
}

/**
 * Resolve one record-supplied path inside the bundle, refusing escapes.
 *
 * The record is written by this script, but it lives in a directory the user can
 * edit and a half-finished restore can mangle, and `--disable` joined
 * `entry.file` straight onto the vendor root: a `"file": "../../../elsewhere"`
 * entry would have made this script rewrite a file outside the bundle. Local
 * write access is still required, so this is containment, not a remote escape.
 */
function containedPath(baseDir, relative, label) {
  if (typeof relative !== "string" || relative.trim() === "") {
    throw new Error(`${label} names no file`);
  }
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relative);
  if (!within(base, target)) {
    throw new Error(`${label} escapes ${base} (${relative}); refusing to touch it`);
  }
  // Resolve every segment by hand so a symlinked directory cannot carry the
  // target outside the bundle after the string check above passed.
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep)) {
    if (segment === "") continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      break; // absent: the caller's existsSync decides what that means
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} goes through the symbolic link ${current}; refusing to follow it`);
    }
  }
  return target;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

function readJson(file) {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

/** Every file in the vendored REA that declares the constant, with its value. */
function findDeclarations(vendorRoot) {
  const found = [];
  for (const file of walk(vendorRoot)) {
    const text = readFileSync(file, "utf8");
    const match = new RegExp(`${CONSTANT}\\s*=\\s*"([^"]+)"`).exec(text);
    if (match) found.push({ file, value: match[1] });
  }
  return found;
}

function replaceValue(file, from, to) {
  const text = readFileSync(file, "utf8");
  const pattern = new RegExp(`(${CONSTANT}\\s*=\\s*)"${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const next = text.replace(pattern, `$1"${to}"`);
  if (next === text) throw new Error(`${path.basename(file)} did not contain ${CONSTANT} = "${from}"`);
  writeFileSync(file, next, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log("node scripts/ghidra-gate-override.mjs --status | --enable --version <x.y[.z]> | --disable [--root <dir>]");
    return;
  }

  const root = args.root ? path.resolve(args.root) : defaultRoot();
  const vendor = path.join(root, "vendor", "node_modules", "rea-agents");
  const record = path.join(root, RECORD);
  if (!existsSync(vendor)) throw new Error(`no vendored REA at ${vendor} — run scripts/setup.mjs first`);

  const declarations = findDeclarations(vendor);
  if (declarations.length === 0) throw new Error(`none of the ${CONSTANT} declarations were found under ${vendor}`);
  const values = [...new Set(declarations.map((entry) => entry.value))];
  const active = existsSync(record) ? readJson(record) : null;

  if (args.mode === "status") {
    console.log(
      JSON.stringify(
        {
          root,
          vendoredRea: vendor,
          declarations: declarations.map((entry) => ({
            file: path.relative(vendor, entry.file),
            value: entry.value,
          })),
          override: active,
          state: active ? `overridden → ${values.join(", ")}` : `upstream gate (${values.join(", ")})`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.mode === "disable") {
    if (!active) {
      console.log("no override is recorded; nothing to restore");
      return;
    }
    let restored = 0;
    let stale = 0;
    for (const entry of active.files) {
      // `entry.file` comes out of a JSON file, not out of the vendor tree: keep
      // every restore inside the bundle (no `..`, no symlinks) before touching it.
      const file = containedPath(vendor, entry.file, `record entry ${JSON.stringify(entry.file)}`);
      if (!existsSync(file)) {
        stale += 1;
        continue;
      }
      const text = readFileSync(file, "utf8");
      const patchedPattern = new RegExp(`${CONSTANT}\\s*=\\s*"${entry.patched.replace(/\./g, "\\.")}"`);
      if (patchedPattern.test(text)) {
        replaceValue(file, entry.patched, entry.original);
        if (typeof entry.originalSha256 === "string") {
          const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
          if (digest !== entry.originalSha256) {
            throw new Error(
              `${entry.file} was restored but does not match the recorded original hash (${digest}); ` +
                "the file changed outside this script — inspect it before restoring the rest",
            );
          }
        }
        restored += 1;
      } else if (new RegExp(`${CONSTANT}\\s*=\\s*"${entry.original.replace(/\./g, "\\.")}"`).test(text)) {
        stale += 1;
      } else {
        throw new Error(`${entry.file} declares neither ${entry.patched} nor ${entry.original}; inspect it before restoring`);
      }
    }
    unlinkSync(record);
    console.log(
      `restored ${CONSTANT} = "${active.originalVersion}" in ${restored} file(s)` +
        (stale > 0 ? `; ${stale} file(s) had already been replaced by a re-provision` : "") +
        "; override record removed",
    );
    return;
  }

  // enable
  const version = args.version;
  if (!version || !/^\d+\.\d+(\.\d+)?$/.test(version)) {
    throw new Error("--version must look like 12.2 or 12.2.1");
  }
  if (values.includes(version)) {
    console.log(`already ${version} — nothing to do`);
    return;
  }
  if (active) {
    // A record that says its own rollback failed describes files that are still
    // patched. It must not be mistaken for the "stale record" case below, which
    // unlinks it: that would strand those files with no record of their originals.
    if (active.status === "rollback-failed") {
      throw new Error(
        `${record} records a patch that could not be rolled back; run --disable to finish restoring before enabling again`,
      );
    }
    // Re-provisioning rea-agents replaces the tree, so a record can outlive the patch
    // it describes. That stale record must not block the next --enable, and it must
    // not be trusted by --disable either: judge it by the files on disk.
    const stillApplied = active.files.every((entry) => {
      const file = containedPath(vendor, entry.file, `record entry ${JSON.stringify(entry.file)}`);
      if (!existsSync(file)) return false;
      const text = readFileSync(file, "utf8");
      return new RegExp(`${CONSTANT}\\s*=\\s*"${entry.patched.replace(/\./g, "\\.")}"`).test(text);
    });
    if (stillApplied) {
      throw new Error(`an override is already recorded (→ ${active.requestedVersion}); run --disable first`);
    }
    console.log(`previous record is stale (rea-agents was re-provisioned); replacing it`);
    unlinkSync(record);
  }

  // Record every original BEFORE the first write to a vendored file: a failure
  // halfway through used to leave patched files that no record described, and a
  // record written afterwards cannot describe a process that died mid-loop.
  const originals = declarations.map((entry) => {
    const bytes = readFileSync(entry.file);
    return {
      file: path.relative(vendor, entry.file),
      absolute: entry.file,
      original: entry.value,
      patched: version,
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  });
  const bundle = existsSync(path.join(root, "bundle.json")) ? readJson(path.join(root, "bundle.json")) : null;
  const payload = {
    schema: 2,
    requestedVersion: version,
    originalVersion: values.length === 1 ? values[0] : values.join(","),
    files: originals.map(({ file, original, patched: patchedValue, originalSha256 }) => ({
      file,
      original,
      patched: patchedValue,
      originalSha256,
    })),
    ghidraPath: bundle?.paths?.ghidra ?? null,
    enabledAt: new Date().toISOString(),
    status: "patching",
    warning:
      "REA did not verify this Ghidra release. The gate existed because the bridge is only tested against the pinned one; re-running setup.mjs re-provisions rea-agents and removes this patch.",
  };
  // A crash between here and the final write still leaves a complete, verifiable
  // description of what must be put back.
  writeFileSync(record, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const patched = [];
  try {
    for (const entry of originals) {
      replaceValue(entry.absolute, entry.original, version);
      patched.push(entry);
    }
    // Read back: the whole point is that the gate now reads a value REA accepts.
    for (const entry of originals) {
      const text = readFileSync(entry.absolute, "utf8");
      if (!new RegExp(`${CONSTANT}\\s*=\\s*"${version.replace(/\./g, "\\.")}"`).test(text)) {
        throw new Error(`readback failed for ${entry.file}`);
      }
    }
  } catch (error) {
    const failed = [];
    for (const entry of patched) {
      try {
        writeFileSync(entry.absolute, entry.bytes);
      } catch (rollbackError) {
        failed.push(`${entry.file}: ${rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const reason = error && error.message ? error.message : String(error);
    if (failed.length > 0) {
      // Keep the record: it still names every original value and hash, so a
      // `--disable` can finish the restore this run could not.
      writeFileSync(
        record,
        `${JSON.stringify({ ...payload, status: "rollback-failed", rollbackErrors: failed }, null, 2)}\n`,
        "utf8",
      );
      throw new Error(
        `patch failed (${reason}); ${patched.length - failed.length} file(s) rolled back, ` +
          `${failed.length} could not be restored (see ${record}) — run --disable`,
      );
    }
    unlinkSync(record);
    throw new Error(`patch failed (${reason}); rolled back ${patched.length} file(s), nothing left changed`);
  }
  writeFileSync(record, `${JSON.stringify({ ...payload, status: "applied" }, null, 2)}\n`, "utf8");
  console.log(`patched ${originals.length} file(s) → ${CONSTANT} = "${version}"`);
  console.log(`recorded ${record}`);
  console.log("restart dsh (or reload the profile) so the MCP row reconnects");
}

try {
  main();
} catch (error) {
  console.error(`ghidra-gate-override: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
