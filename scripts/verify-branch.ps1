# verify-branch.ps1 — one-shot structural verification of the bundle branch.
# Read-only: parses, audits and unit-tests; it does not provision anything.
# Run from the branch root:  powershell -NoProfile -File scripts\verify-branch.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$fail = 0
function Check($name, [bool]$ok, $detail) {
  if ($ok) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { Write-Host ("  FAIL  " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}

Write-Host "`n=== 1. JS syntax ===" -ForegroundColor Cyan
foreach ($f in @('index.mjs','bin\rea-shim.mjs','scripts\setup.mjs','scripts\audit-manifest.mjs','scripts\setup.test.mjs','scripts\host-compat.mjs')) {
  $out = & node --check $f 2>&1
  Check $f ($LASTEXITCODE -eq 0) ($out -join ' ')
}

Write-Host "`n=== 2. PowerShell parse + BOM ===" -ForegroundColor Cyan
# This script checks itself too: it is edited as often as the others, and an editor
# that drops the BOM would otherwise go unnoticed until someone adds CJK text here.
foreach ($f in @('check-updates.ps1','assets\make-screenshots.ps1','scripts\rea-bundle-bootstrap.ps1','scripts\verify-branch.ps1')) {
  $p = Join-Path $root $f
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $bom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs) | Out-Null
  $count = @($errs).Count
  Check "$f parses" ($count -eq 0) "$count error(s): $(($errs | Select-Object -First 1).Message)"
  if ($f -ne 'scripts\rea-bundle-bootstrap.ps1') {
    # These two carry CJK text, which PowerShell 5.1 misreads without a BOM.
    Check "$f has UTF-8 BOM" $bom "first bytes: $(($bytes[0..2] | ForEach-Object { $_.ToString('x2') }) -join ' ')"
  }
}

Write-Host "`n=== 3. manifest audit ===" -ForegroundColor Cyan
$audit = & node scripts\audit-manifest.mjs 2>&1
$audit | ForEach-Object { Write-Host "        $_" -ForegroundColor Gray }
Check 'audit clean' ($LASTEXITCODE -eq 0) 'see findings above'

Write-Host "`n=== 4. unit tests ===" -ForegroundColor Cyan
$tests = & node --test scripts\setup.test.mjs 2>&1
$testExit = $LASTEXITCODE
$failing = @($tests | Select-String -Pattern 'not ok' ).Count
Check 'node --test' ($testExit -eq 0) "$failing failing"

Write-Host "`n=== 5. the published patch is machine-path-free and escape-safe ===" -ForegroundColor Cyan
$patch = Get-Content (Join-Path $root 'cordis.patch.yml') -Raw
Check 'no drive letter in patch' (-not ($patch -match '[A-Za-z]:[\\/]')) 'a machine path leaked into the published patch'
Check 'no backslash escape in JS literals' (-not ($patch -replace '(?m)^\s*#.*$','' -match '\\[prbnt]')) 'use forward slashes'
Check 'references rea-shim.mjs' ($patch -match 'rea-shim\.mjs') ''
Check 'has a DSH_HOME fallback' (($patch -match 'DSH_HOME') -and ($patch -match 'USERPROFILE|HOME')) ''
$jsProbe = Join-Path $env:TEMP 'rea-verify-literals.cjs'
@'
const fs = require("node:fs");
const text = fs.readFileSync("cordis.patch.yml", "utf8").replace(/^\s*#.*$/gm, "");
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const literals = [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => {
  try { return new Function("return '" + m[1] + "'")(); } catch { return m[1]; }
});
const bad = literals.filter((v) => control.test(v));
console.log("literals: " + JSON.stringify(literals));
if (bad.length) {
  console.error("control characters in: " + bad.map((v) => JSON.stringify(v)).join(", "));
  process.exit(1);
}
'@ | Set-Content $jsProbe -Encoding utf8
& node $jsProbe 2>&1 | ForEach-Object { Write-Host "        $_" -ForegroundColor Gray }
Check 'evaluated literals contain no control characters' ($LASTEXITCODE -eq 0) 'see above'

Write-Host "`n=== 6. package payload lists what the bundle needs ===" -ForegroundColor Cyan
# -Encoding UTF8 is required: the package description contains CJK text, and
# PowerShell 5.1 reads a BOM-less file as ANSI, which breaks ConvertFrom-Json.
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in @('index.mjs', 'bin/', 'scripts/', 'manifest/', 'cordis.patch.yml')) {
  Check "files[] includes $entry" (@($pkg.files) -contains $entry) ''
}
# The market's update path asks whether package.json's main/exports points at a
# file that exists, and rolls the update back when it does not (dshmarket's
# hasLoadableEntry). This package declared neither until 2.0.5, so every update of
# a healthy profile failed with "updated build has no loadable entry". Asserting
# the pointer resolves keeps that from returning silently.
Check 'package.json declares main' (-not [string]::IsNullOrWhiteSpace($pkg.main)) ''
Check 'main resolves to a shipped file' ($pkg.main -and (Test-Path (Join-Path $root $pkg.main))) "main=$($pkg.main)"
# The market decides "compatible" vs "unknown" from engines.dsh, and hides the
# plugin from hosts whose version does not match. An absent or unparseable
# declaration therefore reads as "nothing to say" rather than as a defect, which
# is why the coverage check runs here as well as in CI.
Check 'package.json declares engines.dsh' (-not [string]::IsNullOrWhiteSpace($pkg.engines.dsh)) ''
$compat = & node scripts\host-compat.mjs 2>&1
Check 'engines.dsh covers every released DSH host' ($LASTEXITCODE -eq 0) (($compat | Select-Object -Last 2) -join ' ')
# Both READMEs quote the range verbatim, and a stale quote is invisible: JSON,
# host-compat and the audit all agree while the sentence a human reads names a
# different ceiling. That is exactly how `<0.3.0` survived in the docs after the
# declaration moved to `<0.3.0-0`, so the comparison lives here now.
foreach ($doc in @('README.md', 'README.zh-CN.md')) {
  $text = Get-Content (Join-Path $root $doc) -Raw -Encoding UTF8
  Check "$doc quotes the declared engines.dsh" $text.Contains([string]$pkg.engines.dsh) "expected $($pkg.engines.dsh)"
  # The pin example is copy-pasteable, so it must name a ref that will exist: the
  # version this tree publishes. It has drifted twice (v2.0.0 long after 2.0.5,
  # then v2.0.8 while the tree was 2.0.9), and both times every other signal was
  # green because nothing compared the two.
  Check "$doc pins the current version" $text.Contains("dsh-plugin-rea#v$($pkg.version)") "expected dsh-plugin-rea#v$($pkg.version)"
}
foreach ($script in @('bundle:setup', 'bundle:status', 'bundle:audit', 'bundle:test', 'bundle:host-compat')) {
  Check "scripts.$script exists" ($pkg.scripts.PSObject.Properties.Name -contains $script) ''
}

Write-Host "`n=== 7. dry-run still plans the whole chain ===" -ForegroundColor Cyan
$env:REA_BUNDLE_ROOT = Join-Path $env:TEMP 'rea-verify-dryrun'
# Deliberately WITHOUT --reuse. Adoption of whatever this machine happens to have
# installed used to hide a defect that only a bare machine sees: every planned
# component returned `{ planned: true }` with no path, so the dependents of each
# plan entry were reported as "required component is unavailable" and the command
# exited 1 — for the exact reader the README sends to `--dry-run`.
$dry = & node scripts\setup.mjs --root $env:REA_BUNDLE_ROOT --dry-run 2>&1
$planned = @($dry | Select-String -Pattern '^\[plan\]').Count
$unmet = @($dry | Select-String -Pattern 'is unavailable').Count
Check 'dry-run exits 0 without --reuse' ($LASTEXITCODE -eq 0) (($dry | Select-Object -Last 3) -join ' ')
Check 'dry-run plans every component' ($planned -ge 4) "planned=$planned"
Check 'dry-run reports no unavailable dependency' ($unmet -eq 0) "unavailable=$unmet"
Remove-Item Env:\REA_BUNDLE_ROOT -ErrorAction SilentlyContinue

Write-Host "`n=== 8. bootstrap recognises an unpacked portable Node (no download) ===" -ForegroundColor Cyan
# A machine with no Node is this script's entire audience, so the portable path is
# only ever exercised where it is least observable: it must therefore be tested
# here, with an empty PATH and a stack laid out exactly as the official zip lays it
# out. The folder name is derived from the manifest by a SINGLE extension strip
# (node-v24.21.0-win-x64.zip -> node-v24.21.0-win-x64); a double strip used to make
# the bootstrap throw "the Node zip did not contain node-v24.21" after a successful
# download, checksum and extraction. -DryRun keeps this check download-free.
$bootRoot = Join-Path $env:TEMP 'rea-verify-bootstrap'
# -Encoding UTF8: the manifest carries non-ASCII text and PowerShell 5.1 would
# otherwise read a BOM-less file as ANSI and fail ConvertFrom-Json.
$manifest = Get-Content (Join-Path $root 'manifest\bundle.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bootLayoutName = [System.IO.Path]::GetFileNameWithoutExtension(
  [System.IO.Path]::GetFileName(([uri]$manifest.components.node.sources.'win32-x64'.url).AbsolutePath))
$bootLayout = Join-Path (Join-Path $bootRoot 'stack') $bootLayoutName
New-Item -ItemType Directory -Path $bootLayout -Force | Out-Null
$hostNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($hostNode) {
  $target = Join-Path $bootLayout 'node.exe'
  if (Test-Path $target) { Remove-Item $target -Force }
  try { New-Item -ItemType HardLink -Path $target -Target $hostNode -ErrorAction Stop | Out-Null }
  catch { Copy-Item $hostNode $target -Force }
}
$bootOut = & powershell -NoProfile -Command "`$env:PATH='C:\Windows\System32;C:\Windows'; & '$root\scripts\rea-bundle-bootstrap.ps1' -Root '$bootRoot' -Reuse -DryRun" 2>&1
Check 'bootstrap finds the portable Node in the official layout' (@($bootOut | Select-String 'portable Node present').Count -ge 1) (($bootOut | Select-Object -Last 2) -join ' ')
Check 'bootstrap plans no download when one is present' (@($bootOut | Select-String 'plan: download').Count -eq 0) (@($bootOut | Select-String 'plan:').Line -join ' | ')
for ($i = 0; $i -lt 5; $i++) {
  try { Remove-Item -Recurse -Force $bootRoot -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 300 }
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green }
else { Write-Host "$fail CHECK(S) FAILED" -ForegroundColor Red }
exit $fail
