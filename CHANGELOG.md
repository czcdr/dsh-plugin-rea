# Changelog

本插件遵循语义化版本。版本号变化说明「配置组合」这层的变化，与 REA 自身的版本无关。

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
