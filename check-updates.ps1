<#
.SYNOPSIS
  检查 dsh-plugin-rea 的整条链路是否需要跟进上游更新。

.DESCRIPTION
  覆盖 4 类上游：REA(npm) / Node 运行时 / Ghidra 引擎 / DSH 插件登记。
  只读：不安装、不修改任何配置，只报告现状与建议动作。

.EXAMPLE
  powershell -NoProfile -File .\check-updates.ps1
.EXAMPLE
  powershell -NoProfile -File .\check-updates.ps1 -Registry https://registry.npmjs.org
.NOTES
  Windows PowerShell 5.1 按 ANSI 读取 .ps1，本文件必须保存为 UTF-8 with BOM。
#>
[CmdletBinding()]
param(
  [string]$Registry = 'https://registry.npmmirror.com',
  [string]$ReaPackageDir,
  [string]$ProfileDir
)

# 默认值：自动定位 REA 全局包与 dsh profile（均可用参数覆盖）
if (-not $ReaPackageDir) {
  $npmRoot = $null
  try { $npmRoot = (& npm root -g 2>$null | Select-Object -First 1).Trim() } catch { }
  $ReaPackageDir = if ($npmRoot) { Join-Path $npmRoot 'rea-agents' } else { Join-Path $env:APPDATA 'npm\node_modules\rea-agents' }
}
if (-not $ProfileDir) {
  if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
  else {
    $profiles = @(Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory -ErrorAction SilentlyContinue)
    $ProfileDir = if ($profiles.Count -gt 0) { $profiles[0].FullName } else { "$env:USERPROFILE\.dsh\profiles\desktop" }
  }
}

$ErrorActionPreference = 'Continue'
function Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Bad($t)  { Write-Host "  [动作] $t" -ForegroundColor Red }
function Info($t) { Write-Host "  $t" -ForegroundColor Gray }

$actions = [System.Collections.Generic.List[string]]::new()

# ---------------------------------------------------------------- REA (npm)
Head 'REA 本体（npm 包 rea-agents）'
$installed = $null; $engines = $null; $binPath = $null
$pkgFile = Join-Path $ReaPackageDir 'package.json'
if (Test-Path $pkgFile) {
  $pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
  $installed = $pkg.version; $engines = $pkg.engines.node
  $binPath = ($pkg.bin.PSObject.Properties | Select-Object -First 1).Value
  Ok "本地已安装: $installed"
  Info "入口(bin): $binPath   ← 插件引用的就是它，跨版本稳定"
  Info "Node 要求: $engines"
} else { Bad "找不到 $pkgFile —— REA 全局包丢了？重装: npm i -g rea-agents" }

$latest = $null
foreach ($r in @($Registry, 'https://registry.npmjs.org')) {
  try { $latest = (Invoke-RestMethod "$r/rea-agents/latest" -TimeoutSec 20).version; Info "最新版本($r): $latest"; break }
  catch { Warn "查询失败 $r : $($_.Exception.Message)" }
}
if ($installed -and $latest) {
  if ([version]$latest -gt [version]$installed) {
    Warn "有新版本：$installed → $latest"
    $actions.Add("升级上游 REA:  npm i -g rea-agents@$latest    （只更新 REA 本身；本插件不会自动更新，有新版需在插件管理器里重装）")
  } else { Ok '已是最新版本' }
}

# ------------------------------------------------------------- Node 运行时
Head 'Node 运行时'
$nodeV = (& node -v) -replace '^v', ''
Info "当前 node: $nodeV"
if ($engines) {
  if ($engines -match '\^24\.(\d+)\.' -and [version]$nodeV -ge [version]('24.' + $Matches[1] + '.0')) { Ok '满足当前 engines 要求' }
  elseif ($engines -match '\^22\.(\d+)\.' -and [version]$nodeV -ge [version]('22.' + $Matches[1] + '.0')) { Ok '满足当前 engines 要求' }
  else { Warn "请对照 engines 范围自行确认: $engines" }
  Info "上游若抬高 Node 下限，插件里的 command('node') 需换成满足要求的 node 可执行文件"
}

# ------------------------------------------------------------ Ghidra 引擎
Head 'Ghidra 引擎'
$gd = [Environment]::GetEnvironmentVariable('GHIDRA_INSTALL_DIR', 'User')
if (-not $gd) { $gd = $env:GHIDRA_INSTALL_DIR }
if ($gd -and (Test-Path $gd)) {
  Ok "GHIDRA_INSTALL_DIR = $gd"
  $props = Join-Path $gd 'Ghidra\application.properties'
  if (Test-Path $props) {
    $v = (Select-String -Path $props -Pattern '^application\.version=' | Select-Object -First 1).Line -replace '^application\.version=', ''
    Ok "已安装版本: $v"
    if ($v -notmatch '^12\.1\.') { Bad "REA 当前要求 Ghidra 12.1.x，而你装的是 $v —— 升级 REA 后才有望支持更高版本" }
  } else { Bad "缺少 Ghidra\application.properties —— 目录不完整" }
} else { Bad "GHIDRA_INSTALL_DIR 未设置或目录不存在（当前值: $gd）" }

try {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest' -TimeoutSec 25 -Headers @{ 'User-Agent' = 'rea-check' }
  Info "Ghidra 官方最新: $($rel.tag_name)  ($($rel.published_at))"
  if ($rel.tag_name -notmatch 'Ghidra_12\.1') { Warn '官方已有更新；请先确认 REA 是否放开版本门槛，再升级 Ghidra' }
} catch { Warn "GitHub API 查询失败（可跳过）: $($_.Exception.Message)" }

# --------------------------------------------------------- REA 引擎自检
Head 'REA 引擎自检（rea doctor）'
$env:GHIDRA_INSTALL_DIR = $gd
try {
  $raw = & rea doctor --format json 2>$null
  $doc = ($raw -join "`n") | ConvertFrom-Json
  $g = $doc.providerInspections | Where-Object { $_.id -eq 'ghidra' }
  if ($g) {
    if ($g.available) { Ok "ghidra provider 可用，版本 $($g.providerVersion)" } else { Bad 'ghidra provider 不可用 —— 运行 rea doctor 看 remediation' }
    $fails = @($g.checks | Where-Object { -not $_.ok })
    if ($fails.Count -eq 0) { Ok '全部子项通过（configuration/installation/headless/native_decompiler/java）' }
    else { $fails | ForEach-Object { Bad "$($_.name): $($_.detail)" } }
  }
  if ($doc.identity.cli_package_version) { Info "doctor 识别到的 CLI 版本: $($doc.identity.cli_package_version)，MCP 工具数: $($doc.identity.catalog.counts.mcp_tools)" }
} catch { Warn "rea doctor 解析失败，请手动运行: rea doctor" }

# ---------------------------------------------------- DSH 插件登记状态
Head 'DSH 插件登记'
$profPkg = Join-Path $ProfileDir 'package.json'
if (Test-Path $profPkg) {
  $p = Get-Content $profPkg -Raw | ConvertFrom-Json
  $dep = $p.dependencies.'dsh-plugin-rea'
  $bundled = @($p.dsh.profile.bundles) -contains 'dsh-plugin-rea'
  if ($dep) { Ok "依赖已登记: dsh-plugin-rea = $dep" } else { Bad '依赖未登记 —— 用 plugin_manager 重新安装本插件' }
  if ($bundled) { Ok '已列入 dsh.profile.bundles（装载层已生效）' } else { Bad '未列入 bundles —— 插件不会加载' }
  Info '本插件不会自动更新：本仓库（github.com/czcdr/dsh-plugin-rea）有新版本时，用插件管理器重新安装一次即可'
  if ($dep -like 'file:*') {
    $p2 = $dep -replace '^file:', ''
    if (Test-Path $p2) { Ok "插件目录存在: $p2" } else { Bad "插件目录不存在: $p2 —— 移走了目录就会加载失败" }
  }
} else { Warn "找不到 profile: $profPkg" }

# ------------------------------------------------------------------ 汇总
Head '结论'
if ($actions.Count -eq 0) { Ok '无需动作：整条链路与上游保持一致' }
else { $actions | ForEach-Object { Bad $_ } }
Write-Host ''
Write-Host '提示：DSH 侧更新（应用升级可能改变 MCP 客户端配置结构）后，请重跑本脚本并调用一次 mcp__rea__binary_session 验证。' -ForegroundColor Gray
