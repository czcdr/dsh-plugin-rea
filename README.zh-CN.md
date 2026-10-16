# dsh-plugin-rea

[![npm version](https://img.shields.io/npm/v/dsh-plugin-rea?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-rea)

[English](README.md) · **简体中文**

把上游 **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** 的 MCP 服务接入
**DeepSeek Harness**（dsh），让它的工具在会话里以 `mcp__rea__*` 出现。

![dsh-plugin-rea：会话经官方 MCP 客户端行调用本机 rea mcp，再把 Evidence 带回会话](assets/screenshot-1.png)

## 这是什么

一个**纯配置型 Cordis bundle**。`package.json` 声明 `dsh.bundle.patch`，该 patch 插入一行官方 MCP
客户端插件（`@deepseek-ai/dsh-mcp-client`）的记录，指向你本机已安装的 `rea mcp`（stdio）服务。
本仓库不含任何分析代码。

> **第三方适配。** 本仓库不是 REA 项目的组成部分，不分发 REA 的任何代码，也不由 REA 作者维护；
> 它只组合一行配置。
> 上游：[github.com/morluto/rea](https://github.com/morluto/rea)（MIT）·
> [文档](https://github.com/morluto/rea#what-you-can-analyze) ·
> [中文文档](https://github.com/morluto/rea/blob/main/README_zh.md#可以分析什么) ·
> [rea.tools](https://rea.tools/) · npm 包 `rea-agents`。
> REA 自身的问题请提到上游；**本插件**的问题提到
> [本仓库 Issues](https://github.com/czcdr/dsh-plugin-rea/issues)。

**它只增加两件事**：把工具注册成 `mcp__rea__*`，以及让引擎环境变量（`GHIDRA_INSTALL_DIR` 等）
只作用于这个 MCP 子进程，而不是整个 harness。

## 能做什么、不能做什么

分析能力由上游提供；这里只复述上游自己的契约，避免预期错位。

- **无法完整还原源代码。** 上游对原生二进制返回的是**伪代码与汇编**，对 Android APK 返回
  **反编译的方法**，对 JEB 单元返回**伪代码**，对 JavaScript/Electron 返回**模块及其关系**。
  上游的工具契约明确写着：伪代码是反编译器输出，**不是原始源码**，且与其他提供方的输出
  **不保证文本等价**。
- 实践中不可恢复的内容：原始标识符命名、类型、注释、宏与模板展开、构建脚本与资源；
  优化（内联、指令重排）、去符号（strip）、混淆、加壳与 VM 保护只会让可读性更差。
- 每条结论都自带**置信度与限制**（`observed` / `derived` / `inferred`，另有 limitations 列表）：
  请把它们当作证据使用，而不要当作「已还原的源码」。
- 适合做：理解行为、定位实现、互操作与兼容实现、安全审计、迁移参考。
  **要拿到真正的源码，请走正规渠道**——上游代码仓库、厂商授权，或厂商自己的 SDK。

## 实测版本

作者机器，2026-10-12/13：

| 组件 | 版本 |
|---|---|
| REA（`rea-agents`） | **6.5.0** |
| DeepSeek Harness | 桌面运行时 **0.2.0-rc.2**，自带 dsh CLI 0.1.7-rc.2 |
| `@deepseek-ai/dsh-mcp-client`（行提供方） | 由 harness 自带；npm 最新 `0.0.1-rc.1` |
| Ghidra | 12.1.4（REA 当前接受 12.1.x） |
| Node.js | 24.21.0（REA engines：`^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`） |
| 主机 | Windows 11 x64 |

发布用的这一行**实测跑通过**：`list_documents` 在 `cmd.exe` 形式下正常应答，`open_binary` 走
`ghidra` 提供方成功，而引擎目录仅来自本机 profile 覆盖。

## 安装

**前置条件**

- Node.js 满足 REA 要求（`^22.19.0 || ^24.11.0 || >=26.0.0`）。
- 全局安装 REA CLI：`npm i -g rea-agents`。
- 原生分析需要 Ghidra **12.1.x**（Hopper / IDA 为替代方案，各自需授权）；
  静态 JavaScript/Electron 与 .NET 分析不需要引擎。

**安装插件**

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea
# 或从 npm 安装：
dsh plugin --profile <profile> add dsh-plugin-rea
```

[Releases](https://github.com/czcdr/dsh-plugin-rea/releases) 附带预构建 tarball（资产名不带版本号，
链接不会失效）。

## 配置——通常什么都不用改

发布出去的那一行**不含任何机器相关路径**：

- Windows：`command: cmd.exe`、`args: ['/c', 'rea', 'mcp']` —— npm 的 shim 是 `.cmd`，必须经 shell。
- macOS/Linux：`command: rea`、`args: ['mcp']` —— 见
  [`examples/cordis.patch.posix.yml`](examples/cordis.patch.posix.yml)。

唯一可选的是分析引擎。REA 从环境读取 `GHIDRA_INSTALL_DIR`，二选一：

1. 设为**系统级环境变量**，然后重启 harness（让 MCP 子进程继承）；
2. 只为这个 MCP 子进程指定 —— 见
   [`examples/cordis.patch.with-env.yml`](examples/cordis.patch.with-env.yml)。

两种方式都不需要写死路径：客户端会把父进程环境传给子进程（只剔除名字像密钥的变量），
而补丁方言支持 `!!js` 表达式，所以 `GHIDRA_INSTALL_DIR: !!js process.env.GHIDRA_INSTALL_DIR`
同样可用。

**机器相关值不要写进插件。** 用你自己的 profile `cordis.patch.yml` **按 id 覆盖**这一行即可；
该文件只在你本机、永不随插件发布：

```yaml
- id: mcp-rea
  config:
    env:
      GHIDRA_INSTALL_DIR: '<你的 Ghidra 12.1.x 目录>'
```

同一 profile 内 `serverName: rea` 只能有一条记录。

## 验证

调用任一 `mcp__rea__*` 工具：`binary_session` 会给出引擎检查项
（configuration / installation / headless / native_decompiler / java），应全部 `ok: true`；
随后 `open_binary` 打开一个 PE → `binary_overview` → `procedure_pseudo_code`。

## 范围与注意

REA 在 6.5.0 暴露 207 个工具，注入后每个会话的工具列表都会变大；行内设置
`failOnStartupError: false`，因此 REA 缺失也不会阻塞 harness 启动。部分 REA 工具会启动进程、
写文件、访问网络，按 DSH 的权限策略执行。请仅分析你已获得授权的目标。

## 更新：两件事，且都要手动

- **本插件**不会自动更新。**从插件市场安装的，就在市场里更新**；本地 `file:` 目录方式安装的，
  覆盖目录后在插件管理器里重装。下面更新 REA **不会**更新本插件，反过来也一样。
- **上游 REA**：用 `npm i -g rea-agents@latest` 更新。它的 `bin` 入口（`scripts/rea.mjs`）
  跨版本稳定，所以本插件无需改动。
- **Ghidra**：受 REA 版本门槛限制（当前 12.1.x），先升 REA，再确认它接受新版 Ghidra。
- **DeepSeek Harness**：升级可能改变 MCP 客户端配置结构，用
  `Config.listConfigs name=@deepseek-ai/dsh-mcp-client` 看该行 schema 并调整字段名。

`check-updates.ps1`（Windows PowerShell）会把上述四项一次跑完；
`.github/workflows/validate.yml` 在 CI 里守住 bundle 的形状（含「发布物不得含机器路径」这一条）。

## 许可

本适配器为 MIT；REA 为 MIT，版权归其作者；Ghidra 为 Apache-2.0，版权归 NSA。
本仓库不再分发上游代码。
