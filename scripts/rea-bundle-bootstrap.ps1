# rea-bundle-bootstrap.ps1 — get from "no Node at all" to a provisioned bundle.
#
# Why this exists: setup.mjs is written in Node, so a machine with no Node
# cannot run it. This script uses only PowerShell + Expand-Archive (no
# downloads other than the official Node.js zip and then the components), gets a
# portable Node, and hands the rest to scripts/setup.mjs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\rea-bundle-bootstrap.ps1
#
# Options:
#   -Root <dir>     bundle root (default: $env:DSH_HOME\plugins\rea-bundle,
#                   falling back to ~\.dsh\plugins\rea-bundle)
#   -Reuse          adopt an existing Ghidra/JDK instead of downloading them
#   -DryRun         print the plan and stop
#
# Nothing is installed system-wide and no registry key is touched: the runtime
# is unpacked next to the bundle and used from there.

[CmdletBinding()]
param(
  [string]$Root,
  [switch]$Reuse,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) { Write-Host "[bootstrap] $Message" }

# --- where things go -------------------------------------------------------

if (-not $Root -or $Root.Trim() -eq '') {
  $home2 = $env:DSH_HOME
  if (-not $home2 -or $home2.Trim() -eq '') { $home2 = Join-Path $HOME '.dsh' }
  $Root = Join-Path $home2 'plugins\rea-bundle'
}
$Root = [System.IO.Path]::GetFullPath($Root)
$stack = Join-Path $Root 'stack'
$cache = Join-Path $Root 'cache'
$logs = Join-Path $Root 'logs'
foreach ($dir in @($Root, $stack, $cache, $logs)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$pluginRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $pluginRoot 'scripts\setup.mjs'
if (-not (Test-Path $setupScript)) { throw "setup.mjs not found next to this script: $setupScript" }

Write-Step "bundle root : $Root"
Write-Step "plugin root : $pluginRoot"
Write-Step "platform    : $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
Write-Step "architecture: $env:PROCESSOR_ARCHITECTURE"

if ($env:PROCESSOR_ARCHITECTURE -notmatch '64') {
  throw "This bootstrap supports 64-bit Windows (PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE)."
}

# --- Node: reuse if compatible, else fetch the portable zip -----------------
#
# The version and checksum come from the manifest, which is the single source of
# truth the rest of provisioning already reads. Hard-coding a second copy here
# meant two numbers that could drift apart silently.

$manifestPath = Join-Path $pluginRoot 'manifest\bundle.manifest.json'
if (-not (Test-Path $manifestPath)) { throw "manifest not found: $manifestPath" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$hostKey = 'win32-' + $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' })
$nodeSource = $manifest.components.node.sources.$hostKey
if (-not $nodeSource) { throw "the manifest has no Node source for $hostKey" }
$nodeVersion = $nodeSource.version
$nodeSha256 = $nodeSource.sha256
$nodeUrl = $nodeSource.url
$nodeZipName = [System.IO.Path]::GetFileName(([uri]$nodeUrl).AbsolutePath)
$nodeFolder = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileNameWithoutExtension($nodeZipName))
if ($nodeSha256 -eq 'unverified') { throw "the manifest pins no checksum for $hostKey; refusing to download unverified bytes" }
Write-Step "Node source: $hostKey v$nodeVersion"

function Test-NodeUsable([string]$Exe) {
  if (-not $Exe -or -not (Test-Path $Exe)) { return $null }
  try {
    $version = (& $Exe -v 2>$null)
  } catch { return $null }
  if (-not $version) { return $null }
  $clean = $version.TrimStart('v').Trim()
  $parts = $clean.Split('.')
  if ($parts.Count -lt 2) { return $null }
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  # REA's engines: ^22.19.0 || ^24.11.0 || >=26.0.0
  $ok = ($major -eq 22 -and $minor -ge 19) -or ($major -eq 24 -and $minor -ge 11) -or ($major -ge 26)
  if (-not $ok) { return $null }
  return [pscustomobject]@{ Path = (Resolve-Path $Exe).Path; Version = $clean }
}

function Get-PortableNode {
  $exe = Join-Path (Join-Path $stack $nodeFolder) 'node.exe'
  $found = Test-NodeUsable $exe
  if ($found) { Write-Step "portable Node present: $($found.Path) (v$($found.Version))"; return $found }

  $zip = Join-Path $cache $nodeZipName
  if (Test-Path $zip) {
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $nodeSha256) { Write-Step "cached Node zip failed its checksum; re-downloading"; Remove-Item $zip -Force }
  }
  if (-not (Test-Path $zip)) {
    Write-Step "downloading $nodeZipName (~35 MiB)"
    $partial = "$zip.part"
    if (Test-Path $partial) { Remove-Item $partial -Force }
    # Invoke-WebRequest buffers the whole body before writing, so a slow mirror
    # looks frozen; say so plainly rather than appearing stuck.
    Invoke-WebRequest -Uri $nodeUrl -OutFile $partial -UseBasicParsing -TimeoutSec 1800
    Move-Item -LiteralPath $partial -Destination $zip -Force
  }
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $nodeSha256) { throw "Node.js zip checksum mismatch.`n  expected $nodeSha256`n  actual   $actual" }
  Write-Step "checksum ok: $actual"

  Write-Step "extracting into $stack"
  Expand-Archive -LiteralPath $zip -DestinationPath $stack -Force
  $unpacked = Join-Path $stack $nodeFolder
  if (-not (Test-Path $unpacked)) { throw "the Node zip did not contain $nodeFolder" }
  $found = Test-NodeUsable (Join-Path $unpacked 'node.exe')
  if (-not $found) { throw "the extracted node.exe could not be executed" }
  Write-Step "portable Node ready: $($found.Path) (v$($found.Version))"
  return $found
}

$node = $null
$candidates = @()
if ($env:REA_BUNDLE_NODE) { $candidates += $env:REA_BUNDLE_NODE }
$onPath = (Get-Command node -ErrorAction SilentlyContinue)
if ($onPath) { $candidates += $onPath.Source }
foreach ($candidate in $candidates) {
  $node = Test-NodeUsable $candidate
  if ($node) { Write-Step "using existing Node: $($node.Path) (v$($node.Version))"; break }
}

if ($DryRun) {
  if (-not $node) { Write-Step "plan: download and extract $nodeZipName into $stack" }
  Write-Step "plan: node `"$setupScript`" --root `"$Root`"$(if ($Reuse) { ' --reuse' })"
  Write-Step "dry run complete; nothing was changed."
  exit 0
}

if (-not $node) { $node = Get-PortableNode }

# --- hand over to setup.mjs ------------------------------------------------

$setupArgs = @($setupScript, '--root', $Root)
if ($Reuse) { $setupArgs += '--reuse' }

Write-Step "running setup: node $($setupArgs -join ' ')"
& $node.Path @setupArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Step "done. Restart DeepSeek Harness so the mcp-rea row reconnects."
} else {
  Write-Step "setup reported unmet components (exit $code). Re-run after fixing the cause."
  Write-Step "log: $(Join-Path $logs 'setup.log')"
}
exit $code
