# 宿主兼容性：DSH 0.2.1-rc.3 → 0.2.2-rc.1（2026-11-06）

`package.json` 的 `engines.dsh = ">=0.1.7-rc.2 <0.3.0-0"` 是市场判"兼容/未知"的唯一依据，
`scripts/host-compat.mjs` 的 `HOST_RELEASES` 是"本包适配过的 dsh 清单"。本轮把清单从 10 条补到 16 条，
并逐个核对新 release 有没有动本插件依赖的接口面。**结论：范围不用改，六个新 release 无一改动四个接口面；
清单补齐即可；另有两处与本次 release 无关、但需要 Lead 决策的旧问题（§4、§6）。**

---

## 0. 结论

| 项 | 结论 | 依据 |
|---|---|---|
| `engines.dsh` 要不要动 | **不动**。`0.2.2-rc.1` 仍在 `<0.3.0-0` 以内 | `node scripts/host-compat.mjs` 16 条全 `ok`，exit 0 |
| `HOST_RELEASES` | 10 → **16**（新增 6 条） | 6 个 tag 在 GitHub releases 与 npm 双向核实存在（§1） |
| floor 是否移动 | **不动**，仍是 `0.1.7-rc.2` | 没有更老版本被适配，也没有理由放弃它 |
| `OUTSIDE_HOSTS` | **不动**，仍 5 条 | 本期没有任何 0.3.x 发布，边界未变 |
| `satisfiesDeclaredRange` 窄语义 | **不动**，仍只认 `>=X <Y` | 放宽会与市场实现分叉 |
| 六个新 release 的接口面影响 | **全部无变化** | 逐条原文 + 本机运行时代码（§2） |
| 本机宿主版本 | **0.2.2-rc.1**（桌面版） | `app.asar` 内 `package.json`（§3） |
| Web 卡片在新宿主能否渲染 | **能** | `dsh-client-runtime` 是死条目但被静默跳过，`slots` 服务走的是宿主自身约定（§4） |
| 需要 Lead 改 `package.json` 的事项 | 2 条（可选清理 1 条、待决 1 条） | §6 |

---

## 1. 版本核实表

三个独立来源交叉：GitHub releases 页（`?page=1` / `?page=2`）、GitHub releases atom feed、npm registry。

- npm：`https://registry.npmjs.org/@deepseek-ai/dsh`（`versions` 42 条，`time` 给出每条的发布时间；**已发布版本在 npm 上不会被静默删除**，所以"在 `versions` 里"就是存在性的硬证据）
- GitHub 页：`https://github.com/deepseek-ai/deepseek-harness/releases?page=1` / `?page=2`（tag 形如 `dsh-v<ver>`）
- atom：`https://github.com/deepseek-ai/deepseek-harness/releases.atom`（只带最近 10 条，正好覆盖全部 6 个新版本，且**带 release body 全文**）

### 1.1 本轮新增的 6 个（用户截图里看到的）

| GitHub tag | npm 版本 | npm 发布（UTC） | GitHub release 发布（UTC） | 存在性 | 证据 |
|---|---|---|---|---|---|
| `dsh-v0.2.2-rc.1` | 0.2.2-rc.1 | 2026-11-04T09:20:32Z | 2026-11-04T13:07:14Z | **存在** | [npm](https://registry.npmjs.org/@deepseek-ai/dsh)、[releases](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) |
| `dsh-v0.2.2-alpha.3` | 0.2.2-alpha.3 | 2026-11-03T07:48:26Z | 2026-11-03T08:27:26Z | **存在** | 同上 |
| `dsh-v0.2.1-rc.5` | 0.2.1-rc.5 | 2026-10-29T14:15:23Z | 2026-10-30T02:12:26Z | **存在** | 同上 |
| `dsh-v0.2.2-alpha.2` | 0.2.2-alpha.2 | 2026-10-27T19:10:28Z | 2026-10-28T07:00:42Z | **存在** | 同上 |
| `dsh-v0.2.1-rc.4` | 0.2.1-rc.4 | 2026-10-26T15:28:13Z | 2026-10-28T03:08:57Z | **存在** | 同上 |
| `dsh-v0.2.1-rc.3` | 0.2.1-rc.3 | 2026-10-23T07:54:30Z | 2026-10-23T15:26:39Z | **存在** | 同上 |

两个时间列不同是正常的：npm `time` 是 tarball 发布时刻，GitHub `<updated>` 是 release 页面发布时刻，通常相差数小时。

`0.2.2-rc.1` 是**当前最新**：npm `dist-tags.latest = 0.2.2-rc.1`、`next = 0.2.2-rc.1`、`alpha = 0.2.2-alpha.3`；
GitHub releases 第 1 页第一条就是它。截至 2026-11-06 没有更新的发布。

### 1.2 清单里原有的 10 个

| npm 版本 | npm 发布（UTC） | GitHub tag | 证据 |
|---|---|---|---|
| 0.2.1-rc.2 | 2026-10-17T08:36:31Z | `dsh-v0.2.1-rc.2`（page 1） | npm `versions` + releases page 1 |
| 0.2.1-rc.1 | 2026-10-17T03:17:24Z | `dsh-v0.2.1-rc.1`（page 1） | 同上 |
| 0.2.1-alpha.5 | 2026-10-16T12:31:49Z | `dsh-v0.2.1-alpha.5`（page 1） | 同上 |
| 0.2.1-alpha.4 | 2026-10-15T13:08:08Z | `dsh-v0.2.1-alpha.4`（page 1） | 同上 |
| 0.2.1-alpha.3 | 2026-10-14T12:35:33Z | `dsh-v0.2.1-alpha.3`（page 2） | npm `versions` + releases page 2 |
| 0.2.1-alpha.2 | 2026-10-09T08:18:00Z | `dsh-v0.2.1-alpha.2`（page 2） | 同上 |
| 0.2.1-alpha.1 | 2026-10-03T04:53:22Z | `dsh-v0.2.1-alpha.1`（page 2） | 同上 |
| 0.2.0-rc.2 | 2026-09-29T09:56:27Z | `dsh-v0.2.0-rc.2`（page 2） | 同上 |
| 0.2.0-rc.1 | 2026-09-28T12:34:03Z | `dsh-v0.2.0-rc.1`（page 2） | 同上 |
| 0.1.7-rc.2 | 2026-09-24T14:18:11Z | `dsh-v0.1.7-rc.2`（page 2） | 同上 |

**10 条全部真实存在，没有一条被撤下**：全部出现在 npm `versions` 里（撤下的版本会从 `versions` 消失、只在 `time` 留痕），
且全部在 GitHub releases 页以 tag 出现。

`OUTSIDE_HOSTS` 里的 `0.1.7-rc.1`、`0.1.7-alpha.2` 也是真实 tag（page 2 可见）——它们是**真实存在但我们刻意不覆盖**的版本，
不是虚构的对照物。

### 1.3 排序说明（会误导下一个人，所以写进代码注释）

清单按**发布日**排序（GitHub 页面顺序），不是按 semver 优先级降序。两者在这一个位置冲突：

```
0.2.1-rc.5  发布于 2026-10-29/30
0.2.2-alpha.2 发布于 2026-10-27/28
```

按日期 `rc.5` 在前，按 semver `0.2.2-alpha.2`（更高）在前。清单取**日期序**，因为那是用户实际升级经过的顺序。
`scripts/host-compat.test.mjs` 专门 pin 了"全表 semver 降序、只有这一处例外"，所以谁想把它"修正"成 semver 序都会红。

---

## 2. 六个新 release 对本插件的接口面影响

先把"接口面"从代码里问出来，而不是凭印象列。本插件实际依赖的只有五处：

| # | 接口面 | 出处 |
|---|---|---|
| A | `cordis.patch.yml` 的 Loader YAML 方言：`insert` 行、`id` 定向、`!!js` 表达式 | `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它） |
| B | MCP 行配置 schema：`name: '@deepseek-ai/dsh-mcp-client'`、`config.serverName: rea`、`config.transport: stdio`、`command`/`args`/`env`/`failOnStartupError` | `cordis.patch.yml` |
| C | 宿主插件 API：`export const name`、`export function apply(ctx)`、`ctx.inject(['webServer'], cb)`、`ctx.effect(disposer)`、`webServer.register({ kind: 'exact', path, handler })` | `index.mjs` |
| D | 客户端 bundle 契约：`window.__ModuleLoader__.load({ id, factory })`、`factory(require)` 里 `require('react')` / `require('react-dom')`、Cordis 服务级 `inject = ["slots"]`、`ctx.slots.inject('shell.overlay', …)` | `client.js` |
| E | 市场侧 `engines.dsh` 判定：`satisfiesRange(host, declared, { includePrerelease: true })` | 本机 `dshmarket@1.66.39` 的 `lib/discovery-compatibility.js:74`（见下） |

**E 的现场取证**（`D:\dsh-home\profiles\desktop\node_modules\dshmarket\lib\discovery-compatibility.js`）：

```js
function rangeResult(hostVersion, declared) {
    return satisfiesRange(hostVersion, declared, { includePrerelease: true });
}
```

与 `host-compat.mjs` 文件头写的语义完全一致，包括"市场读**两处**申报位置、顶层 `engines.dsh` 优先"
（同文件 `manifestFacts` 里的 `engines.dsh` / `dsh.engines.dsh` 双读，注释指向 issue #577）。

### 2.1 `dsh-v0.2.2-rc.1`（2026-11-04）—— 唯一需要实证的一个

相关原文（[release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)）：

> * Update to Cordis Core 4.1.0, Loader 1.1.0, and Include 1.1.0, unifying configuration access, entry changes, and persistence behavior. by @shigma, @imccyu
> * Provide unified Cordis Fiber access to raw configuration, candidate resolution, and effective configuration, used consistently by settings and hot reload. by @shigma
> * Raise the minimum supported Node.js version to 24.9. Upgrade older Node.js runtimes before upgrading DSH. by @tianyicui
> * Activate tools conditionally per step with consistent model declarations, PTC bindings, and execution admission. **Plugins must migrate tools.resolve/executable and prompt-assembly integration.** by @LegGasai
> * Make Session Projection registration asynchronous, with plugins retaining a handle at startup. by @kermanx, @Magolor
> * Rename Custom plugin markets to Custom plugin indexes. Discover reads user-added index files, and index generation excludes private versions, tags, and default-branch packages. by @turtle2099, @turtle1999
> * Official bundle lists are now exported by `@deepseek-ai/dsh-official-bundles`; custom integrations must update imports from app-boot. by @turtle2099
> * Show rich-text plugin details in the plugin manager and improve page layout and navigation. by @turtle1999, @turtle2099
> * Support updating third-party plugin packages and attempt to restore the previous version if hot updates fail. by @turtle1999, @turtle2099

逐条判定：

| 条目 | 是否触及本插件 | 理由 |
|---|---|---|
| Cordis Core 4.0.0-rc.11 → **4.1.0**、Loader 1.0.0-rc.8 → **1.1.0**、Include → 1.1.0 | **触及（接口面 A）** | 本插件的 `cordis.patch.yml` 就是 Loader 的方言。release body 未宣告破坏性变更；**实测见下** |
| Fiber 统一配置访问 | 否 | 影响经 Fiber 读配置的插件；`index.mjs` 不读 `ctx` 配置，两行的 `config` 由 Loader 直接交给被插入的插件 |
| Node 下限 24.9 | 否（满足） | 本机宿主自带 node **24.21.0 ≥ 24.9** |
| `tools.resolve/executable` 迁移 | 否 | 本插件不注册原生 agent 工具，只有一条 MCP 行 + 一个 `webServer` 只读路由 |
| Session Projection 异步化 | 否 | 全仓 grep 无 `SessionProjection` / `sessionProjection` |
| 市场 markets → indexes、索引生成排除 private/tags/default-branch | 否（不影响判定语义） | 影响索引**生成**流程；`engines.dsh` 判定逻辑在 1.66.39 里仍是上面那行 `includePrerelease: true` |
| `app-boot` → `@deepseek-ai/dsh-official-bundles` | 否 | 本插件不 import `app-boot` |
| plugin manager 富文本 / 第三方包可更新 | 否 | 纯 UI + 更新流程 |

**接口面 A 的实测**（本会话就跑在这台 0.2.2-rc.1 宿主的 Web GUI 上）：

```
GET http://127.0.0.1:31896/dsh-plugin-rea/guide-state
→ HTTP 200
{"pluginVersion":"2.0.13","pinnedRea":"6.8.0","installedRea":"6.8.0",
 "provisionedAt":"2026-10-26T13:15:52.343Z","state":"ok","needsSetup":false, …}
```

这个 200 同时证明了三件事：`cordis.patch.yml` 的 `insert` 行被 4.1.0 的 Loader 接受并执行了（否则 `index.mjs` 不会 `apply`）、
`ctx.inject(['webServer'])` 在 4.1.0 上仍按预期解析、`webServer.register({kind:'exact'})` 的签名没变。
另外 `mcp__rea__*` 工具在本会话可用，说明接口面 B（`serverName: rea` + `transport: stdio`）在 0.2.2-rc.1 上正常工作。

> 未验证补记：Cordis 4.1.0 对 `!!js` 表达式求值作用域是否有变 —— 增量结论只覆盖**本插件实际用到的表达式形态**
> （`process.execPath`、`process.env.*` 字符串拼接、无 `path`/`require`），没做语法面全覆盖。

### 2.2 `dsh-v0.2.1-rc.4`（2026-10-26）

> * Fix diagnostics leaking into stdout in ACP mode. by @LegGasai, @tianyicui

接口面：否。这是宿主自身 ACP 模式的 stdout 洁净度修复，不改 MCP 行 schema。**值得记一笔**：它说明宿主在意
"诊断信息不能混进协议通道"，与本插件 MCP 子进程只允许 stdout 输出协议帧的约定同向，不冲突。

### 2.3 `dsh-v0.2.2-alpha.2`（2026-10-27）

与 rc.1 同批 chores 的前身，条目基本一致（Node 24.9、Session Projection 异步化、Cordis Timer 同步、
`app-boot` → `dsh-official-bundles`、市场改名 indexes、`tools` 按步条件激活、PTC/birpc、SSH 协议 2→3）。逐条判定同 §2.1 表。

两条本版特有、需要单独说明的：

> * Synchronize Cordis Timer with its upstream implementation; **custom plugins must adapt to changed return values**. by @shigma
> * Report caller-cancelled run_code calls in PTC Mode as ABORTED rather than CODE_RUN_FAILED. SDK and Session consumers must update cancellation handling. by @kermanx

- Cordis Timer：本插件用的是**全局 `setTimeout`**，不是 `ctx.setTimeout` / Cordis Timer 服务 —— `client.js:223`、`client.js:283`、
  `bin/rea-shim.mjs:756` 三处全部是 Node/浏览器的 `setTimeout`。不适用。
- PTC / `run_code`：本插件不使用 PTC。不适用。

### 2.4 `dsh-v0.2.1-rc.5`（2026-10-29）

只有一条：Improve how thinking content is displayed in conversations. by @LegGasai —— 纯展示层，接口面：否。

### 2.5 `dsh-v0.2.2-alpha.3`（2026-11-03）

新增/修复集中在统一右键与键盘菜单、文件预览目录树、变更请求与工作树、移动端布局、Trajectory 子调用折叠、
pi-ai 图片数量上限卸载、Markdown 链接行号、历史会话加载。chores 侧两条可能沾边的：

> * Allow plugins to supply dynamic pi-ai headers using Session identity and request purpose, rejecting invalid headers before dispatch. by @LegGasai
> * Allow plugins to supply navigation icons for their settings pages, restoring the default icon when unloaded. by @Magolor

两者都是**给插件的可选新增能力**（pi-ai 请求头、设置页导航图标），不注册就不用，不构成破坏。接口面：否。

### 2.6 `dsh-v0.2.1-rc.3`（2026-10-23）

> * Add More menus to the left sidebar, conversation views, and right sidebar for browsing and creating plugins. by @Yifffan, @imccyu
> * Fix New Session losing an unsent draft after switching sessions. by @imccyu
> * The DeepSeek API key adapter now updates its model list the same way as account sign-in. by @LegGasai

第一条沾"浏览和创建插件"，但落在 UI 菜单层；不触及 `engines.dsh` 判定、不触及 `dsh.client.inject`。接口面：否。

### 2.7 小结

| release | A patch 方言 | B MCP 行 | C 宿主插件 API | D 客户端契约 | E 市场判定 |
|---|---|---|---|---|---|
| 0.2.2-rc.1 | 可能有变（Cordis 4.1.0）→ **实测通过** | 无变化 | 无变化（实测通过） | 无变化 | 无变化 |
| 0.2.2-alpha.3 | 无变化 | 无变化 | 无变化 | 无变化 | 无变化 |
| 0.2.1-rc.5 | 无变化 | 无变化 | 无变化 | 无变化 | 无变化 |
| 0.2.2-alpha.2 | 见 rc.1 | 无变化 | 无变化 | 无变化 | 无变化 |
| 0.2.1-rc.4 | 无变化 | 无变化 | 无变化 | 无变化 | 无变化 |
| 0.2.1-rc.3 | 无变化 | 无变化 | 无变化 | 无变化 | 无变化 |

---

## 3. 本机宿主实测

| 项 | 值 | 来源 |
|---|---|---|
| 桌面宿主版本 | **`@deepseek-ai/dsh-desktop@0.2.2-rc.1`** | `D:\deepseekharnes\新建文件夹\resources\app.asar` 内 `package.json`（asar header → `files.package.json`，size 882，offset 207407341） |
| 运行时包 | `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1` | 同 asar 的 `dsh/package.json` |
| `hostProtocolVersion` | 4 | 同 asar 的 `dsh/desktop-runtime.json` |
| 宿主自带 Node | **v24.21.0** | `resources\runtime\primary-runtime\dependencies\node\bin\node.exe --version`；`runtime\versions.json` 里 `"node": "24.21.0"` |
| 宿主自带 pnpm | 11.28.5 | `runtime\versions.json` |
| `dsh-home` 运行时副本 | v24.21.0 | `D:\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --version` |
| PATH 上的 node | **v24.22.1**（`F:\jiuguan\node.exe`） | `node --version` / `where.exe node` |
| npm-global CLI | `@deepseek-ai/dsh@0.1.7-rc.2`，`dsh --version` → `0.1.7-rc.2` | `D:\dev\npm-global\node_modules\@deepseek-ai\dsh\package.json` |
| 已安装插件副本 | `dsh-plugin-rea@2.0.13`，`engines.dsh` 同串 | `D:\dsh-home\profiles\desktop\node_modules\dsh-plugin-rea\package.json` |
| 已装的 REA | 6.8.0（provisionedAt 2026-10-26T13:15:52Z） | `D:\dsh-home\plugins\rea-bundle\bundle.json` + guide-state 路由 |
| 当前会话宿主 | 0.2.2-rc.1（本会话的 GUI 与 `mcp__rea__*` 工具都来自它） | 运行时上下文 + `GET /` 端口 31896 |

**注意两个容易混淆的"dsh 版本"**：`dsh --version` 报的 `0.1.7-rc.2` 是 npm 全局装的 **CLI**，
不是跑本会话的桌面宿主（0.2.2-rc.1）。用 CLI 的版本号判断本机宿主会得出完全相反的结论。

### 3.1 同机历史 asar 对照（用来定位"某个包什么时候消失"）

| asar 路径 | 版本 | `@deepseek-ai/*` 包数 | 有 `dsh-client-ui-slots` 目录 | 有 `dsh-mcp-client` | 有 `dsh-official-bundles` |
|---|---|---|---|---|---|
| `D:\deepseekharnes\deepseekharnes\resources\app.asar` | 0.1.7-rc.2 | 284 | 有 | 有 | 无 |
| `D:\dsh-snapshot\20261106-2125\install\resources\app.asar` | 0.2.0-rc.2 | 289 | 有 | 有 | 无 |
| `D:\kimicode\修复\dsh-backup-20261106\program-before-repair\resources\app.asar` | 0.2.2-rc.1 | 331 | **无** | 有 | **有** |
| `D:\deepseekharnes\新建文件夹\resources\app.asar` | 0.2.2-rc.1 | 331 | **无** | 有 | **有** |

本机**没有** 0.2.1-rc.3/rc.4/rc.5、0.2.2-alpha.2/alpha.3 的桌面构建，所以"哪个版本把 `dsh-client-ui-slots` 从
`app.asar` 的 `node_modules` 里移走"**定位不到具体版本**。但 §4 证明这不需要定位——它不是接口面缺失。

---

## 4. `dsh.client.inject` 专项核实（Lead 的核心问题）

`package.json` 声明：

```json
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-slots" ] } }
```

### 4.1 四个包在 0.2.2-rc.1 宿主里到底在不在

方法：解 asar header，遍历全部 3316 个目录 / 22102 个文件；再对整份 213 MB 做字节扫描定位每个名字的所有出现。
证据路径全部在 `D:\deepseekharnes\新建文件夹\resources\app.asar` 内。

| 包名 | 有 `node_modules/@deepseek-ai/<name>/` 目录？ | 全 asar 出现次数 | 结论 |
|---|---|---|---|
| `dsh-client-connection` | **有**（`dsh/node_modules/@deepseek-ai/dsh-client-connection`，含 `lib/`、`locale/`） | 1 | **存在** |
| `dsh-client-locale` | **有**（同上结构） | 1 | **存在** |
| `dsh-client-ui-slots` | **无目录** | **89**（分布在 87 个文件的 `package.json` / `README` / `lib/client.js`，以及 `dsh-web-frontend/dist/assets/index-BgUyXZcc.js`） | **以"被引用"形式存在**：宿主自己的 8+ 个客户端包把它写进 `dsh.client.inject`，它被编进 Web 前端 bundle，不以独立包目录形式落盘 |
| `dsh-client-runtime` | **无目录** | **0（整份 asar 一次都没出现）** | **不存在**。npm 上最后一次发布是 `0.1.1-rc.2`（2026-08-21），在 0.1.7-rc.2 及之后的所有桌面宿主里都找不到它 |

`dsh-client-runtime` 的现实身份：它是 **build-time devDependency**。本机 `dshmarket@1.66.39` 的 `devDependencies` 里就有
`"@deepseek-ai/dsh-client-runtime": "^0.1.0-rc.7"`，而同一个包的 `dsh.client.inject` 只列 `dsh-client-locale`、
`dsh-client-ui-settings`、`dsh-client-ui-theme` 三个**真实宿主包**。也就是说：我们的 `inject` 把构建期依赖误写成了运行期注入项。

### 4.2 宿主拿 `inject` 干什么，目标不存在会怎样

消费方是宿主包 `@deepseek-ai/dsh-client-modules`（node 半边扫 Loader 条目里的 `dsh.client`，
把 `window.__DSH_BOOT__` 的模块图组出来；client 半边按图装载）。三段源码：

**（1）校验**（`lib/index.js` 的 `parseDshClient`，`lib/client.js` 同款）——只校验类型，不校验存在：

```js
const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`client-modules: ${subject} ${field} must be a string array`);
```

**（2）装载**（`lib/client.js:791-794`）——**这就是答案**：

```js
for (const packageName of row.inject) {
    const dependency = this.graphRows.get(packageName);
    if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
```

`graphRows.get()` 取不到就**什么都不做**：不抛错、不告警、不写日志。**未知 inject 项 = 静默跳过。**

**（3）反证：宿主自己就在这么用。** 统计宿主 331 个 `@deepseek-ai` 包的 `dsh.client.inject`，共 412 条边，
其中有一类目标**根本没有包目录**，却被核心面板引用：

```
dsh-client-ui-primitives  <- 6 个消费者：
  dsh-client-ui-jobs, dsh-client-ui-schedule, dsh-client-ui-subagent,
  dsh-experimental-client-ui-agent-team, …
```

这 6 个面板在 0.2.2-rc.1 上正常工作。所以"`inject` 目标没有独立包目录"是**宿主自身也在用的形态**，不是错误配置。

### 4.3 本插件客户端代码真正要的是什么

`client.js` 的 shape：

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-rea",
  factory: (require) => {
    const react = require("react");
    const reactDom = require("react-dom");     // 只在需要时
    const inject = ["slots"];                  // ← Cordis 服务名，不是包名
    …
    exports.inject = inject;
```

- `require(...)` 只要求 `react` / `react-dom`，**四个 inject 包一个都没 require**。所以 `dsh-client-runtime`
  即使不存在，也不会在 `factory` 里炸。
- 真正决定"卡片能不能挂上去"的是 Cordis **服务级** `inject = ["slots"]`。这是宿主自己的约定，不是我们发明的：
  在 0.2.2-rc.1 里，`dsh-client-resources`、`dsh-client-ui-brand-official`、`dsh-client-ui-action-cards`、
  `dsh-client-ui-attachment`、`dsh-client-ui-conversation` 等 8+ 个核心客户端包写的都是 `inject = ["slots"]`（或含 `slots`）。
- 挂载点是 `ctx.slots.inject("shell.overlay", mount)`（`client.js:391`），并带 `typeof ctx.slots.inject === "function"`
  的能力守卫——服务不在时不炸，只是不挂。

### 4.4 最终结论

> **能渲染。** 本插件的 Web 卡片（一次性 setup 引导）在 `0.2.2-rc.1` 上可以正常渲染，不需要为此改 `package.json`。

依据链：
1. `dsh.client.inject` 里的未知项被宿主**静默跳过**（`dsh-client-modules/lib/client.js:791-794` 源码）；
2. 本插件的 `factory` 不 `require` 那四个包，缺任何一个都不会在 factory 内失败；
3. 卡片真正的闸门是 Cordis 服务 `slots`，宿主 8+ 核心客户端包用的是同一条约定，0.2.2-rc.1 仍然成立；
4. `dsh-client-ui-slots` 在宿主里"有引用、无目录"与 `dsh-client-ui-primitives` 完全同形，后者支撑着 6 个正常工作的核心面板；
5. 宿主日志（`…\@deepseek-ai\dsh-desktop\logs\crash-2026-11-06T*`）中没有任何 `client-modules` / `inject` 相关记录；
6. 旁证：同一宿主的 node 半边（`index.mjs`）已被证明在跑（`GET /dsh-plugin-rea/guide-state` → 200）。

### 4.5 交 Lead 的 `package.json` 待办（我不动 `package.json`）

| 优先级 | 改动 | 理由 | 不改的后果 |
|---|---|---|---|
| 低（清理） | `dsh.client.inject` 删掉 `"@deepseek-ai/dsh-client-runtime"` | 该包最后一次发布 0.1.1-rc.2（2026-08-21），早于本插件声明的整个 `>=0.1.7-rc.2` 区间；它是构建期 devDependency，被误写成了运行期注入项 | 无功能后果，但会误导后续维护者，并在 `dsh.client.external`/顺序敏感的场景下留一个永假的依赖边 |

留 `@deepseek-ai/dsh-client-connection` / `-locale` / `-ui-slots` 三个：前两个有实体目录，第三个与宿主自身核心包的用法同形。

---

## 5. 本次改动清单

| 文件 | 改动 |
|---|---|
| `scripts/host-compat.mjs` | `HOST_RELEASES` 10 → 16 条，新增 `0.2.2-rc.1` / `0.2.2-alpha.3` / `0.2.1-rc.5` / `0.2.2-alpha.2` / `0.2.1-rc.4` / `0.2.1-rc.3`（发布日序，最新在前）；条目上方注释补"按发布日而非 semver 序"及唯一一处倒序；文件头补 "FLOOR AND CEILING" 段，记录 floor 未动、ceiling 未动。`OUTSIDE_HOSTS`、`satisfiesDeclaredRange`、`parseVersion`、`compareVersions`、`checkHostCoverage` **全部未动** |
| `scripts/host-compat.test.mjs` | **新增**，25 条测试（正反两面 + 三个负控） |
| `scripts/setup.test.mjs` | 仅 lead 授权的一处：`test("the release list this gate checks is the published one")` 里的 10 条字面量 → 16 条，附一句"不要改成 semver 序"的注释。其他区域未碰 |
| `docs/host-compat-2026-11-06.md` | **新增**（本文件） |

验证：

```
$ node scripts/host-compat.mjs
engines.dsh = >=0.1.7-rc.2 <0.3.0-0
  ok   0.2.2-rc.1
  …（16 条全 ok）…
  ok   0.3.0 (must stay outside)
  …（5 条全 ok）…
host range ok: 16 releases covered, 5 correctly outside
exit 0

$ node --test scripts/host-compat.test.mjs   → tests 25, pass 25, fail 0
$ node --test ./scripts/setup.test.mjs       → tests 88, pass 85, skipped 3, fail 0
```

---

## 6. 未覆盖 / 未验证（诚实清单）

1. **0.2.1-rc.3 / rc.4 / rc.5、0.2.2-alpha.2 / alpha.3 的桌面构建没有在本机实测过。** 本机只有 0.2.2-rc.1 的
   `app.asar` 和两份更老的（0.1.7-rc.2、0.2.0-rc.2）。这五个版本的"接口面无变化"是**据 release body 原文 + 0.2.2-rc.1
   运行时代码推出来的**，不是逐版本跑出来的。要变成"已验证"需要逐个装一遍。
2. **GitHub REST API 两次不可用**：第一次 `504`（网关超时），第二次 `403`（`API rate limit exceeded for 39.144.92.96`）。
   版本、日期、release body 因此取自 releases HTML 页 + atom feed + npm registry 三处交叉，没有用 API。
3. **release body 只读了最近 10 条**（atom feed 的上限）。这正好覆盖全部 6 个新版本 + 原有 4 条，但 0.2.1-alpha.3 及更早的
   原文没有逐条读（它们不是本轮新增，且 `HOST_RELEASES` 里早已在册）。
4. **中文段落是乱码来源**：atom feed 是 UTF-8，PowerShell `Get-Content` 按 ANSI 读，中文全部成 mojibake。
   本文件引用的原文**一律取英文段落**，没有从乱码回推中文。
5. **Web GUI 的视觉验证没做**：`GET http://127.0.0.1:31896/` 返回 `401 dsh web authentication required`，
   拿不到 `window.__DSH_BOOT__` 的运行时模块图（需要 `dsh web` 打印的 token）。§4.4 的"能渲染"结论来自
   源码路径 + 服务名约定 + 日志无错，**不是截图**。要补的话：拿到 token 后取 `GET /` 的 boot graph，
   确认存在 `id: "dsh-plugin-rea"` 的 row 且 `inject` 里那两条缺失项被跳过。
6. **`dsh-client-ui-slots` 到底哪个版本从 `app.asar/node_modules` 里消失，定位不到**（本机没有 0.2.1-rc.x 的桌面 asar）。
   但这不影响结论：它在 0.2.2-rc.1 上是"有引用无目录"，与宿主自身的 `dsh-client-ui-primitives` 同形。
7. **`@deepseek-ai/dsh-client-ui-primitives` 这类"无目录但被注入"的包在 Loader 侧如何解析，没有读到实现**。
   只证明了结果（引用它们的 6 个核心面板正常工作）。
8. **`engines.node` 与宿主自带 node 的矛盾未决**：`package.json` 声明 `^22.23.4 || ^24.22.1 || >=26.12.1`，
   而宿主自带 node 是 **24.21.0**（低于 24.22.1）。实际运行没出事，因为：
   `cordis.patch.yml` 的 `command: process.execPath` 只用来起 `bin/rea-shim.mjs`（跑在宿主 24.21.0 上），
   而 shim 随后 `spawn(rea.node, …)`（`bin/rea-shim.mjs:1386`），`rea.node` 取自 `bundle.json` 的
   `paths.node = F:\jiuguan\node.exe` = **24.22.1** —— 真正跑 REA 的是满足声明的那个 node。
   **未验证**的是：市场/安装前置校验是否会拿 `engines.node` 跟宿主自带 node 比。如果会，这条比 `dsh.client.inject`
   更可能挡住安装。**需要 Lead 决策**（放宽下限到 `^24.21.0`，或维持现状并要求宿主升级），我不动 `package.json`。
9. **`0.3.0` 尚未发布**：`OUTSIDE_HOSTS` 里三条 `0.3.0*` 是防线，不是已存在的版本，无法核实。
10. **`deriveHostCompatibility` 的完整判定链没有逐条验证**：只核对了 `rangeResult` 那一行
    （`includePrerelease: true`）与双读申报位置的事实。它内部对 peer 依赖、隐式上限的处理（`classifyPeer`、
    `crossesImplicitCeiling`）没有展开 —— 本插件不声明 `peerDependencies`，不进入那条路径。
