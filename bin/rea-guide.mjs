#!/usr/bin/env node
/**
 * Facts behind the one-shot "run setup" guide.
 *
 * The Web GUI needs three things the browser cannot know by itself:
 *
 *   - which version of THIS package is installed (the guide re-arms on upgrade),
 *   - which REA version the manifest pins,
 *   - which REA version the machine's bundle actually holds.
 *
 * The third one is the point. A plugin upgrade replaces the package and stops
 * there; `scripts/setup.mjs` is what moves the runtime to the new pin. So the
 * honest trigger is not "the page was never shown" but "the bundle on disk does
 * not match the pin this package ships". `computeGuideState` answers exactly
 * that, and stays a pure function of three values so it can be tested without a
 * harness, a browser or a provisioned bundle.
 *
 * `index.mjs` serves the result as GET /dsh-plugin-rea/guide-state; `client.js`
 * renders the guide once per plugin version. This file also runs standalone:
 *
 *   node bin/rea-guide.mjs --json [--bundle <bundle.json> | --root <dir>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Route served by index.mjs and read by client.js. One definition, two readers. */
export const GUIDE_ROUTE = '/dsh-plugin-rea/guide-state'

/** Package root (the parent of bin/), used to build a copy-pasteable command. */
export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Read a JSON file the way the shim and setup.mjs do.
 *
 * PowerShell 5.1's `>` and `Out-File` write UTF-16 LE by default, so a record a
 * user hand-edited can be UTF-16 while a record setup wrote is UTF-8. Treating
 * only UTF-8 as valid made a present bundle look absent, which is the same
 * silent re-provision the shim's reader had to be fixed for in 2.0.11.
 */
export function readJsonFile(file) {
  const bytes = readFileSync(file)
  if (bytes.length >= 2) {
    const [first, second] = bytes
    if (first === 0xff && second === 0xfe) {
      return JSON.parse(bytes.subarray(2).toString('utf16le'))
    }
    if (first === 0xfe && second === 0xff) {
      const swapped = Buffer.from(bytes.subarray(2))
      swapped.swap16()
      return JSON.parse(swapped.toString('utf16le'))
    }
  }
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return JSON.parse(text)
}

/** `$DSH_HOME` when set, otherwise the same `<home>/.dsh` fallback the shim uses. */
export function dshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return explicit !== '' ? resolve(explicit) : join(homedir(), '.dsh')
}

/**
 * The bundle root, by the same order scripts/setup.mjs (`defaultBundleRoot`),
 * bin/rea-shim.mjs (`bundleRoot`) and scripts/rea-bundle-bootstrap.ps1 use:
 * `REA_BUNDLE_ROOT` first, then `<DSH_HOME>/plugins/rea-bundle`.
 *
 * Reading only DSH_HOME here made a machine that provisions into a custom root
 * look `missing` to the guide — the one screen whose entire job is to decide
 * "does setup still have to run" — so it told an already-provisioned machine to
 * provision again. The guide must answer for the root the rest of the system
 * agrees on.
 */
export function bundleRoot(env = process.env) {
  const override = typeof env.REA_BUNDLE_ROOT === 'string' ? env.REA_BUNDLE_ROOT.trim() : ''
  return override !== '' ? resolve(override) : join(dshHome(env), 'plugins', 'rea-bundle')
}

/** Where setup.mjs records what it provisioned. */
export function defaultBundlePath(root = bundleRoot()) {
  return join(root, 'bundle.json')
}

/** Windows paths are case-insensitive; comparing `resolve`d strings is not. */
function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The exact command a user should run, quoted so a path with spaces survives.
 *
 * `--reuse` is not cosmetic. The guide appears mostly after an upgrade, when the
 * runtime is already on the machine: without the flag, setup re-fetches the
 * ~570 MB JDK + Ghidra pair even though the machine can answer for both, which is
 * both slow and the opposite of what "align the runtime" means. On a first
 * install the flag costs nothing — every candidate is probed, and a machine with
 * none downloads exactly as before.
 *
 * `--root` is added whenever the guide looked somewhere other than the default
 * `<DSH_HOME>/plugins/rea-bundle` (a `REA_BUNDLE_ROOT` override, or an explicit
 * `--bundle`/`--root`). Without it the copy-pasted command would provision the
 * default root and leave the one the guide just complained about untouched.
 */
export function setupCommandFor(pluginRoot = PLUGIN_ROOT, root = null) {
  const command = `node ${quotePath(join(pluginRoot, 'scripts', 'setup.mjs'))} --reuse`
  return root ? `${command} --root ${quotePath(root)}` : command
}

/** Quote a path so a copy-pasted command survives spaces and quotes. */
function quotePath(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

/**
 * Pin comparison, mirroring scripts/pin-match.ps1.
 *
 * A pin that carries a dot is a version: `6.7.0` matches only `6.7.0`.
 * A pin that is a bare major is a family: `21` also matches `21.0.12.1+1`.
 * The distinction exists because pins like `jdk: 21` legitimately resolve to a
 * patched build, while `reaAgents: 6.7.0` must not silently accept `6.7.0-rc.1`
 * or `6.5.0`.
 */
export function reaPinMatches(installed, pinned) {
  const have = String(installed ?? '').trim()
  const want = String(pinned ?? '').trim()
  if (have === '' || want === '') return false
  if (have === want) return true
  if (want.includes('.')) return false
  // A bare-major pin ("21") is a FLOOR, not a family prefix — the same rule
  // `scripts/setup.mjs` applies when it decides a recorded component still
  // satisfies the manifest. The prefix form accepted 21.0.12.1+1 and rejected
  // 25.0.5, so the guide said "stale, run setup" on a machine that setup had just
  // called "already provisioned (25.0.5) — major 25 satisfies the pin's major 21".
  const haveMajor = Number.parseInt(have.split('.')[0], 10)
  const wantMajor = Number.parseInt(want, 10)
  if (Number.isFinite(haveMajor) && Number.isFinite(wantMajor)) return haveMajor >= wantMajor
  return false
}

/**
 * Compute the guide's state.
 *
 * Returned `state`:
 *   - `missing`    no bundle.json — a first install that never ran setup
 *   - `unreadable` the file exists but cannot be parsed
 *   - `unknown`    parsed, but records no reaAgents version
 *   - `stale`      a REA version is recorded and it is not the pin
 *   - `ok`         recorded version matches the pin
 *
 * `needsSetup` is true for everything except `ok`: a guide that stays silent on
 * an unreadable record is a guide that hides the exact case it exists for.
 */
export function computeGuideState(options = {}) {
  const {
    pluginVersion = '',
    pinnedRea = '',
    bundleRoot: rootOption = null,
    bundlePath: bundlePathOption = null,
    pluginRoot = PLUGIN_ROOT,
  } = options

  // Resolve the root the way setup/shim/bootstrap do, then honour a path a caller
  // handed in directly (tests and `--bundle` pass a file, not a root).
  const root = rootOption ? resolve(rootOption) : bundleRoot()
  const bundlePath = bundlePathOption ? resolve(bundlePathOption) : defaultBundlePath(root)
  const rootInEffect = bundlePathOption ? dirname(bundlePath) : root
  // Only the default root needs no flag: setup.mjs resolves DSH_HOME itself, so
  // the command stays shorter there and identical to what it always printed.
  const setupRoot = samePath(rootInEffect, join(dshHome(), 'plugins', 'rea-bundle')) ? null : rootInEffect

  const base = {
    pluginVersion: String(pluginVersion),
    pinnedRea: String(pinnedRea),
    installedRea: null,
    provisionedAt: null,
    state: 'missing',
    needsSetup: true,
    bundleRoot: rootInEffect,
    bundlePath,
    setupCommand: setupCommandFor(pluginRoot, setupRoot),
    detail: '',
  }

  if (!existsSync(bundlePath)) {
    return { ...base, detail: 'no bundle.json on this machine' }
  }

  let record
  try {
    record = readJsonFile(bundlePath)
  } catch (error) {
    return {
      ...base,
      state: 'unreadable',
      detail: `bundle.json could not be read: ${error && error.message ? error.message : String(error)}`,
    }
  }

  const installed = record && record.versions ? record.versions.reaAgents : record && record.reaAgents
  const provisionedAt = record && typeof record.provisionedAt === 'string' ? record.provisionedAt : null

  if (typeof installed !== 'string' || installed.trim() === '') {
    return {
      ...base,
      provisionedAt,
      state: 'unknown',
      detail: 'bundle.json records no reaAgents version',
    }
  }

  const matched = reaPinMatches(installed, pinnedRea)
  return {
    ...base,
    installedRea: installed,
    provisionedAt,
    state: matched ? 'ok' : 'stale',
    needsSetup: !matched,
    detail: matched
      ? `bundle reaAgents ${installed} matches pin ${pinnedRea}`
      : `bundle reaAgents ${installed} does not match pin ${pinnedRea}`,
  }
}

/** Read this package's own version and REA pin, for the route and the CLI. */
export function localPackageFacts(pluginRoot = PLUGIN_ROOT) {
  const pkg = readJsonFile(join(pluginRoot, 'package.json'))
  let pinnedRea = ''
  try {
    const manifest = readJsonFile(join(pluginRoot, 'manifest', 'bundle.manifest.json'))
    pinnedRea = manifest && manifest.pins && typeof manifest.pins.reaAgents === 'string'
      ? manifest.pins.reaAgents
      : ''
  } catch {
    /* A missing manifest is the audit's problem, not the guide's. */
  }
  return { pluginVersion: pkg && typeof pkg.version === 'string' ? pkg.version : '', pinnedRea }
}

function main(argv) {
  const asJson = argv.includes('--json')
  const flagValue = (name) => {
    const index = argv.indexOf(name)
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null
  }
  // `--root` mirrors setup.mjs; `--bundle` names the record file itself and is
  // what the old CLI offered. Both are overrides of the same resolution chain.
  const bundlePath = flagValue('--bundle')
  const root = flagValue('--root')
  const facts = localPackageFacts()
  const state = computeGuideState({
    pluginVersion: facts.pluginVersion,
    pinnedRea: facts.pinnedRea,
    ...(bundlePath ? { bundlePath } : {}),
    ...(root ? { bundleRoot: root } : {}),
  })

  if (asJson) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }

  process.stdout.write([
    `plugin    ${state.pluginVersion}`,
    `pin       ${state.pinnedRea}`,
    `bundle    ${state.bundlePath}`,
    `state     ${state.state}${state.needsSetup ? ' (setup needed)' : ''}`,
    `reaAgents ${state.installedRea || '-'}`,
    state.provisionedAt ? `provisionedAt ${state.provisionedAt}` : '',
    '',
    state.needsSetup ? `run: ${state.setupCommand}` : 'nothing to do',
  ].filter((line) => line !== '').join('\n') + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
}
