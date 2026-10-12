<#
.SYNOPSIS
  检查 dsh-plugin-rea 整条链路是否需要跟进上游更新。

.DESCRIPTION
  覆盖 4 类上游：REA(npm) / Node 运行时 / Ghidra 引擎 / DSH 插件登记。
  只读：不安装、不修改任何配置，只报告现状与建议动作。
  对 PATH 缺失、profile 结构缺失、预发布版本号均有防御。

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

$ErrorActionPreference = 'Continue'
function Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Bad($t)  { Write-Host "  [动作] $t" -ForegroundColor Red }
function Info($t) { Write-Host "  $t" -ForegroundColor Gray }

$actions = [System.Collections.Generic.List[string]]::new()

# 只取数字部分，丢掉 -rc.1 / +build 之类的后缀，避免 [version] 转换抛异常
function Get-NumericVersion([string]$v) {
  if (-not $v) { return $null }
  $core = ($v -replace '^v', '') -replace '[-+].*$', ''
  try { return [version]$core } catch { return $null }
}

# 判断 Node 版本是否满足 engines 字符串（支持 ^X.Y.Z / ~X.Y.Z / >=X.Y.Z，用 || 分隔）
function Test-NodeEngines([version]$node, [string]$engines) {
  if (-not $engines) { return $null }
  foreach ($term in ($engines -split '\|\|')) {
    $t = $term.Trim()
    if ($t -match '^\^(\d+\.\d+\.\d+)$') {
      $base = [version]$Matches[1]
      if ($node.Major -eq $base.Major -and $node -ge $base) { return $true }
    } elseif ($t -match '^>=(\d+\.\d+\.\d+)$') {
      if ($node -ge [version]$Matches[1]) { return $true }
    } elseif ($t -match '^~(\d+\.\d+\.\d+)$') {
      $base = [version]$Matches[1]
      if ($node.Major -eq $base.Major -and $node.Minor -eq $base.Minor -and $node -ge $base) { return $true }
    }
  }
  return $false
}

# ------------------------------------------------------- 定位 REA 与 profile
if (-not $ReaPackageDir) {
  $npmRoot = $null
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    try { $npmRoot = (& npm root -g 2>$null | Select-Object -First 1).Trim() } catch { }
  }
  $ReaPackageDir = if ($npmRoot) { Join-Path $npmRoot 'rea-agents' } else { Join-Path $env:APPDATA 'npm\node_modules\rea-agents' }
}
if (-not $ProfileDir) {
  if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
  else {
    $profiles = @(Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\profiles') -Directory -ErrorAction SilentlyContinue)
    $ProfileDir = if ($profiles.Count -gt 0) { $profiles[0].FullName } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
  }
}

# ---------------------------------------------------------------- REA (npm)
Head 'REA 本体（npm 包 rea-agents）'
$installed = $null; $engines = $null; $binPath = $null; $reaEntry = $null
$pkgFile = Join-Path $ReaPackageDir 'package.json'
if (Test-Path $pkgFile) {
  try {
    $pkg = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $installed = $pkg.version; $engines = $pkg.engines.node
    $binPath = ($pkg.bin.PSObject.Properties | Select-Object -First 1).Value
    if ($binPath) { $reaEntry = Join-Path $ReaPackageDir ($binPath -replace '/', '\') }
    Ok "本地已安装: $installed"
    Info "入口(bin): $binPath   ← 插件通过 PATH 上的 rea 调用它，跨版本稳定"
    if ($engines) { Info "Node 要求: $engines" }
  } catch { Bad "package.json 解析失败: $($_.Exception.Message)" }
} else { Bad "找不到 $pkgFile —— REA 全局包丢了？重装: npm i -g rea-agents" }

$latest = $null
foreach ($r in @($Registry, 'https://registry.npmjs.org')) {
  if (-not $r) { continue }
  try { $latest = (Invoke-RestMethod "$r/rea-agents/latest" -TimeoutSec 20).version; Info "最新版本($r): $latest"; break }
  catch { Warn "查询失败 $r : $($_.Exception.Message)" }
}
if ($installed -and $latest) {
  $vi = Get-NumericVersion $installed; $vl = Get-NumericVersion $latest
  if ($vi -and $vl -and $vl -gt $vi) {
    Warn "有新版本：$installed → $latest"
    $actions.Add("升级上游 REA:  npm i -g rea-agents@$latest    （只更新 REA；本插件不会自动更新——从市场装的在市场里更新，file: 装的覆盖目录后重装）")
  } elseif ($vi -and $vl -and $vl -eq $vi -and $installed -ne $latest) {
    Warn "同版本号但通道不同：$installed → $latest（预发布/正式）"
  } else { Ok '已是最新版本' }
}

# ------------------------------------------------------------- Node 运行时
Head 'Node 运行时'
if (Get-Command node -ErrorAction SilentlyContinue) {
  $nodeRaw = (& node -v 2>$null) -replace '^v', ''
  $nodeV = Get-NumericVersion $nodeRaw
  Info "当前 node: $nodeRaw"
  if ($nodeV -and $engines) {
    $ok = Test-NodeEngines $nodeV $engines
    if ($ok -eq $true) { Ok "满足当前 engines（$engines）" }
    elseif ($ok -eq $false) { Bad "不满足 engines（$engines）—— 请升级 Node；插件侧走 PATH，无需改配置" }
    else { Warn "无法解析 engines：$engines" }
  }
} else {
  Warn 'node 不在 PATH —— 跳过 Node 检查；若 harness 也看不到它，MCP 服务器将无法启动'
  $actions.Add('把 node 加入 PATH，或在本机 profile 覆盖里给 mcp-rea 的 command 写绝对路径')
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
    if ($v -notmatch '^12\.1\.') { Bad "REA 当前要求 Ghidra 12.1.x，当前为 $v —— 先确认新版 REA 是否放开版本门槛" }
  } else { Bad '缺少 Ghidra\application.properties —— 目录不完整' }
} else {
  Warn "GHIDRA_INSTALL_DIR 未设置或目录不存在（当前值: $gd）"
  Info '原生分析会报引擎不可用；静态 JavaScript/Electron 与 .NET 分析不受影响'
}
try {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest' -TimeoutSec 25 -Headers @{ 'User-Agent' = 'rea-check' }
  Info "Ghidra 官方最新: $($rel.tag_name)  ($($rel.published_at))"
  if ($rel.tag_name -notmatch 'Ghidra_12\.1') { Warn '官方已有更新；升级前先确认 REA 是否接受该版本' }
} catch { Warn "GitHub API 查询失败（可跳过）: $($_.Exception.Message)" }

# --------------------------------------------------------- REA 引擎自检
Head 'REA 引擎自检（rea doctor）'
$env:GHIDRA_INSTALL_DIR = $gd
$reaCmd = (Get-Command rea -ErrorAction SilentlyContinue).Source
$reaArgs = @()
if (-not $reaCmd) {
  if ($reaEntry -and (Test-Path $reaEntry) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $reaCmd = 'node'; $reaArgs = @($reaEntry)
    Warn 'rea 不在 PATH —— 回退到 node <包内入口>'
  } else { Warn 'rea 与 node 均不可用 —— 跳过引擎自检' }
}
if ($reaCmd) {
  try {
    $raw = & $reaCmd @reaArgs doctor --format json 2>$null
    $doc = ($raw -join "`n") | ConvertFrom-Json
    $g = @($doc.providerInspections) | Where-Object { $_.id -eq 'ghidra' }
    if ($g) {
      if ($g.available) { Ok "ghidra provider 可用，版本 $($g.providerVersion)" }
      else { Bad 'ghidra provider 不可用 —— 运行 rea doctor 看 remediation' }
      $fails = @($g.checks | Where-Object { -not $_.ok })
      if ($fails.Count -eq 0) { Ok '全部子项通过（configuration/installation/headless/native_decompiler/java）' }
      else { $fails | ForEach-Object { Bad "$($_.name): $($_.detail)" } }
    }
    if ($doc.identity.cli_package_version) {
      $toolCount = $null
      if ($doc.identity.catalog -and $doc.identity.catalog.counts) { $toolCount = $doc.identity.catalog.counts.mcp_tools }
      Info "doctor 识别到的 CLI 版本: $($doc.identity.cli_package_version)$(if ($toolCount) { "，MCP 工具数: $toolCount" })"
    }
  } catch { Warn "rea doctor 解析失败，请手动运行: rea doctor" }
}

# ---------------------------------------------------- DSH 插件登记状态
Head 'DSH 插件登记'
$profPkg = Join-Path $ProfileDir 'package.json'
if (Test-Path $profPkg) {
  try {
    $p = Get-Content $profPkg -Raw -Encoding UTF8 | ConvertFrom-Json
    $dep = $null
    if ($p.PSObject.Properties.Name -contains 'dependencies' -and $p.dependencies) { $dep = $p.dependencies.'dsh-plugin-rea' }
    $bundles = @()
    if ($p.PSObject.Properties.Name -contains 'dsh' -and $p.dsh -and $p.dsh.profile -and $p.dsh.profile.bundles) { $bundles = @($p.dsh.profile.bundles) }
    if ($dep) { Ok "依赖已登记: dsh-plugin-rea = $dep" } else { Bad '依赖未登记 —— 用插件管理器重新安装本插件' }
    if ($bundles -contains 'dsh-plugin-rea') { Ok '已列入 dsh.profile.bundles（装载层已生效）' }
    elseif ($bundles.Count -eq 0) { Warn '未读到 dsh.profile.bundles（profile 结构可能不同）' }
    else { Bad '未列入 bundles —— 插件不会加载' }
    Info '本插件不会自动更新：从插件市场安装的在市场里更新；本地 file: 目录方式则覆盖目录后在插件管理器里重装'
    if ($dep -like 'file:*') {
      $p2 = $dep -replace '^file:', ''
      if (Test-Path $p2) { Ok "插件目录存在: $p2" } else { Bad "插件目录不存在: $p2 —— 移走目录会加载失败" }
    }
  } catch { Warn "profile package.json 解析失败: $($_.Exception.Message)" }
} else { Warn "找不到 profile: $profPkg" }

$profPatch = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $profPatch) {
  if (Select-String -Path $profPatch -Pattern 'id:\s*mcp-rea' -Quiet) {
    Info '检测到本机 profile 覆盖了 mcp-rea（机器相关值应放在这里，不随插件发布）'
  }
}

# ------------------------------------------------------------------ 汇总
Head '结论'
if ($actions.Count -eq 0) { Ok '无需动作：整条链路与上游保持一致' }
else { $actions | ForEach-Object { Bad $_ } }
Write-Host ''
Write-Host '提示：DSH 侧更新（应用升级可能改变 MCP 客户端配置结构）后，请重跑本脚本并调用一次 mcp__rea__binary_session 验证。' -ForegroundColor Gray
