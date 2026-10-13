# Changelog

本插件遵循语义化版本。版本号变化说明「配置组合」这层的变化，与 REA 自身的版本无关。

## 1.0.5 — 2026-10-13

把 1.0.4 留下的形状问题收尾，并让承诺过的 CI 真正跑在仓库上。

- **CI 首次真正进仓库**：1.0.4 的 CHANGELOG 与 README 都写了 `validate.yml` / `release.yml`，
  但 `.github/` 当时没有提交，GitHub 上 `actions/workflows` 是空的——现已推送并在 push 上跑通。
- **校验范围扩到示例**：机器路径检查从只查 `cordis.patch.yml` 扩到 `examples/*.yml`（读者会照抄的文件）；
  新增一步断言 npm 包必须带齐 `screenshots.json`、`assets/`、`examples/`——`files[]` 的回归守卫。
- **`examples/cordis.patch.with-env.yml` 不再提供可照抄的假路径**：原来的 `C:\tools\...` 是编造值，
  现改为 `<your Ghidra 12.1.x extraction directory>`，并补上 `!!js process.env.GHIDRA_INSTALL_DIR`
  这一「安装者零改配置」的写法（entry-list dialect 支持 `!!js`；引擎变量本来就会被 MCP 子进程继承）。
- **`check-updates.ps1` 加固**：`Test-NodeEngines` 去掉会先于函数体抛异常的类型约束；
  两个 registry 都查不通时不再静默跳过版本比对；`rea` 优先解析 `rea.cmd`（与发布行的
  `cmd.exe /c rea` 对齐，此前 `Get-Command rea` 会先命中 `.ps1` 垫片）；`rea doctor` 非零退出码会提示。
- **`assets/make-screenshots.ps1` 补 BOM**：该文件自己的注释要求 UTF-8 with BOM，此前漏做。
- **`package.json` description 真正缩短**：239 → 201 字符（1.0.4 只是改写，仍会被 npm 列表页截断）。
- **文档口径修正**：README 的 harness 版本拆成「桌面运行时 / 自带 dsh CLI」两个口径；
  投稿条目注释里的 Release 版本改为当前值。

## 1.0.4 — 2026-10-13

按外部评审修订：发布物不再携带任何机器相关路径。

- **发布用的那一行改为可移植**：Windows 用 `cmd.exe /c rea mcp`（走 PATH），macOS/Linux 用
  `command: rea` + `args: ['mcp']`；`cordis.patch.yml` 里**不再出现** `D:\...` 之类的绝对路径。
- **新增 `examples/`**：`cordis.patch.posix.yml`（POSIX 变体）、`cordis.patch.with-env.yml`（需要为
  MCP 子进程固定引擎环境时的写法）。
- **机器相关值改放本机 profile 覆盖**（`id: mcp-rea` 的 id-targeted config override）。README 两个
  语言版本都补了这一工作流；profile 覆盖永不随插件发布。
- **`check-updates.ps1` 重写**：Node engines 判断改为按 `^`/`~`/`>=` 逐项匹配（此前 Node 26+ 会误报，
  且 `[version]'6.5.0-rc.1'` 会抛异常）；node/rea/npm 不在 PATH 时有降级路径；profile 结构访问加防御；
  识别本机 profile 是否覆盖了 `mcp-rea`。
- **`files` 白名单补齐** `screenshots.json`、`assets/`、`examples/`（npm 包里也带上展示图与示例）。
- **`package.json` description 缩短**（npm 列表页会截断长描述）。
- **新增 CI**：`.github/workflows/validate.yml` 校验 manifest/JSON/YAML，并**守住"发布物不得含机器
  绝对路径"**这条约束；`.github/workflows/release.yml` 在发 Release 时自动打包成版本无关资产名并上传，
  另含（默认关闭的）npm Trusted Publishing 发布任务。
- **README 顶部去掉 awesome 徽章**：本插件尚未被该列表收录，收录后再加回。

## 1.0.3 — 2026-10-12

仓库展示与发布范围调整，无行为变更。

- 新增 `assets/screenshot-1.png`、`assets/screenshot-2.png` 与 `screenshots.json`（市场详情页展示用，
  由 `assets/make-screenshots.ps1` 可复现生成）。
- 维护记录改为**仅本机保留**：本机维护记录 `docs/project-notes.md` 既不进仓库也不进 tarball；
  投稿条目 `docs/marketplace-entry.yml` 留在仓库里，但不进 npm 包。

## 1.0.2 — 2026-10-12

文档补强，无行为变更。

- 新增「能做什么、不能做什么」：明确**无法完整还原源代码**——上游原生分析返回的是伪代码与汇编、
  APK 返回反编译的方法、JEB 返回伪代码，均非原始源码，且不保证文本等价或可直接编译；
  变量名/类型/注释/宏、优化与去符号、混淆加壳等因素都会降低可读性。
- 更新章节措辞按实际安装来源区分：从插件市场安装的在**市场里更新**，本地 `file:` 目录方式则覆盖后重装。

## 1.0.1 — 2026-10-12

文档与措辞修正，无行为变更。

- 「作用」改为依据上游 REA 自己的说明撰写（含上游列出的可分析目标），明确逆向能力由上游提供、
  本插件只做配置组合与引擎环境变量隔离。
- 新增「更新」章节，区分两件独立且都需手动完成的事：**本插件不会自动更新**（有新版时在插件
  管理器重装），上游 REA 用 `npm i -g rea-agents@latest` 更新。

## 1.0.0 — 2026-10-12

首个版本。

- 新增纯配置型 Cordis bundle：插入一条 `@deepseek-ai/dsh-mcp-client` 记录，注册 `rea mcp`（stdio）。
- 工具命名沿用官方约定 `mcp__rea__<tool>`；`failOnStartupError: false`，REA 缺失时不阻塞 harness 启动。
- 新增 `check-updates.ps1`：检查 REA(npm) / Node engines / Ghidra 版本与 doctor 子项 / 插件登记状态。
- 实测矩阵：REA 6.4.0、DSH 桌面运行时 0.2.0-rc.2、Ghidra 12.1.4、Node 24.21.0、Windows 11 x64。

<!--
维护提示（发布新版本时）：
1. 改 package.json 的 version，并在此文件顶部加一节；
2. 若改动涉及路径/字段，同步更新 README 的「配置」与「上游更新怎么办」；
3. 若发 Release tarball，资产名保持不带版本号（dsh-plugin-rea.tgz），
   否则市场里 latest/download 形式的链接会在下次发版后 404。
-->
