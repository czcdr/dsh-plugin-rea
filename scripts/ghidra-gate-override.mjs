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
 *   files that declare it. Original values are recorded in <root>/ghidra-gate-override.json
 *   so --disable restores them exactly.
 *
 * What it does NOT do
 *   It does not verify the new release for you. Everything REA's own gate would have
 *   protected against — bridge API drift, decompiler-hook drift, non-PE loaders — is
 *   now your risk. Re-running `setup.mjs` re-provisions rea-agents and removes the
 *   patch, which puts the bundle back on the pinned, verified release.
 *
 * Usage
 *   node scripts/ghidra-gate-override.mjs --status
 *   node scripts/ghidra-gate-override.mjs --enable --version 12.2 [--root <dir>]
 *   node scripts/ghidra-gate-override.mjs --disable [--root <dir>]
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Same root rule as setup.mjs and the shim: DSH_HOME, else <home>/.dsh. */
function defaultRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : null;
  if (home) return path.join(home, "plugins", "rea-bundle");
  const profile = process.env.USERPROFILE || (process.env.HOMEDRIVE ?? "") + (process.env.HOMEPATH ?? "") || process.env.HOME;
  return path.join(profile || homedir(), ".dsh", "plugins", "rea-bundle");
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
    for (const entry of active.files) {
      replaceValue(path.join(vendor, entry.file), entry.patched, entry.original);
    }
    unlinkSync(record);
    console.log(`restored ${CONSTANT} = "${active.originalVersion}" in ${active.files.length} file(s); override record removed`);
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
  if (active) throw new Error(`an override is already recorded (→ ${active.requestedVersion}); run --disable first`);

  const files = [];
  for (const entry of declarations) {
    const relative = path.relative(vendor, entry.file);
    replaceValue(entry.file, entry.value, version);
    files.push({ file: relative, original: entry.value, patched: version });
  }
  // Read back: the whole point is that the gate now reads a value REA accepts.
  for (const entry of files) {
    const text = readFileSync(path.join(vendor, entry.file), "utf8");
    if (!new RegExp(`${CONSTANT}\\s*=\\s*"${version.replace(/\./g, "\\.")}"`).test(text)) {
      throw new Error(`readback failed for ${entry.file}`);
    }
  }
  const bundle = existsSync(path.join(root, "bundle.json")) ? readJson(path.join(root, "bundle.json")) : null;
  const payload = {
    schema: 1,
    requestedVersion: version,
    originalVersion: values.length === 1 ? values[0] : values.join(","),
    files,
    ghidraPath: bundle?.paths?.ghidra ?? null,
    enabledAt: new Date().toISOString(),
    warning:
      "REA did not verify this Ghidra release. The gate existed because the bridge is only tested against the pinned one; re-running setup.mjs re-provisions rea-agents and removes this patch.",
  };
  writeFileSync(record, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`patched ${files.length} file(s) → ${CONSTANT} = "${version}"`);
  console.log(`recorded ${record}`);
  console.log("restart dsh (or reload the profile) so the MCP row reconnects");
}

try {
  main();
} catch (error) {
  console.error(`ghidra-gate-override: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
