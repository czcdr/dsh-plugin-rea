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
# 参数收 string 不收 [version]：类型约束在函数体之前生效，调用方一旦传入
# 'abc' / '' / 'v24.21.0' 这类值就会抛 ParameterBindingArgumentTransformationException。
function Test-NodeEngines([string]$node, [string]$engines) {
  if (-not $engines -or -not $node) { return $null }
  # 必须用新变量接收：$node 带 [string] 约束，赋 [version] 会被强制转回字符串，
  # 之后 $node.Major 为 $null，所有 ^ / ~ 分支都会判假（曾因此把 Node 24 判成不满足）。
  $v = Get-NumericVersion $node
  if (-not $v) { return $null }
  # 只要有一个 term 的形态不认识，整个判断就只能给"无法解析"：返回 $false 会把
  # `22.x` / `>=22` 这类合法但未实现的 pattern 误报成"不满足"，让用户去升级一个
  # 本来就满足的 Node。
  $recognized = $true
  foreach ($term in ($engines -split '\|\|')) {
    $t = $term.Trim()
    if ($t -match '^\^(\d+\.\d+\.\d+)$') {
      $base = [version]$Matches[1]
      if ($v.Major -eq $base.Major -and $v -ge $base) { return $true }
    } elseif ($t -match '^>=(\d+\.\d+\.\d+)$') {
      if ($v -ge [version]$Matches[1]) { return $true }
    } elseif ($t -match '^~(\d+\.\d+\.\d+)$') {
      $base = [version]$Matches[1]
      if ($v.Major -eq $base.Major -and $v.Minor -eq $base.Minor -and $v -ge $base) { return $true }
    } else {
      $recognized = $false
    }
  }
  if (-not $recognized) { return $null }
  return $false
}

# ------------------------------------------------------- 定位 REA 与 profile
# 2.x 的 REA 在 <bundleRoot>\vendor\node_modules\rea-agents，不在 npm 全局。先读
# bundle.json：把全局路径当默认是 1.x 的答案，在 2.x 机器上会让这一节指向错误的
# 对象（"全局包丢了"），并给出错误的升级动作（npm i -g）。
$bundleRootEarly = $env:REA_BUNDLE_ROOT
# Resolve the home unconditionally: the profile section below needs it whether or
# not REA_BUNDLE_ROOT was set, and computing it only inside the fallback branch
# left it $null — `Join-Path $null 'profiles'` throws, so the section degraded to
# "no profile" on exactly the machines that use the override.
$homeEarly = $env:DSH_HOME
if (-not $homeEarly) { $homeEarly = Join-Path $HOME '.dsh' }
if (-not $bundleRootEarly) {
  $bundleRootEarly = Join-Path $homeEarly 'plugins\rea-bundle'
}
$bundleState = $null
$bundleJsonEarly = Join-Path $bundleRootEarly 'bundle.json'
if (Test-Path $bundleJsonEarly) {
  try { $bundleState = Get-Content $bundleJsonEarly -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $bundleState = $null }
}
$bundleReaPackageDir = $null
$bundleReaEntry = $null
if ($bundleState -and $bundleState.paths.reaEntry) {
  $bundleReaEntry = [string]$bundleState.paths.reaEntry
  # <vendor>\node_modules\rea-agents\scripts\rea.mjs -> <vendor>\node_modules\rea-agents
  $bundleReaPackageDir = Split-Path -Parent (Split-Path -Parent $bundleReaEntry)
}

if (-not $ReaPackageDir) {
  if ($bundleReaPackageDir -and (Test-Path (Join-Path $bundleReaPackageDir 'package.json'))) {
    $ReaPackageDir = $bundleReaPackageDir
  } else {
    $npmRoot = $null
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      try { $npmRoot = (& npm root -g 2>$null | Select-Object -First 1).Trim() } catch { }
    }
    $ReaPackageDir = if ($npmRoot) { Join-Path $npmRoot 'rea-agents' } else { Join-Path $env:APPDATA 'npm\node_modules\rea-agents' }
  }
}
$reaFromBundle = [bool]($bundleReaPackageDir -and $ReaPackageDir -eq $bundleReaPackageDir)
if (-not $ProfileDir) {
  if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
  else {
    # Same home rule the bundle uses everywhere else: DSH_HOME, then ~/.dsh.
    # Hardcoding $env:USERPROFILE here was a second algorithm in the same script,
    # so on a custom DSH_HOME the profile section reported "no profile found"
    # while the rest of the run had already resolved that home correctly.
    $profiles = @(Get-ChildItem (Join-Path $homeEarly 'profiles') -Directory -ErrorAction SilentlyContinue)
    $ProfileDir = if ($profiles.Count -gt 0) { $profiles[0].FullName } else { Join-Path $homeEarly 'profiles\desktop' }
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
    if ($reaFromBundle) {
      Ok "一体包内置（vendored）: $installed"
      Info "位置: $ReaPackageDir"
      Info "入口(bin): $binPath"
    } else {
      Ok "本地已安装: $installed"
      Info "入口(bin): $binPath   ← 插件通过 PATH 上的 rea 调用它，跨版本稳定"
    }
    if ($engines) { Info "Node 要求: $engines" }
  } catch { Bad "package.json 解析失败: $($_.Exception.Message)" }
} else {
  if ($reaFromBundle) { Bad "找不到 $pkgFile —— 内置副本不完整？重跑 setup.mjs" }
  elseif ($bundleReaPackageDir) { Bad "找不到 $pkgFile —— 一体包内置副本也缺（$bundleReaPackageDir）；记录里没有 reaEntry" }
  else { Bad "找不到 $pkgFile —— REA 全局包丢了？重装: npm i -g rea-agents" }
}

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
    if ($reaFromBundle) {
      $actions.Add("升级一体包内置 REA：把 manifest 的 pins.reaAgents / components.reaAgents.sources.npm.version 改成 $latest，然后重跑 node scripts\setup.mjs（内置副本不会自己更新）")
    } else {
      $actions.Add("升级上游 REA:  npm i -g rea-agents@$latest    （只更新 REA；本插件不会自动更新——从市场装的在市场里更新，file: 装的覆盖目录后重装）")
    }
  } elseif ($vi -and $vl -and $vl -eq $vi -and $installed -ne $latest) {
    Warn "同版本号但通道不同：$installed → $latest（预发布/正式）"
  } else { Ok '已是最新版本' }
} elseif (-not $latest) {
  Warn '未能取到上游最新版本（两个 registry 都查不通？）—— 已跳过版本比对'
} else {
  Warn '本地没读到已安装版本（见上面那条）—— 已跳过版本比对'
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
# bundle.json 是 2.x 的真源：shim 只在 MCP 子进程里设 GHIDRA_INSTALL_DIR，用户级
# 变量是 1.x 的写法，没手工设过的机器会被误报"未设置"。
$gd = $null
if ($bundleState -and $bundleState.paths.ghidra) {
  $bundleGhidra = [string]$bundleState.paths.ghidra
  if (Test-Path $bundleGhidra) { $gd = $bundleGhidra }
}
if (-not $gd) { $gd = [Environment]::GetEnvironmentVariable('GHIDRA_INSTALL_DIR', 'User') }
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
# 2.x：优先用 bundle 内置的 CLI 和它自己的 Node。PATH 上的 rea 可能是另一个，
# 甚至完全不在 PATH —— 那会让整段自检被静默跳过。这正是 1.x 口径的残留。
$reaCmd = $null
$reaArgs = @()
if ($bundleReaEntry -and (Test-Path $bundleReaEntry)) {
  $bundleNode = $null
  if ($bundleState -and $bundleState.paths.node) {
    $candidateNode = [string]$bundleState.paths.node
    if (Test-Path $candidateNode) { $bundleNode = $candidateNode }
  }
  if (-not $bundleNode) { $bundleNode = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if ($bundleNode) {
    $reaCmd = $bundleNode; $reaArgs = @($bundleReaEntry)
    Info '使用一体包内置 REA（node <bundle 入口>），不依赖 PATH 上的 rea'
  }
}
if (-not $reaCmd) {
  # 优先取 .cmd：发布出去的那一行是 `cmd.exe /c rea mcp`（走 cmd 的 PATHEXT，命中 rea.cmd），
  # 而 PowerShell 的 Get-Command rea 会先命中同目录的 rea.ps1 垫片，两者行为（尤其退出码）并不相同。
  $reaCmd = (Get-Command 'rea.cmd' -ErrorAction SilentlyContinue).Source
  if (-not $reaCmd) { $reaCmd = (Get-Command rea -ErrorAction SilentlyContinue).Source }
}
if (-not $reaCmd) {
  if ($reaEntry -and (Test-Path $reaEntry) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $reaCmd = 'node'; $reaArgs = @($reaEntry)
    Warn 'rea 不在 PATH —— 回退到 node <包内入口>'
  } else { Warn 'rea 与 node 均不可用 —— 跳过引擎自检' }
}
if ($reaCmd) {
  try {
    $raw = & $reaCmd @reaArgs doctor --format json 2>$null
    if ($LASTEXITCODE -ne 0) { Warn "rea doctor 退出码 $LASTEXITCODE —— 报告了不健康状态，下面按输出解析" }
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

# ------------------------------------------------- 一体包（bundle 分支）
# 设计文档承诺了这个分区：一体包把组件版本钉在 manifest 里，供应结果记在
# bundle.json 里。两者不一致 = 有一次 pin 更新还没重新供给，或盘上的组件被换过。
Head '一体包供给状态（bundle 分支）'
$pluginRoot = $PSScriptRoot
$manifestPath = Join-Path $pluginRoot 'manifest\bundle.manifest.json'
$bundleRoot = $env:REA_BUNDLE_ROOT
if (-not $bundleRoot) {
  $homeDir = $env:DSH_HOME
  if (-not $homeDir) { $homeDir = Join-Path $HOME '.dsh' }
  $bundleRoot = Join-Path $homeDir 'plugins\rea-bundle'
}
$bundleJson = Join-Path $bundleRoot 'bundle.json'

if (-not (Test-Path $manifestPath)) {
  Info '未找到 manifest/bundle.manifest.json —— 这不是一体包分支，跳过'
} else {
  Info "bundle 根目录: $bundleRoot"
  try {
    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-Path $bundleJson) {
      $state = Get-Content $bundleJson -Raw -Encoding UTF8 | ConvertFrom-Json
      Ok "已供给：$($state.provisionedAt)"
      $drift = 0
      $compared = 0
      $unrecorded = 0
      foreach ($name in $manifest.pins.PSObject.Properties.Name) {
        if ($name -eq 'nodeEngines') { continue }
        $pinned = [string]$manifest.pins.$name
        $installed = ''
        if ($state.versions -and ($state.versions.PSObject.Properties.Name -contains $name)) {
          $installed = [string]$state.versions.$name
        }
        if (-not $installed) {
          # 被 --reuse 采纳的组件没有 version 字段（bundle.json 里是 null）。静默
          # continue 会让这一项从未被比对，却在下面打印"全部一致"——那是假绿。
          $unrecorded++
          Warn "  $name 未记录版本（reuse 采纳的组件？）—— 无法与 pin $pinned 对账"
          continue
        }
        $compared++
        # Node 的 pin 是引擎范围，不是版本号；其它组件比前缀即可
        $same = $installed.Equals($pinned) -or $installed.StartsWith(($pinned -split '\.')[0] + '.')
        if ($same) { Info "  $name = $installed（pin $pinned）" }
        else { Warn "$name 盘上为 $installed，manifest 已钉 $pinned —— 重跑 setup 对齐"; $drift++ }
      }
      if ($drift -eq 0 -and $unrecorded -eq 0) { Ok '所有组件与 manifest 的 pin 一致' }
      elseif ($drift -eq 0) { Warn "已比对的 $compared 项与 pin 一致，但 $unrecorded 项没有记录版本（见上）—— 不是全绿" }
      if ($state.unverifiedChecksums -and @($state.unverifiedChecksums).Count -gt 0) {
        Warn ("TOFU（无厂商校验和，取首次实测值）: " + (@($state.unverifiedChecksums) -join ', '))
      }
      $mirrored = Join-Path $bundleRoot 'bin\rea-shim.mjs'
      if (Test-Path $mirrored) {
        Ok 'MCP 行指向的 shim 已就位'
        # The row launches this COPY, so a plugin upgrade that does not re-run
        # setup leaves the old launcher in place — visible only as "the new
        # version behaves like the old one". Compare it with the checkout the
        # mirror record names.
        $mirrorRecord = Join-Path $bundleRoot 'mirror.json'
        if (Test-Path $mirrorRecord) {
          try {
            $record = Get-Content $mirrorRecord -Raw -Encoding UTF8 | ConvertFrom-Json
            $pluginShim = if ($record.pluginRoot) { Join-Path $record.pluginRoot 'bin\rea-shim.mjs' } else { $null }
            if ($pluginShim -and (Test-Path $pluginShim)) {
              $same = (Get-FileHash $mirrored -Algorithm SHA256).Hash -eq (Get-FileHash $pluginShim -Algorithm SHA256).Hash
              if ($same) { Ok '镜像 shim 与插件一致（行跑的就是这个版本）' }
              else { Warn "镜像 shim 落后于插件（$($record.pluginRoot)）—— 行仍在跑旧副本；重跑 node scripts/setup.mjs 让它换成新版本" }
            } else {
              Warn "mirror.json 指向的插件目录已不存在（$($record.pluginRoot)）—— 无法比对镜像 shim 是否最新"
            }
          } catch { Warn "mirror.json 解析失败: $($_.Exception.Message)" }
        }
      }
      else { Bad "缺少 MCP 行指向的 shim: $mirrored —— 重跑 setup --reuse" }
      # 镜像副本的 setup 用它自己所在的位置推 plugin root，所以 manifest 必须
      # 一起镜像。旧版镜像缺这个文件：auto-provision 会以 ENOENT 崩掉且不可见，
      # 而且它已写下的 lock 会让重试被抑制 6 小时。
      $mirroredManifest = Join-Path $bundleRoot 'manifest\bundle.manifest.json'
      if (Test-Path $mirroredManifest) { Ok '镜像副本的 manifest 已就位' }
      else { Bad "镜像副本缺少 manifest: $mirroredManifest —— 请从插件目录重跑一次 node scripts/setup.mjs（旧镜像无法自愈）" }
    } else {
      Warn "尚未供给：$bundleJson 不存在 —— 运行 node scripts/setup.mjs（或直接装插件，行会自行触发）"
    }
    $pins = @()
    foreach ($name in $manifest.pins.PSObject.Properties.Name) {
      if ($name -ne 'nodeEngines') { $pins += "$name=$($manifest.pins.$name)" }
    }
    Info ('manifest 钉子: ' + ($pins -join ', '))
  } catch { Warn "bundle 状态解析失败: $($_.Exception.Message)" }
}

# ------------------------------------------------------------------ 汇总
Head '结论'
if ($actions.Count -eq 0) { Ok '无需动作：整条链路与上游保持一致' }
else { $actions | ForEach-Object { Bad $_ } }
Write-Host ''
Write-Host '提示：DSH 侧更新（应用升级可能改变 MCP 客户端配置结构）后，请重跑本脚本并调用一次 mcp__rea__binary_session 验证。' -ForegroundColor Gray
