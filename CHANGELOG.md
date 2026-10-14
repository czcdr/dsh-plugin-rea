# Changelog

本插件遵循语义化版本。版本号变化说明「配置组合」这层的变化，与 REA 自身的版本无关。

## 2.0.0-bundle.2 — 2026-10-14

一体包分支的**正确性修复**。这一轮把「装一个插件、它自己供给」这条链路从"永远启不动"修到实测可用，
并把每一个修掉的坑都变成审计或 CI 能自动抓住的检查。

### 🔴 三个致命缺陷（按旧版说明走的用户每一步都会撞上）

- **MCP 行里的 `!!js` 标量没有加引号。** 裸标量同时含 `? ` 与 `: ` 时，YAML 把它读成**显式键值对**，
  loader 拿到的是 mapping 而不是表达式节点。用 harness 自己的方言实测（`JSON_SCHEMA` + `app.asar` 里的
  `!!js` 类型定义），`args[0]` 变成 `{"[object Object]": "..."}` —— 这一行**从来没有可能启动**。
  现改为双引号标量，内部 JS 字符串用单引号。
- **`DSH_HOME` 的兜底少了一层 `.dsh`。** 行回退到裸 home，而 shim、`setup.mjs`、`bootstrap.ps1` 都回退到
  `<home>/.dsh`。全归档扫描确认 **DSH 从不设置 `DSH_HOME`**（宿主进程内 0 处写入，只在 shell 工具子进程的
  执行覆盖层注入），所以这是**默认路径**而不是边缘情况：行永远指向供给不会写的位置。
- **镜像副本缺 manifest。** 镜像后的 `setup.mjs` 用它自己所在的位置推导 plugin root，于是 `loadManifest()`
  去读 `<bundle>/manifest/bundle.manifest.json` —— 一个只有镜像步骤才能创建的文件。由 shim 触发的后台供给
  会以裸 ENOENT 崩溃；`stdio: "ignore"` 让它完全不可见，而它已写下的 lock 又让重试被抑制六小时。

### 🟡 一并修掉的

- **shim 改用自身位置定位 bundle。** MCP 子进程的环境会剥掉所有 `DSH_*`（大小写不敏感），所以自定义
  `DSH_HOME` 时旧 shim 会去 `~/.dsh` 找 `bundle.json`、报"未供给"，然后**在错位置再供给一次 800 MB**。
  `bundleRoot()` 现在返回 `<shim 所在目录>/..`，与 `DSH_HOME` 是否可见无关。
- **新增镜像记录 `mirror.json`。** 真源运行会写下插件 checkout 的位置；镜像副本据此回到真源，插件升级后
  不会永远用旧 manifest 供给。记录失效（目录被移动/删除）时优雅回退到本地副本。
- **空值环境变量。** `REA_BUNDLE_ROOT=""` / `DSH_HOME=""` 原先会把 root 算成 `""` 或相对路径 —— 前者
  `mkdir ''` 崩在任何日志之前，后者把 bundle 装进 cwd。现在统一 trim 后回退；`--root`/`--cache` 一律
  `path.resolve`（相对 root 会让 `bundle.json` 记下相对路径，shim 随即误判组件"已消失"并重新供给）。
- **`fail()` 的修复命令**不再指向"存在但必然崩溃"的镜像副本；没有可信副本时给出明确指引。
- **`check-updates.ps1`** 增加「镜像 manifest 是否就位」检查，指向上面那条升级路径。
- **shim 的两份副本各自解析出正确的 bundle root。** 上面那条"用自身位置"只在**镜像副本**上成立：
  插件 checkout 里的那份是插件而不是 bundle，于是 `npm run bundle:status` 会在已供给的机器上报
  "未供给"，而裸跑 `node bin/rea-shim.mjs mcp` 会把约 800 MB 下载进**插件目录**。现在用
  `cordis.patch.yml`（只有 checkout 会带）区分两者：镜像副本用自身位置（MCP 子进程里读不到
  `DSH_HOME`），checkout 副本按与 setup 相同的规则解析。setup 结尾打印的 `status:` 命令也改为指向
  镜像副本，这样它对自定义 `--root` 同样成立。
- **裸跑 shim 不再启动任何东西。** `package.json` 把这个文件暴露为 `rea-bundle-status` bin，而 npm 的 bin
  转发只能原样传参、**无法追加 flag**，于是"裸跑一个叫 status 的命令"会掉进启动路径：在已供给的机器上
  启动 REA，在未供给的机器上**开始约 800 MB 下载** —— 与这个名字承诺的正好相反。现在无参数时打印用法并
  退出（真实退出码 0），MCP 行不受影响，因为它始终显式传 `mcp`。
- **README 的「先装插件也可以」改为诚实描述。** 发布的行指向的镜像 shim **由 setup 创建**，所以在第一次
  供给之前该行以 `MODULE_NOT_FOUND` 退出 —— 没有任何东西能启动后台供给。首次必须手动跑一次
  `setup.mjs`，此后才由 shim 自动补供给。

### 回归防护

- `audit-manifest.mjs` 新增五项，全部做过反向验证（**故意写坏 5/5 都被抓住**）：`!!js` 裸标量 mapping
  检测、`DSH_HOME` 三态（未设/空/已设）求值一致性、README 与 patch 表达式不得漂移、镜像清单必须含
  manifest、镜像清单**不得**携带 `cordis.patch.yml`（它是 shim 区分两份副本的判据，被镜像进去会让镜像
  副本退回 `DSH_HOME` 规则）。另外把「`DSH_HOME`/`USERPROFILE`/`HOME` 全空 → 根路径」这个**已知无害
  行为**钉成 warn（此前无覆盖）：该情形下该行报 `MODULE_NOT_FOUND`，不写文件、不下载，harness 照常。
- `validate.yml`：YAML 步骤注册 `!!js` 标量构造器（原先 `safe_load` 直接拒绝这个仓库要发布的行 ——
  **CI 一直是红的**）；行契约步骤断言 `args[0]` 是标量、不是 mapping；新增 `bundle:test` 与 `bundle:audit` 两步。
- 单元测试新增四条**真的去 spawn shim**的用例（镜像布局、checkout 布局、`REA_BUNDLE_ROOT` 覆盖、裸跑只
  打印用法），并逐条做过反向验证：把 shim 改回"一律用自身位置"时 checkout 那条会红；去掉裸跑守卫时裸跑
  那条会红（后者自带桩保护，即使回退也只会跑到桩、不会下载）。
- 单元测试里的 POSIX 退化断言加平台守卫（`EXE` 为空时 `endsWith("java")` 恒真，在 Linux 上必红；
  WSL 实测修前 12/13、修后 17/17）。

### 升级说明

已部署过 `2.0.0-bundle.1` 的机器**无法自愈**（旧镜像既缺 manifest 也没有真源记录）：请从**插件目录**
重跑一次 `node scripts/setup.mjs`。

## 1.0.6 — 2026-10-13

文档结构调整，无行为变更。

- **README 拆成两份**：`README.md`（English，GitHub 默认展示）与 `README.zh-CN.md`（简体中文），
  两份顶部互相链接。此前是单文件里英文、中文各占一半，另一种语言的读者要先滚过整段才能到自己的部分。
- **改为真正的分节标题**：原来大量用**粗体当小标题**，加上一个横跨半篇的引用块，整页读起来像一堵墙；
  现在每种语言各有一份正常的 `##` 结构，并把「安装」拆出「前置条件 / 安装插件」两小节。
- **内容要点一条未删**：第三方适配声明（不含上游代码、不由上游维护、问题去向）、能力边界
  （无法完整还原源码 / 不可恢复清单 / 置信度与限制 / 正规获取渠道）、实测矩阵、三种引擎配置写法
  （OS 变量、`env:` 块、`!!js`）、profile 按 id 覆盖、`serverName` 唯一、验证步骤、
  `failOnStartupError: false` 与权限注意、更新语义（本插件 / REA / Ghidra / harness）、许可证归属。
- `package.json` 的 `files` 与 `validate.yml` 的 npm 载荷断言同步收录 `README.zh-CN.md`。

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
