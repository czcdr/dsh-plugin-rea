#!/usr/bin/env node
/**
 * `npm run check-updates` — a portable entry for a Windows-only script.
 *
 * `check-updates.ps1` is a Windows PowerShell tool on purpose: it reads
 * `%APPDATA%\npm`, prefers a `rea.cmd` shim over `rea.ps1`, and walks the
 * profile the way the desktop app lays it out. On macOS/Linux even a working
 * `pwsh` would run those branches against paths that do not exist there, so
 * "make the .ps1 cross-platform" is not the fix — the honest answer is to say
 * so, and to name the two commands that DO work everywhere.
 *
 * This wrapper therefore:
 *   - on Windows: runs `powershell` (the 5.1 the script is written for), and
 *     falls back to `pwsh` when 5.1 is absent;
 *   - elsewhere: prints why, plus the portable equivalents, and exits non-zero
 *     so a CI step cannot mistake "not applicable" for "all green".
 *
 * Its pure parts are exported so a unit test can pin both branches without
 * spawning anything.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root: this file lives in <root>/scripts/. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * PowerShell executables to try, in order, for a platform.
 *
 * Empty on POSIX: the script's own probes are Windows-specific, so running it
 * there would produce a confident wrong answer instead of a clear "not here".
 */
export function powerShellCandidates(platform = process.platform) {
  return platform === 'win32' ? ['powershell', 'pwsh'] : []
}

/** The message used when this platform (or this machine) cannot run the script. */
export function unsupportedMessage(platform = process.platform) {
  const where = platform === 'win32'
    ? 'No PowerShell (powershell or pwsh) was found on this machine.'
    : `check-updates.ps1 is a Windows PowerShell tool; this host is ${platform}.`
  return [
    where,
    '',
    'The same questions, answered with commands that work on every platform:',
    '  node bin/rea-shim.mjs --shim-status     # provisioned bundle, launch choice, versions',
    '  node scripts/setup.mjs --dry-run        # what a setup run would still fetch',
    '',
    'On Windows, `npm run check-updates` also compares the installed versions',
    'against the upstream registries and the profile registration.',
  ].join('\n')
}

function main(argv) {
  const script = join(ROOT, 'check-updates.ps1')
  if (!existsSync(script)) {
    process.stderr.write(`check-updates: ${script} is missing from this package.\n`)
    return 1
  }

  const candidates = powerShellCandidates()
  if (candidates.length === 0) {
    process.stderr.write(`${unsupportedMessage()}\n`)
    return 1
  }

  const env = process.env
  const attempts = []
  for (const command of candidates) {
    const result = spawnSync(command, ['-NoProfile', '-File', script, ...argv], {
      stdio: 'inherit',
      cwd: ROOT,
      env,
      windowsHide: true,
    })
    if (result.error && result.error.code === 'ENOENT') {
      attempts.push(command)
      continue
    }
    if (result.error) {
      process.stderr.write(`check-updates: ${command} failed to start: ${result.error.message}\n`)
      return 1
    }
    return typeof result.status === 'number' ? result.status : 1
  }

  process.stderr.write(
    `check-updates: tried ${attempts.join(', ')} — none is on PATH.\n\n${unsupportedMessage()}\n`,
  )
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
