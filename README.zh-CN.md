# dsh-plugin-rea

[![npm version](https://img.shields.io/npm/v/dsh-plugin-rea?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-rea)

[English](README.md) · **简体中文**

把上游 **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** 的 MCP 服务接入
**DeepSeek Harness**（dsh），让它的工具在会话里以 `mcp__rea__*` 出现。

![dsh-plugin-rea：会话经官方 MCP 客户端行调用本机 rea mcp，再把 Evidence 带回会话](assets/screenshot-1.png)

> **本分支（`feat/one-plugin-bundle`）是"一体包"版本。** `main` 保留原本的纯配置型适配器 —— 它假设
> Node、`rea-agents`、Ghidra 都是你自己装好的。本分支保留同样的 patch 形态，但加了一层供给能力：
> 在一台干净机器上装上插件，它会自己把运行时准备好，然后把那一行接好。

## 这是什么

一个**带供给层的 Cordis bundle**。`package.json` 声明 `dsh.bundle.patch`，该 patch 插入一行官方 MCP 客户端
插件（`@deepseek-ai/dsh-mcp-client`）。这一行用当前运行的 Node 可执行文件启动 `bin/rea-shim.mjs`，由 shim
读取 `scripts/setup.mjs` 写下的本机状态，再拉起它供给的 REA CLI。这里没有任何分析代码，且**发布出去的
patch 里不含任何机器路径**。

> **第三方适配。** 本仓库不属于 REA，不携带 REA 的任何代码，也不由 REA 作者维护；它只组装一行配置，
> 并从上游官方源拉取上游自己的发布物。
> 上游：[github.com/morluto/rea](https://github.com/morluto/rea)（MIT）·
> [中文文档](https://github.com/morluto/rea/blob/main/README_zh.md#可以分析什么) ·
> [rea.tools](https://rea.tools/) · npm 包 `rea-agents`。
> REA 自身的问题请提给上游；**本插件**的问题提到
> [本仓库 issues](https://github.com/czcdr/dsh-plugin-rea/issues)。

**它只做三件事**：注册 `mcp__rea__*` 这批工具名；把每台机器各自的引擎环境
（`GHIDRA_INSTALL_DIR`、`JAVA_HOME`、`REA_ADB_PATH`、`REA_APKTOOL_COMMAND`、`REA_JADX_MCP_JAR`、
`REA_BROWSER_EXECUTABLE` 等）限定在那一个 MCP 子进程上、而不是整个 harness；以及把这些组件装到盘上。

## 能做什么、不能做什么

分析能力属上游，本节只是复述上游自己的契约，避免预期错位。

- **它无法还原完整源码。** 原生二进制上游给的是*伪代码与汇编*，APK 是*反编译方法*，JEB 单元是*伪代码*，
  JavaScript/Electron 是*模块及其关系*。上游的工具契约明确写着伪代码"是反编译器输出，不是原始源码，
  也不与另一 provider 的输出文本等价"。
- 实际上拿不回来的：原始标识符名、类型、注释、宏与模板展开、构建脚本与资源。优化（内联、重排）、
  符号剥离、混淆、加壳、VM 保护只会让输出更差。
- 每个结果都带**置信度与限制**（`observed` / `derived` / `inferred`，外加一份明确的 limitations 列表）。
  请当证据读，别当还原出来的源码。
- 适合：理解行为、定位实现、互操作与兼容重写、安全审阅、迁移参考。要拿真正的源码，走正规渠道 ——
  上游仓库、厂商授权，或厂商自己的 SDK。

**供给解决不了的部分。** 这些是上游的宿主门槛，不是本插件漏配了什么：

| 能力 | 门槛 |
|---|---|
| Hopper provider | 仅 macOS |
| IDA provider | 需要你自己的 IDA 与 `REA_IDA_MCP_CONFIG`；REA 从不启动 IDA |
| 固件 `binwalk` / `unblob` | 仅 Linux |
| Wakaru JS 还原、pwntools 的 ELF/宕机转储路径 | 仅 Linux x64 |
| pwndbg / gdb 核心上下文 | 仅 Linux、macOS |
| 原生 mitmproxy 抓包 | 仅 Linux（`REA_MITMDUMP_COMMAND`）；HAR 不需要引擎 |
| 苹果工具链（Mach-O、plist、资源目录、LLDB） | 仅 macOS |
| `capture_process_scenario` | 仅 Linux/macOS 的 PTY |

## 安装

**前置什么都不用装。** 在干净的 Windows x64 机器上：

```
powershell -ExecutionPolicy Bypass -File scripts\rea-bundle-bootstrap.ps1 -Reuse
```

`-Reuse` 会复用你已有的 Ghidra/JDK；去掉它则从官方发布下载两者（约 775 MB，逐个校验和验证）。然后为你的
profile 安装插件：

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea#feat/one-plugin-bundle
```

如果机器上已经有 Node，可以跳过引导脚本直接供给：

```
node scripts/setup.mjs --reuse      # 或先 --dry-run 看计划
```

反过来**先装插件**也可以，但要分两步：发布的行指向 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`，
而那个文件**只有 setup 会创建**——所以在第一次供给之前，该行会以 `MODULE_NOT_FOUND` 退出，也就没有
任何东西能去启动后台供给（harness 本身不受影响：`failOnStartupError: false` 是刻意的）。先手动跑一次
`node scripts/setup.mjs`；此后 shim 就位，之后每一次「状态缺失」都由它自己发现并在后台补供给。

## 配置 —— 不需要

发布的那一行**不含任何机器路径**：

```yaml
- insert:
    - id: mcp-rea
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js "(process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : (process.env.USERPROFILE || process.env.HOME || '') + '/.dsh') + '/plugins/rea-bundle/bin/rea-shim.mjs'"
          - mcp
        env:
          ELECTRON_RUN_AS_NODE: '1'
        failOnStartupError: false
```

这一行里有四个"承重"细节，而且**都先以 bug 的形式出现过**：

- **`!!js` 标量必须加引号。** 裸标量里同时出现 `? ` 和 `: ` 时，它就不是一个标量了：YAML 会把它读成显式键值对，于是 loader 拿到的是一个 **mapping** 而不是表达式节点。用 harness 自己的方言实测（`JSON_SCHEMA` + `app.asar` 里的 `!!js` 类型），不加引号时 `args[0]` 变成 `{"[object Object]": "..."}` —— 一个行根本无法用来启动的对象。加引号消除歧义，内部的 JS 字符串改用单引号。
- **必须用正斜杠，不能用反斜杠。** YAML 单引号标量会保留 `\` 字面量，接着 JavaScript 会把它吃掉：`'\plugins'` 不是路径而是 BEL 控制字符，`'\rea-bundle'` 变成回车、`'\bin'` 变成退格 —— 路径被静默摧毁。正斜杠在 Windows 与 POSIX 上都成立。
- **`DSH_HOME` 的兜底是 `<home>/.dsh`，不是 `<home>`。** shim、`setup.mjs`、`bootstrap.ps1` 三者都把未设置的 `DSH_HOME` 解析到 `<home>/.dsh/...`；兜底少这一层，行就会指向供给永远不会写的位置 —— 而在 `DSH_HOME` 恰好被设置的机器上，这个错误完全不可见。
- **`!!js` 表达式里没有 `path`/`require`**：`ctx` 是 loader 作用域，所以 DSH_HOME 的兜底写成纯字符串拼接。

`npm run bundle:audit` 会把前三条钉住：它用「`DSH_HOME` 未设 / 为空 / 已设」三种情形求值这个表达式，并拒绝会被 YAML 读成 mapping 的裸标量。

`ELECTRON_RUN_AS_NODE` 只在 harness 本身跑在 Electron 上时才有意义；对纯 Node 宿主无害，而显式写出来胜过依赖它恰好能在子进程环境清洗中存活。

`command` 是当前运行的 Node 可执行文件，`args[0]` 由 `DSH_HOME` 在启动时算出，所以同一份 patch 在
Windows、macOS、Linux 上都成立，且不依赖 PATH 上的 `rea`。所有机器相关的真相都放在
`<DSH_HOME>/plugins/rea-bundle/bundle.json`，由 setup 写入，可随时查看：

```
node bin/rea-shim.mjs --shim-status      # 解析到的路径、版本、校验状态
node bin/rea-shim.mjs --shim-print-env   # MCP 子进程将看到的环境变量
```

这两个命令在**插件目录**（checkout 副本）或 `<DSH_HOME>/plugins/rea-bundle`（镜像副本）里跑都给出同一
答案：checkout 副本按与 setup 相同的规则解析供给位置，镜像副本用自身位置（因为 MCP 子进程的环境里
`DSH_*` 会被剥掉，它不能依赖 `DSH_HOME`）。

设 `REA_BUNDLE_AUTO_PROVISION=0` 可关掉首次运行的后台自动供给。

想在本机把这一行改成别的启动命令（例如用你自己全局装的 `rea`），从 profile 自己的
`cordis.patch.yml` 按 id 覆盖即可 —— 那个文件是机器本地的，永不发布。一个 profile 里只允许一行使用
`serverName: rea`。

## 验证

随便发一个 `mcp__rea__*` 调用 —— `binary_session` 会报引擎各项检查
（`configuration` / `installation` / `headless` / `native_decompiler` / `java`），应当全为 `ok: true`。
然后 `open_binary` 一个 PE、`binary_overview`、`procedure_pseudo_code`。

供给本身结束时也会跑两道探针：`rea doctor --json`（如实报告，并点名未满足项），以及**与 MCP 行完全相同的
shim 启动**。

## 实测环境

作者机器，2026-10-13：

| 组件 | 版本 |
|---|---|
| REA（`rea-agents`） | **6.4.0**（170 个工具） |
| DeepSeek Harness | desktop runtime **0.2.0-rc.2**，内含 dsh CLI 0.1.7-rc.2 |
| `@deepseek-ai/dsh-mcp-client`（行 provider） | 随 harness 打包 |
| Ghidra | 12.1.4 |
| JDK | Temurin 21（供给）/ Microsoft OpenJDK 25.0.4（复用） |
| Node.js | 24.21.0（REA engines：`^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`） |
| 宿主 | Windows 11 x64（build 26200） |

实测跑过：一次干净的 `setup.mjs --reuse` 走到 `setup complete`；一次**不经 PATH 上的 `rea`、完全经由
shim** 的 MCP `initialize` 握手返回 `serverInfo {name: rea, version: 6.4.0}`。

## 边界与注意事项

- REA 在 6.4.0 有 170 个工具，每个会话的工具列表都会变长。
- 校验和对得起良心：厂商发布了的就固定并验证；没发布的（jadx-headless-mcp、apktool 包装脚本、
  Android platform-tools、滚动的 `latest` 地址）则**实测一次并记录**，之后若漂移是**报告**而不是默默接受。
  `bundle.json` 的 `unverifiedChecksums` 会列出处于该状态的组件。
- 某些网络下很慢（这里实测 GitHub release CDN 只有 0.35–0.54 MiB/s，光 Ghidra 就要 25–45 分钟）。
  下载是**可续传**的：缓存保留并重新校验，被中断的一轮会继续而不是从头再来。
- **代理**：Node 的全局 `fetch` 不读系统代理，而 .NET/PowerShell 会读。在开着 WinINET 代理的机器上，
  同一个地址 `Invoke-WebRequest` 通、Node 却 `ECONNRESET`/超时。setup 自己解析代理
  （环境变量优先，Windows 上回退读注册表）并用 CONNECT 隧道，`NO_PROXY` 也照常生效。
- REA 的部分工具会启动进程、写文件、访问网络 —— DSH 的权限策略照常适用。只分析你有权检视的样本。
- `scripts/setup.mjs` 为 REA CLI 跑的是带 `--ignore-scripts` 的 `npm install`：官方 tarball 不带
  `node_modules`，必须解析依赖闭包；而供给过程中**刻意跳过包的 lifecycle 脚本**。

## 更新 —— 三件互相独立的事

- **本插件**从不自更新。从市场装的就在市场更新；从 `file:` 检出的就覆盖目录重装。
- **从 `2.0.0-bundle.1` 升级**：那一版镜像了 shim 与 `setup.mjs`，却漏了 manifest，也没有留下插件 checkout
  的记录，所以它供给出来的 bundle **无法自愈** —— 后台供给会因缺 manifest 而崩溃且完全不可见，而它自己写下的
  lock 又会让重试被抑制六小时。请**从插件目录**重跑一次 `node scripts/setup.mjs`：它会重新镜像三个文件，
  并写下让后续运行找到真源的记录。`check-updates.ps1` 会报告这个状态。
- **供给的组件**：重跑 `node scripts/setup.mjs`，它会重新校验盘上的东西，只补缺失或不对的。
  版本钉在 `manifest/bundle.manifest.json`。
- **上游 REA / Ghidra**：改清单里的钉子再重跑 setup。REA 对 Ghidra 有版本闸门（目前 12.1.x），
  所以先更新 REA。

`check-updates.ps1`（Windows PowerShell）会一次性报告以上各项的状态。

## 许可证

MIT（本适配器）。REA 是 MIT、归其作者；Ghidra 是 Apache-2.0、归 NSA；Temurin 是 GPLv2+CE；Node.js 是
MIT；apktool、jadx-headless-mcp、Android platform-tools 各自保留自己的许可。
**本包不再分发任何上游代码或二进制** —— 供给过程是从各组件的官方源逐个拉取。
