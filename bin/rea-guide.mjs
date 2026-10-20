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
 *   node bin/rea-guide.mjs --json
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
  return explicit !== '' ? explicit : join(homedir(), '.dsh')
}

/** Where setup.mjs records what it provisioned. */
export function defaultBundlePath(home = dshHome()) {
  return join(home, 'plugins', 'rea-bundle', 'bundle.json')
}

/** The exact command a user should run, quoted so a path with spaces survives. */
export function setupCommandFor(pluginRoot = PLUGIN_ROOT) {
  return `node "${join(pluginRoot, 'scripts', 'setup.mjs')}"`
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
  if (!want.includes('.')) return have.startsWith(`${want}.`)
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
    bundlePath = defaultBundlePath(),
    pluginRoot = PLUGIN_ROOT,
  } = options

  const base = {
    pluginVersion: String(pluginVersion),
    pinnedRea: String(pinnedRea),
    installedRea: null,
    provisionedAt: null,
    state: 'missing',
    needsSetup: true,
    bundlePath,
    setupCommand: setupCommandFor(pluginRoot),
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
  const bundleFlag = argv.indexOf('--bundle')
  const facts = localPackageFacts()
  const state = computeGuideState({
    pluginVersion: facts.pluginVersion,
    pinnedRea: facts.pinnedRea,
    ...(bundleFlag !== -1 && argv[bundleFlag + 1] ? { bundlePath: argv[bundleFlag + 1] } : {}),
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
