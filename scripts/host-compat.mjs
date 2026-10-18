#!/usr/bin/env node
/**
 * host-compat — does the range this package declares cover the DSH releases it
 * claims to support?
 *
 * `package.json` carries `engines.dsh`, and that single string is what the
 * plugin market reads to say "compatible" instead of "unknown" (the market's
 * `deriveHostCompatibility` treats `engines.dsh` as a host declaration and
 * checks it against the running host version). A declaration is therefore load
 * bearing twice over: it decides whether the market HIDES this plugin from users
 * on a matching host, and it decides whether users on a host we never tested are
 * told it works.
 *
 * The two ways it goes wrong are silent. A typo makes the range unparseable, and
 * the market then reports `unknown` — a plugin that looks undeclared rather than
 * mis-declared. A floor that drifted (say `>=0.2.0`) silently drops hosts the
 * README still promises. Neither shows up as a test failure unless something
 * compares the STRING to the release list, which is what this file does.
 *
 * `HOST_RELEASES` is the dsh release line this package is built against, newest
 * first, as published on github.com/deepseek-ai/deepseek-harness. It is a
 * literal list rather than a GitHub query on purpose: a check that needs the
 * network fails on a plane and passes on a total outage, which is the wrong
 * shape for a gate. When a release is added upstream, add it here too — that
 * edit is the reminder to re-check the row against the new host.
 *
 * Usage: `node scripts/host-compat.mjs` (exit 0 = every listed release is
 * covered by the declared range; exit 1 = at least one is not).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')

/**
 * Every dsh release this bundle is checked against, newest first.
 *
 * Taken from the release list of github.com/deepseek-ai/deepseek-harness. The
 * floor is the oldest release the plugin has been adapted to; everything above
 * it up to the declared ceiling must keep working, so a release that is missing
 * here is a release nobody checked.
 */
export const HOST_RELEASES = [
  '0.2.1-rc.2',
  '0.2.1-rc.1',
  '0.2.1-alpha.5',
  '0.2.1-alpha.4',
  '0.2.1-alpha.3',
  '0.2.1-alpha.2',
  '0.2.1-alpha.1',
  '0.2.0-rc.2',
  '0.2.0-rc.1',
  '0.1.7-rc.2',
]

/** Hosts that must fall OUTSIDE the declaration, for the other direction. */
export const OUTSIDE_HOSTS = [
  '0.3.0',
  '0.1.7-rc.1',
  '0.1.7-alpha.2',
]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Split a version into comparable parts.
 * @param {string} version - a plain semver string, no range operators.
 * @returns {{ parts: number[], pre: (string|number)[] } | null} null when unparseable.
 */
export function parseVersion(version) {
  const match = SEMVER.exec(version.trim())
  if (match === null) return null
  const pre = match[4] === undefined
    ? []
    : match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre }
}

/**
 * Compare two versions the way semver does, prerelease included.
 *
 * A prerelease sorts BELOW its release (`0.2.0-rc.2 < 0.2.0`), and among
 * prereleases an identifier that is numeric sorts below one that is not, which
 * is why `0.2.1-alpha.5 < 0.2.1-rc.1` — the whole reason this file cannot lean
 * on a numeric comparison.
 * @returns -1, 0 or 1; NaN-free because unparseable input throws.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null) throw new Error(`not a version: ${a}`)
  if (right === null) throw new Error(`not a version: ${b}`)
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = typeof l === 'number'
    const rNum = typeof r === 'number'
    if (lNum && rNum) return l < r ? -1 : 1
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (lNum !== rNum) return lNum ? -1 : 1
    return String(l) < String(r) ? -1 : 1
  }
  return 0
}

/**
 * Evaluate one `>=floor <ceiling` declaration (the only shape this package
 * ships, and the shape the market's `engines.dsh` is compared with).
 *
 * Deliberately narrow: a wider parser here could disagree with the market's
 * semver implementation on a range the manifest would then be trusted for. If a
 * future declaration needs `||` or `^`, this function has to grow with it.
 * @param {string} version - host version to test.
 * @param {string} range - the declared range.
 * @returns {boolean} whether the host is inside the declaration.
 */
export function satisfiesDeclaredRange(version, range) {
  const match = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim())
  if (match === null) throw new Error(`unsupported host range: ${range}`)
  return compareVersions(version, match[1]) >= 0 && compareVersions(version, match[2]) < 0
}

/**
 * The host range this repository declares, `engines.dsh`.
 * @param {string} [root] - repository root, for tests.
 * @returns {string | null} the declared range, or null when absent.
 */
export function declaredHostRange(root = REPO_ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const value = pkg?.engines?.dsh
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Every release covered by the declaration, and every version that must not be.
 * @param {string} range - declared host range.
 * @returns {{ covered: string[], uncovered: string[], leaked: string[] }} findings.
 */
export function checkHostCoverage(range) {
  const covered = []
  const uncovered = []
  for (const version of HOST_RELEASES) {
    if (satisfiesDeclaredRange(version, range)) covered.push(version)
    else uncovered.push(version)
  }
  const leaked = OUTSIDE_HOSTS.filter(version => satisfiesDeclaredRange(version, range))
  return { covered, uncovered, leaked }
}

function main() {
  const range = declaredHostRange()
  if (range === null) {
    console.error('FAIL: package.json declares no engines.dsh — the market would report this plugin as "unknown"')
    process.exit(1)
  }
  let result
  try {
    result = checkHostCoverage(range)
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    process.exit(1)
  }
  console.log(`engines.dsh = ${range}`)
  for (const version of HOST_RELEASES) {
    const inside = satisfiesDeclaredRange(version, range)
    console.log(`  ${inside ? 'ok  ' : 'MISS'} ${version}`)
  }
  for (const version of OUTSIDE_HOSTS) {
    const inside = satisfiesDeclaredRange(version, range)
    console.log(`  ${inside ? 'LEAK' : 'ok  '} ${version} (must stay outside)`)
  }
  if (result.uncovered.length > 0) {
    console.error(`FAIL: the declaration does not cover ${result.uncovered.join(', ')}`)
    process.exit(1)
  }
  if (result.leaked.length > 0) {
    console.error(`FAIL: the declaration also admits ${result.leaked.join(', ')}, which is not a tested host`)
    process.exit(1)
  }
  console.log(`host range ok: ${HOST_RELEASES.length} releases covered, ${OUTSIDE_HOSTS.length} correctly outside`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
