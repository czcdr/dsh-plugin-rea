<#
  生成市场展示图（assets/screenshot-*.png）。
  可复现：改完文案后重跑本脚本即可，无需设计工具。
  注意：Windows PowerShell 5.1 按 ANSI 读 .ps1，本文件必须保存为 UTF-8 with BOM。
#>
[CmdletBinding()]
param([string]$OutDir = (Join-Path $PSScriptRoot '.'))

Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 720
$bg      = [System.Drawing.Color]::FromArgb(255, 248, 250, 252)
$ink     = [System.Drawing.Color]::FromArgb(255, 15, 23, 42)
$muted   = [System.Drawing.Color]::FromArgb(255, 100, 116, 139)
$accent  = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
$accent2 = [System.Drawing.Color]::FromArgb(255, 22, 163, 74)
$warn    = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
$line    = [System.Drawing.Color]::FromArgb(255, 203, 213, 225)

$fTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 30, [System.Drawing.FontStyle]::Bold)
$fSub   = New-Object System.Drawing.Font('Microsoft YaHei UI', 15)
$fBox   = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$fBody  = New-Object System.Drawing.Font('Microsoft YaHei UI', 13)
$fSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$fChip  = New-Object System.Drawing.Font('Microsoft YaHei UI', 13)

function New-Canvas {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($bg)
  return @($bmp, $g)
}
function Draw-Text($g, $text, $font, $color, $x, $y, $w = 0) {
  $br = New-Object System.Drawing.SolidBrush $color
  if ($w -gt 0) { $r = New-Object System.Drawing.RectangleF $x, $y, $w, 400; $g.DrawString($text, $font, $br, $r) }
  else { $g.DrawString($text, $font, $br, $x, $y) }
  $br.Dispose()
}
function Draw-Box($g, $x, $y, $w, $h, $fill, $border, $radius = 12) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $fb = New-Object System.Drawing.SolidBrush $fill
  $g.FillPath($fb, $path)
  $p = New-Object System.Drawing.Pen $border, 1.6
  $g.DrawPath($p, $path)
  $fb.Dispose(); $p.Dispose(); $path.Dispose()
}
function Draw-Arrow($g, $x1, $y1, $x2, $y2, $color, $width = 2.4) {
  $p = New-Object System.Drawing.Pen $color, $width
  $p.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 6, 7
  $g.DrawLine($p, $x1, $y1, $x2, $y2)
  $p.Dispose()
}
function Draw-Line($g, $x1, $y1, $x2, $y2, $color, $width = 2.4) {
  $p = New-Object System.Drawing.Pen $color, $width
  $g.DrawLine($p, $x1, $y1, $x2, $y2)
  $p.Dispose()
}
function Save-Png($bmp, $g, $path) { $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose() }

# ---------------------------------------------------------------- 图 1：插件做了什么
$r = New-Canvas; $bmp = $r[0]; $g = $r[1]
Draw-Text $g 'dsh-plugin-rea：把 REA 接入 DeepSeek Harness' $fTitle $ink 60 46
Draw-Text $g '第三方适配 · 自身不做逆向分析 · 只插入一条 MCP 客户端记录，并把引擎环境变量限制在该子进程内' $fSub $muted 62 98

$rowY = 180; $boxH = 158; $boxW = 250
Draw-Box $g 60 $rowY $boxW $boxH $([System.Drawing.Color]::White) $line
Draw-Text $g 'DeepSeek Harness 会话' $fBox $ink 80 ($rowY + 18)
Draw-Text $g "mcp__rea__* 工具`n（6.4.0 暴露 170+）`n工具随会话注入`n按 DSH 权限策略执行" $fBody $muted 80 ($rowY + 50)

Draw-Box $g 360 $rowY $boxW $boxH $([System.Drawing.Color]::FromArgb(255,239,246,255)) $accent
Draw-Text $g '官方 MCP 客户端行' $fBox $accent 380 ($rowY + 18)
Draw-Text $g "@deepseek-ai/dsh-mcp-client`nserverName = rea`ntransport = stdio`ncommand = node" $fBody $muted 380 ($rowY + 50)
Draw-Text $g '↑ 本插件插入的就是这一行' $fSmall $accent 360 ($rowY + $boxH + 8)

Draw-Box $g 660 $rowY $boxW $boxH $([System.Drawing.Color]::White) $line
Draw-Text $g 'rea mcp（本机进程）' $fBox $ink 680 ($rowY + 18)
Draw-Text $g "node …`n  \rea-agents\scripts`n  \rea.mjs  mcp`nenv: GHIDRA_INSTALL_DIR`n      JAVA_HOME（仅此处）" $fBody $muted 680 ($rowY + 50)

Draw-Box $g 960 $rowY $boxW $boxH $([System.Drawing.Color]::FromArgb(255,240,253,244)) $accent2
Draw-Text $g '分析引擎' $fBox $accent2 980 ($rowY + 18)
Draw-Text $g "Ghidra 12.1.4（本机已装）`nHopper / IDA（可选，`n各自需授权）`n静态 JS / .NET 无需引擎" $fBody $muted 980 ($rowY + 50)

Draw-Arrow $g 310 ($rowY + 40) 358 ($rowY + 40) $muted
Draw-Arrow $g 610 ($rowY + 40) 658 ($rowY + 40) $muted
Draw-Arrow $g 910 ($rowY + 40) 958 ($rowY + 40) $muted

# Evidence 回传：引擎 → 结果框 → 会话（左侧折返）
Draw-Box $g 360 404 850 84 $([System.Drawing.Color]::FromArgb(255,254,249,195)) $([System.Drawing.Color]::FromArgb(255,202,138,4))
Draw-Text $g 'Evidence 回到会话（置信度 observed / derived / inferred + 明确的 limitations）' $fBox $ink 380 416
Draw-Text $g '反编译器输出的是伪代码与汇编 —— 不是原始源码，也不保证文本等价' $fBody $muted 380 448
Draw-Arrow $g 1085 340 1085 400 $muted
Draw-Line  $g 358 446 150 446 $muted
Draw-Arrow $g 150 446 150 342 $muted

Draw-Text $g '上游 REA（MIT）：github.com/morluto/rea      本插件：github.com/czcdr/dsh-plugin-rea' $fSmall $muted 60 620
Draw-Text $g '实测 REA 6.4.0 + DSH 桌面运行时 0.2.0-rc.2 + Ghidra 12.1.4 + Node 24.21.0（Windows 11 x64，2026-10-12）' $fSmall $muted 60 646
Draw-Text $g 'Ghidra 为 Apache-2.0（NSA）；REA 为 MIT。本仓库不分发上游代码。' $fSmall $muted 60 672
Save-Png $bmp $g (Join-Path $OutDir 'screenshot-1.png')

# ---------------------------------------------------------------- 图 2：范围与边界
$r = New-Canvas; $bmp = $r[0]; $g = $r[1]
Draw-Text $g '上游 REA 的分析范围（插件原样提供）' $fTitle $ink 60 44
Draw-Text $g '下列目标类型来自上游 README「可以分析什么」；本插件不改变、不扩展这些能力' $fSub $muted 62 96

$chips = @(
  '原生二进制：伪代码/汇编/字符串/符号/调用与引用',
  'JavaScript / Electron：模块、导入、source map、路由、IPC',
  '.NET 程序集：元数据、CIL、原生依赖声明',
  '网站：页面结构、脚本、网络观察、截图',
  'Android APK：清单、类、反编译的方法、引用',
  'Android 设备：adb 包/进程/日志/截图/文件传输',
  'JEB 项目：单元、工件摘要、类型与方法伪代码',
  'Android 资源：解码清单、字符串表、语言区域',
  '固件：区域、提取结果、转交原生分析',
  '软件包与资源：清单、摘要、plist、Apple bundle',
  '进程行为：终端输出、交互、退出、文件系统观察',
  '离线 ELF 布局：节、段、符号/重定位、防护候选项',
  'EVM 字节码：分派选择器、字节偏移、可变性',
  '已记录的 Linux 崩溃：note、线程寄存器、映射候选',
  '已保存的网络捕获：HAR / mitmproxy 记录'
)
$cx = 60; $cy = 146; $cw = 570; $ch = 40; $gap = 8
for ($i = 0; $i -lt $chips.Count; $i++) {
  $col = $i % 2; $rowi = [math]::Floor($i / 2)
  $x = $cx + $col * ($cw + 20); $y = $cy + $rowi * ($ch + $gap)
  Draw-Box $g $x $y $cw $ch $([System.Drawing.Color]::White) $line 8
  Draw-Text $g $chips[$i] $fChip $ink ($x + 14) ($y + 9)
}

$by = $cy + 8 * ($ch + $gap) + 16
Draw-Box $g 60 $by 1190 92 $([System.Drawing.Color]::FromArgb(255,254,242,242)) $warn
Draw-Text $g '不能完整还原源代码' $fBox $warn 80 ($by + 10)
Draw-Text $g '返回的是伪代码/汇编/反编译方法，不是原始源码；标识符、类型、注释、宏与模板、构建脚本与资源多不可恢复；不保证文本等价或可直接编译。' $fBody $ink 80 ($by + 38)
Draw-Text $g '优化（内联/重排）、strip、混淆、加壳与 VM 保护会让可读性更差。要真正的源码，请走上游仓库、厂商授权或官方 SDK。' $fBody $muted 80 ($by + 60)

Draw-Text $g '上游 REA（MIT）：github.com/morluto/rea      本插件：github.com/czcdr/dsh-plugin-rea' $fSmall $muted 60 686
Save-Png $bmp $g (Join-Path $OutDir 'screenshot-2.png')

Write-Host "written: $(Join-Path $OutDir 'screenshot-1.png')"
Write-Host "written: $(Join-Path $OutDir 'screenshot-2.png')"
