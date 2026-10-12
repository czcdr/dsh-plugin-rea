# dsh-plugin-rea

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

把 **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** 接入 **DeepSeek Harness (dsh)**：
一个**纯配置型 Cordis bundle**，复用官方 MCP 客户端插件 `@deepseek-ai/dsh-mcp-client`，
把本机已安装的 `rea mcp`（stdio）注册成原生工具。装载后模型直接拥有 `mcp__rea__*` 工具。

> **与上游的关系（重要）**
> 本仓库是**第三方适配封装，不是 REA 项目的组成部分**，也不包含 REA 的任何源码，
> 更不由 REA 作者维护。它只做一件事：向 dsh 的配置组合里插入一条指向你本机 `rea` 安装的 MCP 服务器记录。
> - 上游项目：**REA — Reverse Engineer Anything** — <https://github.com/morluto/rea>（MIT）
> - 上游 npm 包：`rea-agents`
> - 本插件仓库：**<https://github.com/czcdr/dsh-plugin-rea>**
> - 问题反馈：REA 本身的问题请提到上游；本插件的问题提到 [本仓库 Issues](https://github.com/czcdr/dsh-plugin-rea/issues)。

---

## English

**What it is.** A configuration-only Cordis bundle for DeepSeek Harness. It inserts one row of the
official `@deepseek-ai/dsh-mcp-client` plugin and points it at your local `rea mcp` stdio server, so
every session in the profile gets `mcp__rea__*` tools (`mcp__rea__binary_overview`,
`mcp__rea__procedure_pseudo_code`, `mcp__rea__trace_feature`, …).

**Relationship to upstream.** This is a third-party adapter, not part of REA, and it ships no REA
code. Upstream: <https://github.com/morluto/rea> (MIT). It only composes configuration; the analysis
engines (Ghidra, IDA, JEB) stay owned and licensed by their respective vendors.

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
(`npm i -g rea-agents`), and for decompilation a Ghidra 12.1.x extraction directory. IDA Pro / JEB
need their own commercial licences; Hopper is macOS-only.

**Install.** Add this repository as a bundle (the repo declares `dsh.bundle.patch`, so it is
installable directly):

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea
```

Or install the plugin manager's bundle entry with a local checkout: `file:<path-to-this-repo>`.

**Configure — two machine-specific values.** Edit `cordis.patch.yml` before or after installing:

1. `args[0]` — full path of the REA CLI entry: run `npm root -g`, then append
   `\rea-agents\scripts\rea.mjs` (`/rea-agents/scripts/rea.mjs` on POSIX).
2. `env.GHIDRA_INSTALL_DIR` — your Ghidra extraction directory. Omit it only if you do not use Ghidra.

`command: node` resolves through `PATH`; replace it with a full path if `node` is not on the PATH the
harness sees. `env.JAVA_HOME` is optional (only needed when `java` is not on `PATH`).

**Verify.** Ask for a `mcp__rea__*` call — `binary_session` reports the engine checks
(`configuration` / `installation` / `headless` / `native_decompiler` / `java`), all of which should be
`ok: true`. Then `open_binary` a PE, `binary_overview`, and `procedure_pseudo_code`.

**Scope and caveats.** REA exposes 170+ tools, so every session's tool list grows; the row sets
`failOnStartupError: false` so a missing REA never blocks harness startup. Some REA tools launch
processes, write files and access the network — DSH's permission policy applies. Analysis only on
artifacts you are authorized to inspect.

**Upstream updates.** REA's `bin` entry (`scripts/rea.mjs`) is stable across releases, so upgrading
REA needs no change here: `npm i -g rea-agents@latest`. Ghidra is version-gated by REA (12.1.x today),
so upgrade REA first and check that it accepts the newer Ghidra. A harness upgrade may change the MCP
client's config schema — inspect the row with `Config.listConfigs name=@deepseek-ai/dsh-mcp-client`
and adjust the field names. `check-updates.ps1` (Windows PowerShell) reports all of this.

**License.** MIT (this adapter). REA is MIT and owned by its authors; Ghidra is Apache-2.0 and owned
by the NSA. No upstream code is redistributed here.

---

## 中文

**这是什么。** 一个面向 DeepSeek Harness 的**纯配置型 Cordis bundle**：向配置里插入一条官方
`@deepseek-ai/dsh-mcp-client` 记录，指向你本机的 `rea mcp`（stdio）服务器。装载后该 profile 下
每个会话都会拥有 `mcp__rea__*` 工具（如 `mcp__rea__binary_overview`、
`mcp__rea__procedure_pseudo_code`、`mcp__rea__trace_feature`）。

**与上游的关系。** 本仓库是**第三方适配封装**，不属于 REA，也不分发任何 REA 代码。
上游：<https://github.com/morluto/rea>（MIT）。它只做配置组合；分析引擎（Ghidra / IDA / JEB）
的归属与授权仍在各自厂商手里。

**已验证版本**（作者机器，2026-10-12）：REA `6.4.0`、DeepSeek Harness 桌面运行时 `0.2.0-rc.2`、
Ghidra `12.1.4`、Node `24.21.0`、Windows 11 x64。行提供方 `@deepseek-ai/dsh-mcp-client` 由
harness 自带（npm 最新 `0.0.1-rc.1`）。

**前置条件。** 满足 REA 要求的 Node；全局安装 REA（`npm i -g rea-agents`）；如需反编译，准备
Ghidra 12.1.x 的解压目录。IDA Pro / JEB 需自有授权，Hopper 仅 macOS。

**安装。**

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea
```

或在插件管理器里用本地目录安装：`file:<本仓库路径>`。

**配置（两个随机器不同的值）**：改 `cordis.patch.yml`

1. `args[0]` —— REA 入口文件的绝对路径：先跑 `npm root -g`，再拼上
   `\rea-agents\scripts\rea.mjs`（POSIX 用 `/`）。
2. `env.GHIDRA_INSTALL_DIR` —— 你的 Ghidra 解压目录；不用 Ghidra 时可删掉这一行。

`command: node` 走 PATH；若 harness 的 PATH 里没有 `node`，改成绝对路径。`env.JAVA_HOME`
可选，仅当 `java` 不在 PATH 上时需要。

**验证。** 调用任一 `mcp__rea__*` 工具：`binary_session` 会给出引擎检查项
（configuration / installation / headless / native_decompiler / java），应全部 `ok: true`；
随后 `open_binary` 打开一个 PE → `binary_overview` → `procedure_pseudo_code`。

**范围与注意。** REA 暴露 170+ 个工具，注入后每个会话的工具列表都会变大；行内设置
`failOnStartupError: false`，因此 REA 缺失也不会阻塞 harness 启动。部分 REA 工具会启动进程、
写文件、访问网络，按 DSH 的权限策略执行。请仅分析你已获得授权的目标。

**上游更新怎么办。** REA 的 `bin` 入口（`scripts/rea.mjs`）跨版本稳定，所以
`npm i -g rea-agents@latest` 之后本插件**无需改动**。Ghidra 受 REA 版本门槛限制（当前 12.1.x），
顺序必须是先升 REA、确认它接受新版 Ghidra 再升级。harness 升级可能改变 MCP 客户端配置结构，
用 `Config.listConfigs name=@deepseek-ai/dsh-mcp-client` 看该行 schema 并调整字段名。
`check-updates.ps1`（Windows PowerShell）会把上述四类检查一次跑完。

**许可。** 本适配器为 MIT；REA 为 MIT，版权归其作者；Ghidra 为 Apache-2.0，版权归 NSA。
本仓库不再分发上游代码。
