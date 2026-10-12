# 项目记录 / Project notes

本文件是本仓库的**持久状态记录**（比会话记忆更长命）：发布状态、维护决策、待办与外部约束。
新会话或新维护者可先读这里，再读 README 与 CHANGELOG。

_最后更新：2026-10-12_

## 1. 这是什么

上游 **REA（Reverse Engineer Anything，<https://github.com/morluto/rea>，MIT）** 的第三方 DSH 适配插件。
本插件**不做逆向分析**：它把 REA 的 MCP 服务器注册进 DeepSeek Harness，得到 `mcp__rea__*` 工具，
并把引擎环境变量限制在该 MCP 子进程内。

## 2. 发布状态

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/czcdr/dsh-plugin-rea>（公开，MIT） |
| 形态 | 纯配置型 Cordis bundle：`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml` |
| 工具命名 | `mcp__rea__<tool>`（serverName = `rea`，transport = stdio） |
| Release 资产 | 固定名 `dsh-plugin-rea.tgz`（**版本无关**，避免 `latest/download` 烂链） |
| 直装链接 | `https://github.com/czcdr/dsh-plugin-rea/releases/latest/download/dsh-plugin-rea.tgz` |
| 市场条目 | 见 `docs/marketplace-entry.yml` |

实测矩阵（作者机器，2026-10-12）：REA `6.4.0` / DSH 桌面运行时 `0.2.0-rc.2` /
`@deepseek-ai/dsh-mcp-client` 由 harness 自带（npm latest `0.0.1-rc.1`）/ Ghidra `12.1.4` /
Node `24.21.0` / Windows 11 x64。

## 3. 市场收录状态

- **topic 型市场**：仓库已带 `dsh-plugin` topic，dsh-feed / dsh-plugin-mall /
  DSH-Plugins-Marketplace 等按各自同步周期自动抓取，无需操作。
- **精选列表 awesome-dsh-plugin**：PR 制，提交 `data/plugins/czcdr__dsh-plugin-rea.yml` 一个文件。
  其 CI 要求**仓库创建满 1 天**：本仓库建于 `2026-10-12T14:42:26Z`，
  因此 PR 最早在 **`2026-10-13T14:42Z`（北京时间 22:42）** 之后提交才过 CI。
  投稿内容已提交到 fork `czcdr/awesome-dsh-plugin` 的同名路径，可直接开 PR。
- **npm**：未发布（本机 npm 未登录）。市场收录不依赖它，仅影响下载量展示。

## 4. 更新语义（易混淆，务必区分）

| 对象 | 更新方式 |
|---|---|
| **本插件** | **不会自动更新**。从插件市场安装的 → 在**市场里更新**；本地 `file:` 目录安装的 → 覆盖目录后重装。 |
| **上游 REA** | `npm i -g rea-agents@latest`。其 `bin` 入口 `scripts/rea.mjs` 跨版本稳定，插件无需改动。 |
| **Ghidra** | 受 REA 版本门槛限制（当前 12.1.x）：先升 REA，确认它接受新版 Ghidra 再升。升级需改两处：用户环境变量 `GHIDRA_INSTALL_DIR` 与 `cordis.patch.yml` 的 `env.GHIDRA_INSTALL_DIR`。 |
| **DeepSeek Harness** | 升级可能改变 MCP 客户端配置结构；用 `Config.listConfigs name=@deepseek-ai/dsh-mcp-client` 看该行 schema 后调整字段名。 |

`check-updates.ps1` 一次跑完上述四项检查（只读）。

## 5. 维护决策记录

- **为什么不做成"完整逆向源码"的承诺**：上游自己的工具契约写明——原生分析返回**伪代码与汇编**，
  不是原始源码，且"pseudocode is Ghidra decompiler output, not original source and not
  text-equivalent to Hopper output"；APK 返回反编译的方法；JEB 返回伪代码。
  因此 README 增设「能做什么、不能做什么」，明确**无法完整还原源代码**。市场审核会逐条核对
  描述与代码，夸大描述是主要打回原因，这条也降低了被误读的风险。
- **为什么用 `!!js` 之外的写法（字面路径）**：配置型 bundle 的 `command`/`args` 由 MCP 客户端
  直接 spawn，相对路径不可靠；`command: node` 走 PATH，只留 `args[0]` 与 `GHIDRA_INSTALL_DIR`
  两处随机器不同，README 已列明改法。
- **为什么 Release 资产名不带版本号**：市场的 `latest/download/<name>` 会按字面取文件名，
  带版本号的文件名会在下次发版时静默 404（市场文档明确警告过）。
- **为什么不写上游 `rea update`**：那是 REA 自身的更新命令，与本 DSH 插件无关，
  容易让用户以为插件会自动更新；已从 README 与脚本中移除。

## 6. 环境约束（作者机器，2026-10-12）

- `github.com` 的 **git 传输被墙**（Connection reset），`git clone/push` 不可用；
  仓库操作全部走 `gh` CLI / `api.github.com`（建仓、上传文件、topics、description、Release 均可）。
- `raw.githubusercontent.com` 经 `web_fetch` 失败，经 PowerShell 可访问。
- npm 官方源与 npmmirror 均可用；npm 未登录。
- 记忆服务（Hindsight）未配置 token，写入返回 401 —— 本文件即为该状态下的本地持久化替代。

## 7. 待办

- [ ] 仓库满 1 天后提交 awesome-dsh-plugin 的 PR（fork 内容已就绪）。
- [ ] 可选：仓库内加 `screenshots.json`（1-8 张 GitHub 托管图片）供市场详情页展示。
- [ ] 可选：`npm publish`（需先登录；包名 `dsh-plugin-rea` 可用；`repository` 字段已指回仓库）。
- [ ] 上游 REA 有新版本后：跑 `check-updates.ps1`，并同步 README 的验证矩阵与本文档。
