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
foreach ($f in @('bin\rea-shim.mjs','scripts\setup.mjs','scripts\audit-manifest.mjs','scripts\setup.test.mjs')) {
  $out = & node --check $f 2>&1
  Check $f ($LASTEXITCODE -eq 0) ($out -join ' ')
}

Write-Host "`n=== 2. PowerShell parse + BOM ===" -ForegroundColor Cyan
foreach ($f in @('check-updates.ps1','assets\make-screenshots.ps1','scripts\rea-bundle-bootstrap.ps1')) {
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
foreach ($entry in @('bin/', 'scripts/', 'manifest/', 'cordis.patch.yml')) {
  Check "files[] includes $entry" (@($pkg.files) -contains $entry) ''
}
foreach ($script in @('bundle:setup', 'bundle:status', 'bundle:audit', 'bundle:test')) {
  Check "scripts.$script exists" ($pkg.scripts.PSObject.Properties.Name -contains $script) ''
}

Write-Host "`n=== 7. dry-run still plans the whole chain ===" -ForegroundColor Cyan
$env:REA_BUNDLE_ROOT = Join-Path $env:TEMP 'rea-verify-dryrun'
$dry = & node scripts\setup.mjs --root $env:REA_BUNDLE_ROOT --reuse --dry-run 2>&1
$planned = @($dry | Select-String -Pattern '^\[plan\]').Count
Check 'dry-run exits 0' ($LASTEXITCODE -eq 0) (($dry | Select-Object -Last 3) -join ' ')
Check 'dry-run plans every component' ($planned -ge 4) "planned=$planned"
Remove-Item Env:\REA_BUNDLE_ROOT -ErrorAction SilentlyContinue

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green }
else { Write-Host "$fail CHECK(S) FAILED" -ForegroundColor Red }
exit $fail
