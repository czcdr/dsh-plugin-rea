# dsh-plugin-rea

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

把 **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** 接入 **DeepSeek Harness (dsh)**：
一个**纯配置型 Cordis bundle**，复用官方 MCP 客户端插件 `@deepseek-ai/dsh-mcp-client`，
把本机已安装的 `rea mcp`（stdio）注册成原生工具。装载后模型直接拥有 `mcp__rea__*` 工具。

> **与上游的关系（重要）**
> 本仓库是**第三方适配封装，不是 REA 项目的组成部分**，也不包含 REA 的任何源码，
> 更不由 REA 作者维护。它只做一件事：向 dsh 的配置组合里插入一条指向你本机 `rea` 安装的 MCP 服务器记录。
> - 上游项目：**REA — Reverse Engineer Anything** — <https://github.com/morluto/rea>（MIT）
> - 上游文档：<https://github.com/morluto/rea#what-you-can-analyze> · [中文](https://github.com/morluto/rea/blob/main/README_zh.md#可以分析什么) · 站点 <https://rea.tools/>
> - 上游 npm 包：`rea-agents`
> - 本插件仓库：**<https://github.com/czcdr/dsh-plugin-rea>**
> - 问题反馈：REA 本身的问题请提到上游；本插件的问题提到 [本仓库 Issues](https://github.com/czcdr/dsh-plugin-rea/issues)。

---

## English

**What it does.** This plugin performs **no reverse engineering itself**. It connects the upstream REA
MCP server to DeepSeek Harness, so the tools REA ships become callable in a session as
`mcp__rea__*`.

In upstream's own words, REA is *"one MCP for reverse engineering across binaries, applications, and
runtime behavior"* — *"see a feature you like. Understand how it works, down to the binary level."* It
*connects your agent to tools for inspecting native binaries, JavaScript and Electron apps, .NET
assemblies, and websites*; analysis runs locally, and results include the evidence and limitations
behind each conclusion. Native analysis can use an existing Hopper, Ghidra, or IDA installation, and
static JavaScript analysis needs no native engine.

Upstream's own coverage list (`README.md#what-you-can-analyze`): native binaries — pseudocode,
assembly, strings, symbols, calls and references; JavaScript/Electron apps — modules, imports, source
maps, routes, IPC; websites — page structure, scripts, network observations, screenshots; .NET
assemblies; Android APKs; Android devices over adb; JEB projects; Android resources; firmware;
packages and assets; process behavior; plus offline ELF layout, EVM bytecode, recorded Linux crashes
and saved network captures.

**What this plugin adds.** Exactly two things: it registers that MCP server into DSH's tool layer
under the `mcp__rea__*` names, and it scopes the engine environment variables (`GHIDRA_INSTALL_DIR`,
`JAVA_HOME`) to that MCP child process instead of the whole harness.

**Verified against** (author's machine, 2026-10-12):

| Component | Version |
|---|---|
| REA (`rea-agents`) | **6.4.0** |
| DeepSeek Harness (dsh desktop runtime) | **0.2.0-rc.2** |
| `@deepseek-ai/dsh-mcp-client` (row provider) | bundled by the harness; npm latest `0.0.1-rc.1` |
| Ghidra | 12.1.4 (REA currently accepts 12.1.x) |
| Node.js | 24.21.0 (REA engines: `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`) |
| Host | Windows 11 x64 |

**Prerequisites.** Node.js (a version REA accepts), the REA CLI installed globally
(`npm i -g rea-agents`), and for native analysis a Ghidra 12.1.x extraction directory (Hopper / IDA
are alternatives, under their own licences). Static JavaScript/Electron and .NET analysis need no
native engine.

**Install.** Add this repository as a bundle (the repo declares `dsh.bundle.patch`, so it is
installable directly):

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea
```

A prebuilt tarball is attached to [Releases](https://github.com/czcdr/dsh-plugin-rea/releases)
(version-free asset name, so the link keeps resolving). Or install a local checkout with
`file:<path-to-this-repo>`.

**Configure — two machine-specific values.** Edit `cordis.patch.yml` before or after installing:

1. `args[0]` — full path of the REA CLI entry: run `npm root -g`, then append
   `\rea-agents\scripts\rea.mjs` (`/rea-agents/scripts/rea.mjs` on POSIX).
2. `env.GHIDRA_INSTALL_DIR` — your Ghidra extraction directory. Omit it only if you do not use Ghidra.

`command: node` resolves through `PATH`; replace it with a full path if `node` is not on the PATH the
harness sees. `env.JAVA_HOME` is optional (only needed when `java` is not on `PATH`).

**Verify.** Ask for a `mcp__rea__*` call — `binary_session` reports the engine checks
(`configuration` / `installation` / `headless` / `native_decompiler` / `java`), all of which should be
`ok: true`. Then `open_binary` a PE, `binary_overview`, and `procedure_pseudo_code`.

**Scope and caveats.** REA exposes 170+ tools at 6.4.0, so every session's tool list grows; the row
sets `failOnStartupError: false` so a missing REA never blocks harness startup. Some REA tools launch
processes, write files and access the network — DSH's permission policy applies. Analyse only
artifacts you are authorized to inspect.

**Upstream updates.** REA ships its own updater — run `rea update` (or `npm i -g rea-agents@latest`).
Its `bin` entry (`scripts/rea.mjs`) is stable across releases, so upgrading REA needs no change here.
Ghidra is version-gated by REA (12.1.x today), so upgrade REA first and check that it accepts the
newer Ghidra. A harness upgrade may change the MCP client's config schema — inspect the row with
`Config.listConfigs name=@deepseek-ai/dsh-mcp-client` and adjust the field names.
`check-updates.ps1` (Windows PowerShell) reports all of this.

**License.** MIT (this adapter). REA is MIT and owned by its authors; Ghidra is Apache-2.0 and owned
by the NSA. No upstream code is redistributed here.

---

## 中文

**作用。** 本插件**自身不做任何逆向分析**。它把上游 REA 的 MCP 服务接入 DeepSeek Harness，
让 REA 提供的那套工具在会话里变成可直接调用的 `mcp__rea__*`。

按上游自述，REA 是「**通过一个 MCP 服务，逆向分析二进制文件、应用程序和运行时行为**」——
「看到喜欢的功能，弄清它的工作原理，深入到二进制层面」。它「将智能体连接到分析工具，用于检查
原生二进制文件、JavaScript 和 Electron 应用、.NET 程序集以及网站」；分析在本机运行，结果包含
支撑各项结论的证据和相关限制。原生分析可以使用已有的 Hopper、Ghidra 或 IDA，静态 JavaScript 分析
不需要原生引擎。

上游列出的可分析目标（原文见 [README_zh.md#可以分析什么](https://github.com/morluto/rea/blob/main/README_zh.md#可以分析什么)）：
原生二进制文件——伪代码、汇编、字符串、符号、调用和引用；JavaScript / Electron——模块、导入、
source map、路由与 IPC；网站——页面结构、脚本、网络观察结果与截图；.NET 程序集；Android APK；
Android 设备（adb）；JEB 项目；Android 资源；固件；软件包与资源；进程行为；以及离线 ELF 布局、
EVM 字节码、已记录的 Linux 崩溃与已保存的网络捕获。

**本插件在此之上只增加两件事**：把该 MCP 服务注册进 DSH 的工具层（工具名 `mcp__rea__*`），
以及把引擎环境变量（`GHIDRA_INSTALL_DIR`、`JAVA_HOME`）限制在这个 MCP 子进程内，而不是整个 harness。

**已验证版本**（作者机器，2026-10-12）：REA `6.4.0`、DeepSeek Harness 桌面运行时 `0.2.0-rc.2`、
Ghidra `12.1.4`、Node `24.21.0`、Windows 11 x64。行提供方 `@deepseek-ai/dsh-mcp-client` 由
harness 自带（npm 最新 `0.0.1-rc.1`）。

**前置条件。** 满足 REA 要求的 Node；全局安装 REA（`npm i -g rea-agents`）；原生分析需要
Ghidra 12.1.x 的解压目录（Hopper / IDA 为替代方案，各自需授权）。静态 JavaScript/Electron 与
.NET 分析不需要原生引擎。

**安装。**

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea
```

[Releases](https://github.com/czcdr/dsh-plugin-rea/releases) 附带预构建 tarball（资产名不带版本号，
链接不会失效）。也可用本地目录安装：`file:<本仓库路径>`。

**配置（两个随机器不同的值）**：改 `cordis.patch.yml`

1. `args[0]` —— REA 入口文件的绝对路径：先跑 `npm root -g`，再拼上
   `\rea-agents\scripts\rea.mjs`（POSIX 用 `/`）。
2. `env.GHIDRA_INSTALL_DIR` —— 你的 Ghidra 解压目录；不用 Ghidra 时可删掉这一行。

`command: node` 走 PATH；若 harness 的 PATH 里没有 `node`，改成绝对路径。`env.JAVA_HOME`
可选，仅当 `java` 不在 PATH 上时需要。

**验证。** 调用任一 `mcp__rea__*` 工具：`binary_session` 会给出引擎检查项
（configuration / installation / headless / native_decompiler / java），应全部 `ok: true`；
随后 `open_binary` 打开一个 PE → `binary_overview` → `procedure_pseudo_code`。

**范围与注意。** REA 在 6.4.0 暴露 170+ 个工具，注入后每个会话的工具列表都会变大；行内设置
`failOnStartupError: false`，因此 REA 缺失也不会阻塞 harness 启动。部分 REA 工具会启动进程、
写文件、访问网络，按 DSH 的权限策略执行。请仅分析你已获得授权的目标。

**上游更新怎么办。** REA 自带更新命令：`rea update`（等价于 `npm i -g rea-agents@latest`）。
它的 `bin` 入口（`scripts/rea.mjs`）跨版本稳定，所以升级 REA 后本插件**无需改动**。
Ghidra 受 REA 版本门槛限制（当前 12.1.x），顺序必须是先升 REA、确认它接受新版 Ghidra 再升级。
harness 升级可能改变 MCP 客户端配置结构，用 `Config.listConfigs name=@deepseek-ai/dsh-mcp-client`
看该行 schema 并调整字段名。`check-updates.ps1`（Windows PowerShell）会把上述四类检查一次跑完。

**许可。** 本适配器为 MIT；REA 为 MIT，版权归其作者；Ghidra 为 Apache-2.0，版权归 NSA。
本仓库不再分发上游代码。
