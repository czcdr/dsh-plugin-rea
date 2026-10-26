# Changelog

本插件遵循语义化版本。版本号变化说明「配置组合」这层的变化，与 REA 自身的版本无关。

## 2.0.13 — 2026-10-26

**上游 REA 从 6.7.0 升到 6.8.0。这一次上游**同时抬高了 Node 的 engines 下限**，所以不是只改一个版本号 ——
钉子、`package.json` 的 engines、以及 node probe 的三处措辞必须一起动，否则「声明一套、执行另一套」。**

### 变更

- **`pins.reaAgents` → 6.8.0**（= `components.reaAgents.sources.npm.version`），probe 改为 `^6\.8\.0(\s|$)`。
  6.8.0 是 npm `latest`（发布 2026-10-25T09:07Z）；tarball 2398 条 / 0 条 `node_modules`，仍走
  `npm install --ignore-scripts` 解析闭包；闭包只多两个包（`@bufbuild/protobuf 2.16.0`、`@msgpack/msgpack 3.1.3`）。
- **工具数 207 → 229（+22）**，另 175 条 CLI 命令、6 个 prompt。随包 `dist/mcp-catalog.json` 记录
  `identity.counts` 与三个 digest（`tools_sha256 a98940ba…`），不再是「只能靠 doctor 现场数」。新增族：
  APK 签名、binary diagnostics（PE 证书/导入/加载配置、ELF notes、内核模块、devicetree、Apple IPS、字节熵）、
  模型文件（GGUF/safetensors）、CUDA/HIP 代码对象。**这是工具扩容，不是修 bug 版本。**
- **engines 下限抬升**：`^22.19.0 || ^24.11.0 || >=26.0.0` → `^22.23.4 || ^24.22.1 || >=26.12.1`。同步改了
  `package.json engines.node`、`manifest.pins.nodeEngines`、以及 node probe 正则 —— probe 没有比较器，只能写成
  一条交替（22.23.4–22.23.x / 22.24+ / 24.22.1–24.22.x / 24.23+ / 26.12.1–26.12.x / 26.13+ / 27+），
  并用 24 组版本正反验证（22.23.3、24.22.0、26.12.0 必须拒；20.x 与 25.x 仍拒）。
  **后果**：6.7.0 时代合法的 Node 22.19–22.23.3、24.11–24.22.0 现在会被 reuse 路径拒掉 —— 钉住的 **24.22.1
  正好是 24 线的下限**，既是最新也是最低可接受。
- **其余钉子一个没动**：Ghidra 仍 12.1.4（6.8.0 的 `SUPPORTED_GHIDRA_VERSION` 未变，12.2 仍 `unsupported`）、
  jadx 仍 0.7.1（6.8.0 的 `JADX_RELEASE.sha256` 与盘上 0.7.1 jar 逐字节相同）、JDK 21.0.12.1（Adoptium 21 线的
  Windows 资产仍停在 21.0.12.1）、apktool 3.0.3、platform-tools 37.0.1、Node 24.22.1。

### 验证

- 单测 **88 条**（85 过 / 3 平台跳过 / 0 失败）；`audit-manifest` **24/24 hash-pinned clean**；
  `verify-branch.ps1` **ALL CHECKS PASSED**；`host-compat` 10 covered / 5 outside。
- 真机（Windows 11 x64）：`setup.mjs --reuse` → `probe cli=6.8.0 tools=229`，末尾 Ghidra 冒烟 26 s 导入
  `java.exe`，shim 解析 6.8.0；另起一次独立 stdio MCP 握手 → `serverInfo {name: rea, version: 6.8.0}`、
  **229 tools / 6 prompts**、protocol `2024-11-05`。
- 把 6.8.0 自己的发布策略加载执行：`12.1.4 → verified`、`12.1.5 → compatible`、`12.2 → unsupported`；
  `JADX_RELEASE` 仍是 0.7.1 / `6e5eacf5…`。apktool 3.0.3、`adb` 37.0.1 (1.0.41) 现场复核。
- 文档：两份 README 的版本表/工具数/engines 句子、`docs/bundle-design.md` 的实测行、
  新报告 [docs/update-review-2026-10-26.md](docs/update-review-2026-10-26.md)。

### 升级 / 排障

- 已供给的机器**不会自动换到 6.8.0**（auto-provision 只在「未供给」时触发）：重跑
  `node scripts/setup.mjs --reuse`，再重启 dsh 让 MCP 行重连。
- **`npm install` 报 `ECONNRESET` 时先查代理，不要怀疑哈希。** setup 的 npm 子进程不继承本脚本自己的代理路由；
  直连 registry 的 tarball 会失败并以 `-4077` 收场，reify 回滚后 probe 仍报旧版本（读起来像「升级没生效」）。
  设 `HTTPS_PROXY` / `HTTP_PROXY` 后重跑即可 —— 本轮就是这么过的。

## 2.0.12 — 2026-10-23

**2.0.11 的引导卡片给了升级用户一条会让它重下约 570 MB 的命令。这一版只修那一处。**

### 修复

- **引导卡片的命令缺 `--reuse`**：这张卡片主要出现在**升级之后**，而那时运行时已经在机器上；不带这个参数，`setup.mjs` 会重新下载 JDK + Ghidra（约 570 MB）—— 既是「对齐运行时」的反面，也让一次本该几十秒的升级变成十几分钟。首次安装时该参数不产生任何代价：每个候选都会被探测，机器上没有就照常下载。
- **卡片没有说明 setup 末尾的引擎验证**：`setup.mjs` 现在会用 JDK 自带的 `java` 跑一次真实分析（实测 32–42 秒）。没有这句，用户会以为进程卡死。
- **卡片没有说明并发锁**：shim 的后台供给与手动 setup 相撞时，后者以 **75** 退出并报出持有者的 pid 与日志路径。卡片现在把这句话写出来，免得用户把它当成故障。

### 验证

- 单测 **88 条**（85 过 / 3 平台跳过），`verify-branch.ps1` ALL CHECKS PASSED，`audit-manifest` clean（24/24 hash-pinned）。
- 引导命令以新进程求值确认：`node "…/scripts/setup.mjs" --reuse`。
- 卡片的两条新说明在中英文里各存在一份，并各自渲染为列表项。

### 升级

市场更新到 2.0.12 后，卡片给出的命令就带上 `--reuse` 了；本机若已装 2.0.11，重启一次 dsh 才会看到新卡片（host 侧的模块在进程内缓存）。

## 2.0.11 — 2026-10-23

> **发布说明（致使用者）**
>
> 这一版比预期晚了一点，两件事叠在一起：一方面我还在上学，课业与考试挤在同一周；另一方面，这一版真正要处理的是
> **昨晚才公开的漏洞**——上游在 10/21–10/22 连续放出 Node 24.22.1：Brotli 解码器越界写（可远程触发 RCE）、
> 两处 TLS 主机名绕过、以及 eMudhra 中间 CA 的移除。漏洞窗口本身就是昨晚才打开的，晚的这部分是「等补丁、
> 等验证、跑通再发」，不是拖。
>
> **本次更新的主因（按重要性）**
>
> 1. **把自供给的 Node 升到 24.22.1。** 干净环境过去会下载 24.21.0 —— 那正是带漏洞的版本；本机因为 `--reuse`
>    拿了系统里的新 Node 所以看不出来，但别人第一次装就会踩上。现在六个平台的 manifest 源全部换成 24.22.1
>    （校验和取自官方 `SHASUMS256.txt`；win32-x64 在本机下载、比对、解包并跑通 `node -v` / `npm -v` 后才写入）。
> 2. **供给侧不再「看起来成功」。** 复用的 JDK / Ghidra / Node 现在记录它们**自己的**版本（而不是跑 setup 的
>    解释器或 manifest 的钉子）；供给期的 `doctor` 检查的是**本次供给的**引擎，而不是机器上恰好存在的那个；
>    供给末尾会真跑一次 Ghidra 导入——`doctor` 只验证路径与版本，从不导入二进制，桥接坏了过去只能在第一次
>    MCP 调用超时时才发现。
> 3. **审查轮 10 处修复。** manifest 审计里一项永不触发的检查、零参数启动静默退出 0、解压失败销毁旧安装、
>    `setup.lock` 不构成互斥等 —— 逐条见下方「修复 · 审查轮」。

**shim 层五个缺陷修复。不动供给流程、工具注册与 REA 钉子；改的是「找系统 REA、后台供给失败、读记录」这三条边缘路径。**

### 新增

- **首次安装与每次升级插件后，Web GUI 显示一次「还要跑一次 setup」提示**（`client.js` + `index.mjs`）：
  - 触发不看「弹过没有」，而看**事实**：`GET /dsh-plugin-rea/guide-state` 把
    `<DSH_HOME>/plugins/rea-bundle/bundle.json` 里记录的 REA 版本与本包 manifest 的钉子比对，
    返回 `missing` / `stale` / `unknown` / `unreadable` / `ok` 之一（`bin/rea-guide.mjs` 里的纯函数，
    带点的钉子精确比对、只有主版本号的按家族比对，与 `scripts/pin-match.ps1` 同一套规则）；
  - 文案给出**这次安装**的完整命令（路径随市场解包位置变化），并写明「只对齐运行时、不更新插件包」；
  - 点「稍后」或「我已运行」后按**插件版本**记入 localStorage：同一版本不再弹，升级换了版本后重新提示一次；
  - 该 route 只在宿主有 `webServer` 时挂载（`ctx.inject(['webServer'])`），headless/ACP 主机行为不变；
  - 它只是提示：不 spawn、不下载、不改 `bundle.json`，也不跑 setup。
- **`setup.mjs` 末尾新增 Ghidra 冒烟（`smoke` 步，`--skip-smoke` 可关）**：`rea doctor` 只校验路径、版本与
  会用哪个 Java，**从不导入一个二进制**。首次真实导入要付一次性成本（本机实测：小 PE 约 36 s，6 MB DLL 约 64 s），
  一旦桥接或 native addon 有问题，操作者只在**第一次 MCP 工具调用超时**时才撞见 —— 那读起来就是「升级把 REA 搞坏了」。
  现在供给结束会用 JDK 自带的 `bin/java` 跑一次 `rea analyze --json`，把「能不能分析」变成有测量结果的结论；
  失败即 `FAIL` 并计入退出码。`--skip-smoke` 跳过（CI 或低内存机器）。

### 修复

- **`systemReaCandidates` 的平台分隔符取错了对象**：`path.delimiter` 与 `path.join` 跟随的是「当前进程」的平台，
  而函数入参是 `platform`。注释一直声称测试能在同一台机器上模拟两种形态 —— 实际做不到：POSIX 上模拟 `win32` 会把
  `;` 分隔的 PATH 按 `:` 切开，候选全部指向不存在的碎片。现在分隔符与 `resolve` / `isAbsolute` / `join` 一律跟随
  `platform`（生产环境两者相同，因此这只是测试缝的问题，但缝必须是真缝）。
- **后台供给的 spawn 失败会留下幽灵锁，异步 `error` 还会打死 shim**：`spawn` 同步抛错时锁停在
  `state:"running"` + 本进程 pid；更常见的是异步 `error`（ENOENT/EACCES/ENOMEM）—— `ChildProcess` 没挂监听器，
  EventEmitter 直接抛未捕获异常，shim 无声退出，锁仍指向一个「活着的」pid。PID 被系统复用后，下一次启动会被判成
  `in-flight`，自动供给停摆 6 小时且没有任何日志。现在：同步失败删锁；异步失败把锁改写成 `state:"failed"` 并往
  `logs/setup.log` 记一行原因。
- **`probeRea` 对 `--version` 的输出没有上限**：PATH 上一个损坏或恶意的候选可以一直输出到超时，等于把内存交给
  陌生人。现在 64 KiB 封顶，超限立刻 `killTree` 并按「不可用」处理（回落到 bundle，行为与其它拒绝一致）。
- **`readJson` 只认 UTF-8 BOM，不认 UTF-16**：Windows PowerShell 5.1 的 `>` / `Out-File` 默认写 UTF-16 LE，读出来
  是错位乱码 → 被当成「没有记录」，于是带记录的本机会被重新供给。`bin/rea-shim.mjs` 与 `scripts/setup.mjs` 现在
  都按字节判 BOM，支持 UTF-16 LE/BE 与 UTF-8（含 BOM）。**两个读取器必须同时改** —— 只改一边，同一个文件在两个
  程序眼里又是两个意思（2.0.9 的教训）。
- **`foreignReaRegistration` 不剥行尾注释**：`serverName: rea # upstream` 会被解析成 `rea # upstream` ≠ `rea`，
  重复注册漏报 —— 而这正是人手编辑那个文件时最常见的形态。现在按 YAML 规则取值：引号内原样，引号外 ` #` 之后是
  注释（`rea#1` 仍然是值）。
- **`npm run check-updates` 在非 Windows 上是坏的**：这个 script 直接写死了
  `powershell -NoProfile -File ./check-updates.ps1`，而脚本本身读 `%APPDATA%`、优先 `rea.cmd`
  （并刻意避开 `rea.ps1` 垫片），所以在 macOS/Linux 上即使装了 `pwsh` 也只会从一个不存在的布局里
  给出一个自信的错答案。现在改为 `node scripts/check-updates.mjs`：Windows 上转发给 `powershell`
  （缺失时退 `pwsh`），其它平台说明原因、列出 `node bin/rea-shim.mjs --shim-status` 与
  `node scripts/setup.mjs --dry-run`，并以**非零码**退出 —— 不把「不适用」伪装成「全绿」。
- **供给期的 `rea doctor` 检查的不是本次供给的引擎**：那一步没传 `GHIDRA_INSTALL_DIR` / `JAVA_HOME`，
  REA 于是回落到探测本机，于是报告里出现的是系统那份 Ghidra 与 JDK（本机实测：报的是 `D:\ghidra\...` + 系统
  Java 25，而 vendor 里那份从未被检查）。现在 doctor 与冒烟共用与镜像 shim 完全相同的一组变量。
- **复用 Node 时不记录候选的真实版本**：`reusableNodeChecked` 只回 `{ok}`，于是 `bundle.json` 的
  `versions.node` 落到 `process.versions.node` —— 那是**跑 setup 的解释器**，不是被复用的那个。两者不同时
  （`REA_BUNDLE_NODE`，或 PATH 首个 `node` 是另一个安装）记录与实际就静默不一致。现在探针把 `-v` 的第一行
  带回，复用路径照实记录。
- **manifest 把 Node 钉在 24.21.0（含已知漏洞）**：24.22.1 是 2026-10-21 的安全发布（Brotli 解码器越界写 RCE、
  两处 TLS 主机名绕过、移除 eMudhra 中间 CA）。复用路径在装有新 Node 的机器上没问题，但**干净环境走下载路径
  会装回带漏洞的 24.21.0**。六个平台的 `version` / `url` / `size` / `sha256` 全部升到 24.22.1
  （校验和取自官方 `SHASUMS256.txt`；win32-x64 在本机下载、比对、解压并跑通 `node -v` / `npm -v` 后写入）。

### 修复 · 审查轮

- **`audit-manifest` 第 13 项是死代码**：`Number.isFinite(next.split(".")[2])` 测的是**字符串**，而
  `Number.isFinite` 不做隐式转换 —— 该分支恒为假，「probe 是否误接受下一个 patch/minor」这项检查从未生效。
  改为 `Number.isFinite(Number(...))`。实测把 probe 换成 `^6\.` 后，审计报出
  「accepts 6.7.1 (the next patch)」「accepts 6.8.0 (the next minor)」，修复前一条都不报。
- **零参数启动静默退出 0**：`main` 对空 argv 打印 usage 并以 0 退出，而 `launchSystemRea` 与 bundle 分支仍留着
  `argv.length > 0 ? argv : ["mcp"]` 的兜底（永远不可达）。行一旦丢掉 `mcp`（profile 合并、手改 patch），
  子进程以 0 退出、`failOnStartupError: false` 再把它压住，症状只有「没有任何 `mcp__rea__*` 工具」。
  现在按**是否有终端**区分：有人看 → usage + 0；无人看（被 spawn）→ usage + stderr 说明 + **64**。
  两处死兜底一并删除。
- **解压前先删旧安装**：`provisionComponent` 在 `extract()` 之前无条件 `rmSync(target)`，与文件头
  「Non-destructive」相悖 —— 提取器缺失（极简 Linux 无 unzip/python3/tar）或磁盘满时，一份可用的安装已经没了，
  换不来任何东西。旧目录现在只在 rename 之前清除（`extract` 失败不再触碰它）。
- **下载：有钉住校验和但清单未声明 `size` 时，完整 `.part` 无法救援**：救援分支的条件要求 `expected.size`，
  于是 resume 发 `Range: bytes=<size>-`、服务器回 416，每次重跑都同样失败，只能手工清缓存。现在这种组合用
  钉住的 sha256 判定：匹配即完成 rename，不匹配则清掉重下。（当前清单 24 条全有 size + sha，这是为将来留的路径。）
- **`setup.lock` 不是互斥锁**：它只在运行**结束**时写或删，启动时从不获取 —— shim 的 detach 供给与手工
  `node scripts/setup.mjs` 能同时写同一个 `.part` 与同一个 `<component>.staging`。现在启动即以 `O_EXCL`（`wx`）
  抢锁；遇到**活**持有者则报出 pid 与日志路径、以 **75** 退出，死 pid 或 `failed` 锁被接管（崩溃后不需要手工 `rm`）。
- **`check-updates.ps1` 把「文件不完整」误报成「版本不符」**：`application.properties` 缺
  `application.version=` 行时 `$v` 为空，于是报「当前要求 Ghidra 12.1.x，当前为」——读者会去找新版本，
  而真正该做的是重装该组件。现在分成两句。
- **shim 的 PATH 去重不比对大小写**（Windows）：`C:\Program Files\nodejs` 与 `c:\program files\nodejs`
  被当成两个目录，vendored Node 会被重复前置。现在 Windows 上先 `toLowerCase()` 再比。
- **`cordis.patch.yml` 的主目录兜底缺 `HOMEDRIVE`+`HOMEPATH`**：服务账户没有 `USERPROFILE`，表达式于是产出
  `/.dsh/...`（当前盘根），而 `setup.mjs` / shim 用的是 `os.homedir()`。现在三处同序：
  `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH` → `HOME`；两份 README 同步。
- **`rea-bundle-bootstrap.ps1` 的 engines 判断只看 major/minor**：`^24.11.1` 会接受 24.11.0。改为三段比较。
- **文件头关于 TOFU 的承诺与实现不符**：注释写「首次记录、之后强制」，但 `sha256: "unverified"` 的条目在缓存
  命中时无条件放行（没有可比的钉住值）。注释改为实情：首次测得的摘要列进 `unverifiedChecksums`，之后缓存命中
  不再复核，因为**没有**钉住值可比 —— 记录点名这个缺口，而不是假装那些字节经过验证。

### 升级

> **两条长期规则 —— 本版如此，以后每个 2.x 版本都如此。**
>
> `setup.mjs` **不会替你跑**：市场里的安装/更新只替换包，然后到此为止；装完一次、之后每次升级插件版本一次，
> 都要你自己从插件目录跑 `node scripts/setup.mjs`。跳过它不会报错 —— 首次安装是「工具消失且无提示」，升级后是
> 「继续跑旧 REA 且无提示」（`check-updates.ps1` 会报出漂移）。
>
> 1. 行执行的是 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`，那是 setup 复制的**副本**：市场升级只换包、
>    不换它，副本可能一直跑旧代码而**没有症状**。从 **2.0.8** 起副本会与 `mirror.json` 记录的启动器比对，不同就
>    一跳转发执行插件里的那份（`REA_BUNDLE_SHIM_REEXEC` 守卫）；**2.0.0–2.0.7 做不到**，从它们升级仍需跑一次
>    `node scripts/setup.mjs`。`--shim-status` 报 `mirror.stale`，`check-updates.ps1` 提示重跑。
> 2. 镜像的 `scripts/setup.mjs` 也是副本、**不会自愈**：从 bundle 根目录跑的是建 bundle 那一版；要从**插件目录**
>    跑一次刷新它。从 **2.0.9** 起它会像 shim 一样剥掉 `mirror.json` / `bundle.json` 的 UTF-8 BOM。

### 验证

- 单测 **88 条**（本轮新增 3 条：「解压失败不销毁旧安装」「审计第 13 项不是死代码」「活锁挡住第二个 setup」；
  上一轮加的是冒烟三条与「复用组件带上自己的版本」；此前 81 条为基础）。
- 真实执行证据（不是读代码）：把 probe 改成 `^6\.` 后审计报出 `accepts 6.7.1` / `accepts 6.8.0`；
  零参数在无终端下退出 **64**、`--shim-help` 仍退出 0 —— 由单测覆盖。
- `manifest` 审计：**24 条 fetch 全部 hash-pinned，0 TOFU**（Node 六平台换到 24.22.1 后重跑）。
- `verify-branch.ps1` 新增 §9：指南链路四端（`bin/rea-guide.mjs` 的 route、`index.mjs` 的挂载、`client.js` 的
  fetch、`cordis.patch.yml` 的行）逐一比对，防止改名后指南静默不出现；§10：`npm run check-updates` 必须走
  包装器，且包装器必须保留「Windows 才跑」与两条替代命令。
- 已发版：tag **v2.0.11** / GitHub Release 附 `dsh-plugin-rea.tgz` / npm **2.0.11**（Trusted Publishing，带 provenance）。

## 2.0.10 — 2026-10-19

**上游 REA 钉子从 6.5.0 升到 6.7.0。包、CLI 与 MCP 契约都没变，工具数仍是 207 —— 这是上游的功能与修复升级，不是工具扩容。**

### 修复

- **`check-updates.ps1` 的版本对账是假绿**（本版最重要的「用户能看见」的修复）：此前对所有组件都用
  「主版本前缀」比对，`"6.5.0".StartsWith("6.")` 为真 —— 插件已钉 6.7.0、bundle 里还是 6.5.0 时，这一行报
  「与 pin 一致」。**这正好打掉 2.0.10 自己的升级场景**：用户跑完检查也看不到「该重跑 setup」，机器上再没有
  第二个信号（shim 只比「系统 REA vs 已供给」，不比 pin）。apktool 同理（盘上 3.0.9 对 pin 3.0.3 也假绿）。
  现在：带点的 pin 一律**精确比对**；只有 pin 本身只有主版本号（`jdk: 21`）才按 `21.` 前缀匹配。
  `--reuse` 采纳的本机 Node 不再拿「下载版本」精确比对（那会误报），改为对 **engines** 对账：满足则单列一行、
  不计入「全绿」，不满足则报动作。规则抽到 `scripts/pin-match.ps1`，`verify-branch.ps1` 直接 dot-source 同 7 组
  用例做回归（含 6.5.0/6.7.0、3.0.9/3.0.3、`21.0.12.1+1`/`21`）。
- `assets/make-screenshots.ps1` 里硬编码的 `6.5.0`：版本号改为从 `manifest` 的 pins 读取（工具数 207 仍是人工
  核对常量，注释里写明升 pin 时要一起核）。`screenshot-1.png` 用同一脚本重绘，只有这两行文字变化；
  `screenshot-2.png` 重绘后逐字节不变，未改动。

### 变更

- `pins.reaAgents` 与 `components.reaAgents.sources.npm.version` → **6.7.0**（npm `latest`；6.6.0 只有 GitHub tag，
  npm 从未发布）。探针正则改为 `^6\.7\.0(\s|$)`，audit 的「不能把下一版当成这一版放行」检查继续覆盖。
- 契约复核（实测，不是推断）：`engines.node` 仍 `^22.19.0 || ^24.11.0 || >=26.0.0`；`bin` 仍 `scripts/rea.mjs`；
  `optionalDependencies.frida` 仍 17.23.2；tarball 仍不带 `node_modules`（6.7.0：1775 条、0 条 `node_modules`），
  所以供给路径仍是 `npm install --ignore-scripts`，不改回解包。
- 真机复核：`rea --version` = 6.7.0；MCP `initialize` 返回 `serverInfo {name: rea, version: 6.7.0}`
  （protocol `2024-11-05`）；`tools/list` = **207**，与 `rea doctor --json` 的 `catalog.counts.mcp_tools` 一致。
- 上游 6.6.0 + 6.7.0 的变化（与插件代码无关，记录以便对照）：Kuna 作为调用方自备的静态分析 provider、
  JavaScript facts 视图、APK 多 locale 表、Windows ARM PE（ARMNT/Thumb-2、ARM64）与显式 raw m68k、JADX 操作超时，
  以及 6.7.0 的客户端配置「重复成员」语义修复。**`rea doctor` 因此多一项 `kuna-installation`**，与 Hopper / IDA
  同属「本机自备」类检查，供给不碰，`healthy=false` 依旧不算失败。
- 文档：两份 README 的 REA 版本与工具数、`docs/bundle-design.md` 的实测环境同步到 6.7.0；README 的钉版本示例
  跟到 `#v2.0.10`。

### 升级

> **两条长期规则 —— 本版如此，以后每个 2.x 版本都如此。**
>
> `setup.mjs` **不会替你跑**：市场里的安装/更新只替换包，然后到此为止；装完一次、之后每次升级插件版本一次，
> 都要你自己从插件目录跑 `node scripts/setup.mjs`。跳过它不会报错 —— 首次安装是「工具消失且无提示」，升级后是
> 「继续跑旧 REA 且无提示」（`check-updates.ps1` 会报出漂移）。
>
> 1. 行执行的是 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`，那是 setup 复制的**副本**：市场升级只换包、
>    不换它，副本可能一直跑旧代码而**没有症状**。从 **2.0.8** 起副本会与 `mirror.json` 记录的启动器比对，不同就
>    一跳转发执行插件里的那份（`REA_BUNDLE_SHIM_REEXEC` 守卫）；**2.0.0–2.0.7 做不到**，从它们升级仍需跑一次
>    `node scripts/setup.mjs`。`--shim-status` 报 `mirror.stale`，`check-updates.ps1` 提示重跑。
> 2. 镜像的 `scripts/setup.mjs` 也是副本、**不会自愈**：从 bundle 根目录跑的是建 bundle 那一版；要从**插件目录**
>    跑一次刷新它。从 **2.0.9** 起它会像 shim 一样剥掉 `mirror.json` / `bundle.json` 的 UTF-8 BOM。

- `setup.mjs` **只对齐 bundle，不更新插件包**：它读的是「当前已安装插件」的 manifest，所以装着 2.0.9 时跑 setup
  仍旧供给 6.5.0，哪怕 2.0.10 已发布。插件包只能从市场（或 `npm i -g dsh-plugin-rea@<版本>` / `file:` 重装）换。
- 已供给的机器**不会自动换到 6.7.0**：auto-provision 只在「未供给」时触发。重跑一次 `node scripts/setup.mjs`
  （或只补 REA：`node scripts/setup.mjs --only reaAgents`），探针会拒收盘上的 6.5.0 并重装。
  修好上面那条对账后，`npm run check-updates` 会直接报
  `reaAgents 盘上为 6.5.0，manifest 已钉 6.7.0 —— 重跑 setup 对齐`。

### 验证

- 单测 **71 条**（68 过 + 3 平台跳过）；`verify-branch.ps1` **53 项**全绿（新增 §5b 的 2 项结构检查 + 7 组
  pin 用例）；`audit-manifest` clean；`host-compat` 10 covered / 5 outside。
- 对账修复的实证（不是读代码推断）：临时 bundle 记 6.5.0、manifest 钉 6.7.0 时实跑 `check-updates.ps1`，输出
  `reaAgents 盘上为 6.5.0，manifest 已钉 6.7.0 —— 重跑 setup 对齐`，且**不再**打印「所有组件与 pin 一致」；
  `--reuse` 采纳的 Node 24.11.1 单列为「满足 engines」（不并入全绿），20.0.0 则报动作。
- `npm pack` **22 文件**（新增 `scripts/pin-match.ps1`；`screenshot-1.png` 重绘后 68,067 B）；发行资产名仍是
  版本无关的 `dsh-plugin-rea.tgz`。
- 发布：tag `v2.0.10` → GitHub Release（资产 `dsh-plugin-rea.tgz`）→ npm `2.0.10`；插件市场按 npm 包名与
  `releases/latest/download` 两条路径解析。

## 2.0.9 — 2026-10-18

**2.0.8 的两处发布前问题（假回退、乱码）与若干文档缺口；不改正常路径，只让失败路径说真话。**

### 修复

- **`reexecFromCheckout` 的「回退」是假话**：spawn 失败时只打印「继续用镜像副本」，函数却返回了，`main()` 已经
  return —— 没有 `exit` 事件、事件循环排空、进程以 **exit 0 静默退出**，行看起来启动成功却没有任何工具。现在这个
  Promise **只在没接管时才 resolve**：子进程活着时本进程等待、由子进程的退出码决定；失败则 `main()` 继续用本地副本
  启动，并如实说明在回退。
- **回退覆盖了升级竞态的主形态**：`spawn` 的目标是 `process.execPath`，spawn 级失败几乎只剩资源耗尽；真正常见的是
  「哈希比对通过 → node 启动 → 文件已被换掉」→ node 以 `MODULE_NOT_FOUND` 退 1。现在**退出码非 0 且源文件已不存在**
  时同样回退到本地副本（窗口毫秒级，代价是一次 `stat`），不再把竞态变成一行死掉的 MCP。
- **乱码 `鈥?` 混进用户可见输出**：2.0.7 在 GBK 编辑器里碰过 `bin/rea-shim.mjs`，16 处破折号被写成 `鈥?`，其中两条是
  stderr 消息（首次自动供给、上次供给失败）—— 每个用户都会看到。全部还原为 `— `（含被吃掉的空格）。
- **开发时可能测到「已安装插件」而不是自己的改动**：checkout 副本会顺着 bundle 的 `mirror.json` 转发到插件目录。
  现在 checkout（带 `cordis.patch.yml`）永不转发，只有镜像副本会；注释也改成与行为一致。
- **带 BOM 的 `mirror.json` / `bundle.json` 被当成「没有记录」**：`JSON.parse` 拒绝前导 BOM，而每个调用方都把解析失败
  读成「无记录」。Windows 编辑器保存的 JSON 就会带 BOM，表现是镜像自愈静默不生效、bundle 被当成未供给。`bin/rea-shim.mjs`
  与 `scripts/setup.mjs` 现在都经各自的 `readJson()` 去掉 `U+FEFF` 再解析。**两个文件读的是同一份记录，所以缺一不可**：
  此前只有 shim 剥了 BOM，带 BOM 的 `mirror.json` 在 setup 眼里仍是「没有 checkout」，镜像 layout 下的 setup 于是把上一版
  manifest 又镜了一遍并从它供给；`bundle.json` 同理被读成未供给。`verify-branch.ps1` 与 CI 都加了守卫：这两个文件里
  出现裸的 `JSON.parse(readFileSync(...))` 即失败。

### 文档 / CI

- 两份 README 的钉版本示例改为**当前版本** `#v2.0.9`（2.0.8 那一轮已从 `#v2.0.0` 提到 `#v2.0.8`，版本号一动就得跟上，
  否则读者拿到的 ref 不存在）；README 的「机器上已有 REA」一节补上 Windows 限制：**强制结束 shim 不会带走被委派的 REA**。
- `docs/bundle-design.md`（随包发布）补上 2.0.7 的 launch mode 与 2.0.8 的镜像自愈，含 `mirror.json` 的
  `shimSha256` / `pluginVersion` / `dshHome` 三个字段与控制流图。
- CI 新增两条：README 必须逐字引用 `engines.dsh`；README 的钉版本示例必须等于 `package.json` 的 version（`verify-branch.ps1`
  同步加了第二条，避免同一个漂移第三次发生）。
- `systemReaCandidates` 的去重键改用传入的 `platform` 参数（测试缝一致，生产无变化）。

### 验证

- 单测 **71 条**（68 过 + 3 平台跳过；新增「checkout 副本不转发」「文件中途消失 → 回退」「带 BOM 的 `mirror.json`」
  「带 BOM 的 `bundle.json`」四条）；镜像转发测试改为真的运行镜像副本。
- `verify-branch.ps1` 44 项全绿；`audit-manifest` clean；`host-compat` 10 covered / 5 outside。

## 2.0.8 — 2026-10-18

**2.0.7 的启动检测在两种边界上会失控：一个包着本 shim 的 `rea` 会让探针递归成进程链；超时探针会漏掉一个孙进程。两条都已修，并补了复现测试。**

### 修复

- **重复注册检测在自定义 `DSH_HOME` 下失效**：harness 会从 MCP 子进程里抹掉所有 `DSH_*`，镜像副本因此读
  `~/.dsh` —— 那是错的文件，上游写进真实 home 的第二条 `serverName: rea` 永远报不出来。`setup.mjs` 现在把运行时
  的 home 记进 `mirror.json` 的 `dshHome`，shim 优先读环境、其次读这条记录。`check-updates.ps1` 的 profile 段也
  改用同一条 home 规则（此前硬编码 `$env:USERPROFILE`，自定义 home 时报「找不到 profile」）。
- **镜像启动器不会自己更新**：行执行的是 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs` 这份**副本**，而市场升级
  只换包、不跑 setup —— 副本会一直跑它被复制时的代码，于是新版本里的修复对老用户静默失效（旧副本照常工作，最难发现）。
  现在镜像启动时会与 `mirror.json` 记录的插件目录比对哈希，不同就转发执行插件里的那一份（一跳，带
  `REA_BUNDLE_SHIM_REEXEC` 守卫，且只从镜像指向插件，不会反向）。`--shim-status` 新增 `mirror.stale`，
  `check-updates.ps1` 也会报「镜像落后，重跑 setup」；`mirror.json` 增加 `shimSha256` 与 `pluginVersion` 便于追溯。
  **2.0.8 之前的版本自身无法完成这一步**（副本里没有这段代码），从那些版本升级仍需手动跑一次 setup。
- **探针递归**：`probeRea` 派生候选时没带 `REA_BUNDLE_DELEGATED=1`，而防自委派的守卫只在**委派**前生效。若 PATH 上是「调用本 shim 的 wrapper」，
  探针 → wrapper → 新 shim → 再探针……实测并发 node 峰值 83+、杀掉后仍自我再生。现在探针环境同时带 `REA_BUNDLE_DELEGATED=1` 与
  `REA_BUNDLE_AUTO_PROVISION=0`：嵌套运行直接走 bundle 并返回，实测 0.2 秒、零额外进程。
- **超时探针泄漏孙进程**：`spawnSync` 的超时只杀它自己启动的 cmd.exe，而 `taskkill /T` 在 `spawnSync` 回收之后调用已找不到父进程 ——
  每次超时留一个 REA/ping 在跑。探针改为异步 `spawn` + 自己的计时器：超时发生在父进程仍存活时，`taskkill /T /F` 能真正清掉整棵树。
  实测 8.3 秒放弃、`rejected=["timeout"]`、无残留进程。
- **Windows 信号处理器是死代码**：`child.kill("SIGTERM")` 在 Windows 上是 TerminateProcess，不可捕获；控制台的 Ctrl+C 又直达子进程。
  该分支已删除，并如实写明限制：**在 Windows 上强制结束 shim 不会带走被委派的 REA**（Node 没有 job object 可用）。
- **`comspec()` 不校验**：`ComSpec` 指向不存在的文件时，正常的 `.cmd` REA 被判 `spawn-failed`（`auto` 静默退回 bundle，`system` 直接 78）。
  现在校验为常规文件，否则回落到 `%SystemRoot%\System32\cmd.exe`；实测 `ComSpec` 指向不存在路径仍能识别 6.9.0。
- **文案**：显式路径是目录时报「does not exist」，改为「is not a file」。

### 验证

- 单测 **67 条**（2.0.7 是 60 条，本轮 +7：wrapper 递归必须被判为 `exit 78` 且 20 秒内收敛；`ComSpec` 失效仍识别 `.cmd` REA；
  镜像自愈的转发/守卫/`stale` 上报/同内容不转发；`DSH_HOME` 被抹时从 `mirror.json` 找到真实 home 并报出重复注册）：
  Windows 64 过 + 3 平台跳过。
- `verify-branch.ps1` 全绿（39 项），含「两份 README 必须写出 package.json 里的 `engines.dsh` 原文」；`audit-manifest` clean；
  `host-compat` 10 covered / 5 correctly outside。
- 手工复现三例：wrapper 递归 0.2 秒收敛、0 残留进程；挂起候选 8.3 秒放弃且无 `PING` 残留；`ComSpec` 指向空路径仍识别系统 REA。


## 2.0.7 — 2026-10-18

**机器上已有可用的 REA 时，2.x 直接按 1.x 的方式跑它（环境检测 + 委派），不再供给；同时把 2.0.6 的宿主声明收紧到真的能证明的范围。**

### 新增：环境检测 → 跑 1.x 的那条路

- **启动时判断该跑谁**：`rea` 在 PATH 上且能应答 `--version`，就用它（`rea mcp`，用户自己的 Node 与 PATH）；否则走供给的
  bundle。这正是 1.x 的契约，现在从 2.x 的行里也能到。
- **版本优先级**：系统 REA 比供给的旧就不抢（6.4.0 是 170 个工具、6.5.0 是 207 个，静默回退工具数是真回归）。相等或更新
  才切；预发布/无法比较时保守留 bundle。
- **覆盖**：`REA_BUNDLE_LAUNCH=auto|system|bundle`（默认 auto）、`REA_BUNDLE_SYSTEM_REA=<path>` 点名不在 PATH 上的二进制。
  `system` 在找不到时**报错退出**，而不是替用户去下 800 MB。
- **`--shim-status` 报告决定**：`launch.{preference,mode,reason,unusable,systemRea,rejected}`；`--shim-print-env` 在 system
  模式下打印 `{launch,rea,version}`。
- **防自委派**：被委派的子进程带 `REA_BUNDLE_DELEGATED=1`，一个调用本 shim 的 wrapper 不会让委派无限递归。

### 修复（两轮独立复核，逐条可复现）

- **委派参数被加引号**：`cmd /c` 下 `.cmd` 的 `%*` 收到的是 `"mcp"` 而不是 `mcp` —— 探针能过、委派是坏的。现在只给路径加
  引号，参数原样传（行固定传 `mcp`；需要 shell 引号的参数本就不在这条路上）。
- **探测预算 3s 与真机同量级**：实测经 `.cmd` 的 `rea --version` 为 2.4s（并发 2.8–3.0s），3s 预算等于掷硬币。改为 8s；超时
  用 `taskkill /T /F` 杀进程树，不再只杀 cmd.exe 而留下一个占着管道的 REA。
- **Windows 信号转发是错的**：`child.kill("SIGINT")` 只 TerminateProcess(cmd.exe)，里面的 REA 继续跑；现在 Windows 走
  `taskkill /T`，POSIX 不重复转发（stdio inherit 已由进程组投递）。
- **`--shim-status` 退出码**：`system` 被点名但不可用时曾返回 0（bundle 恰好已供给），实际启动却 78；现在按「这一行能不能
  起来」返回，并新增 `launch.unusable` 字段。
- **候选判定**：`existsSync` 换成 `statSync().isFile()`（名为 `rea.cmd` 的目录曾被当成坏安装）；PATH 项去引号、跳过相对项；
  显式路径被拒时理由如实报告。
- **`fail()` 的补救命令补上 `--root`**：shim 用 `REA_BUNDLE_ROOT` 解析出的根与 setup 的默认根可以不同，照着旧提示执行会供给
  到另一个根。
- **`engine.dsh` 上限收紧**：`<0.3.0` 在 includePrerelease 语义下会放行 `0.3.0-alpha.1`/`0.3.0-rc.1`；改为 `<0.3.0-0`，并用
  市场自己的 `satisfiesRange` 逐版本核对。
- **`host-compat.mjs` 的测试加固**：发布清单逐项钉住；新增「低地板必须被判为泄漏」的反向对照（原实现把 `leaked` 改成 `[]`
  仍然全绿）；`+build` 元数据按 semver 接受、`v` 前缀与零填充预发布按 semver 拒绝。
- **环境独立性**：`setup.mjs` 自检的 shim 步骤钉 `bundle` 模式（否则机器上更新的 REA 会冒充本次供给的产物）；CI 两个 job
  各加 job 级 `REA_BUNDLE_LAUNCH=bundle`；测试里的每个 shim 调用点都钉住模式，测试不再随机器变。
- **`rea-bundle-bootstrap.ps1` 认 `REA_BUNDLE_ROOT`**：四份代码里只有它忽略这个覆盖，导致 bootstrap 把 800 MB 装到
  `<DSH_HOME>/plugins/rea-bundle`，而 shim/setup/check-updates 去 `REA_BUNDLE_ROOT` 找，看到空 bundle 再起一次。
- 中文 README 的「更新到 2.0.4」措辞改正为「更新到 2.0.5」。

### 验证

- 单测 **60 条**（新增 12 条：6 条启动模式 + 1 条清单钉住 + 1 条泄漏反向对照 + 1 条 semver 容差 + 3 条 PATH/空格路径/委派退出码），
  Windows 57 过 + 3 平台跳过。
- `verify-branch.ps1` 全绿；`audit-manifest.mjs` clean；`host-compat.mjs` 10 covered / 5 correctly outside。
- 真机：全局 `rea` 6.4.0 与供给的 6.5.0 并存时 `auto` 留 bundle（不降工具数），`REA_BUNDLE_LAUNCH=system` 才切过去。


## 2.0.6 — 2026-10-18

**声明宿主版本：`engines.dsh` 覆盖 `0.1.7-rc.2` … `0.2.1-rc.2` 全部发布版本，市场卡片因此显示「兼容」而不是「未声明」。**

### 兼容声明

- **`engines.dsh: ">=0.1.7-rc.2 <0.3.0"`**：市场侧的 `deriveHostCompatibility` 只认两类声明 —— `engines.dsh`
  与指向 `@deepseek-ai/dsh*` 的 `peerDependencies`；两者都没有就是 `unknown`（卡片「兼容性未知」）。
  这里只声明前者，刻意不声明 peer：`@deepseek-ai/dsh-mcp-client` 在 npm 上只有 `0.0.1-rc.1`，
  而宿主随包内置的是 0.2.x，声明 peer 会让 pnpm 解析出一个与宿主不一致的版本，反而制造假冲突。
- **范围来自核对，不是估计**：`scripts/host-compat.mjs` 内置 dsh 发布列表（0.1.7-rc.2 至 0.2.1-rc.2 共 10 个），
  逐个验证是否被声明覆盖，并反向确认 `0.3.0` 与 `0.1.7-rc.1`、`0.1.7-alpha.2` 落在范围之外。
- **跨版本比对过的东西**：`packages/mcp/mcp-client` 在 `dsh-v0.1.7-rc.2` 与 `dsh-v0.2.1-rc.2` 两个 tag 上，
  配置面与发布的行一致（`serverName`/`transport`/`command`/`args`/`env`/`failOnStartupError` 均存在且同名），
  且两个 tag 都有 `dsh.bundle.patch`。范围声明的是「核对过的宿主」，不是「应该能用」。

### 上游（只更新仓库，暂不带入）

- 上游已发布 **rea-agents 6.6.0**（GitHub release `rea-agents-6.6.0`，2026-10-18）；npm `latest` 仍是 **6.5.0**，
  所以本包的钉（`manifest/bundle.manifest.json` 的 `pins.reaAgents` 与 `components.reaAgents.sources.npm.version`）
  **保持 6.5.0 不动**。已核 6.6.0 的 `engines.node`（`^22.19.0 || ^24.11.0 || >=26.0.0`）与 `bin`
  （`scripts/rea.mjs`）均未变化，`optionalDependencies.frida` 为 17.23.2。
- 计划：**2026-10-19** 随下一版把钉升到 6.6.0 并复跑真机；届时工具数、探针正则与文档一并更新。

### 修复 / 工程

- 新增 `scripts/host-compat.mjs`（纯函数 + CLI）：semver 预发布排序、`>=floor <ceiling` 判定、发布列表覆盖检查。
- `bundle:host-compat` npm script；`verify-branch.ps1` 新增 `engines.dsh` 存在性与覆盖率两项；
  `validate.yml` 新增「Declared DSH range covers every released host」步骤，清单检查也要求 `engines.dsh`。

### 验证

- 单测 **46 条**（新增 4 条：声明可解析、10 个发布版本全覆盖且 3 个未核对版本被排除、反向对照能抓出
  `>=0.2.0` 这种看似合理却漏掉整个 0.2.0-rc 线的写法、预发布排序符合 semver 而非字符串序）：Windows 43 过 + 3 平台跳过。
- `node scripts/host-compat.mjs`：10 个发布版本 covered、3 个 correctly outside。
- `verify-branch.ps1` 全绿；`audit-manifest.mjs` clean（两份 README 结构仍平行）。

## 2.0.5 — 2026-10-18

**市场更新失败已定位并修复：清单里没有 `main`，市场因此在每次更新时判「新构建没有可加载入口」并回滚。**

### 修复

- **应用内市场更新到 2.0.4 失败**：`dshmarket` 的更新路径用 `hasLoadableEntry` 判断新构建能不能加载
  （实现是 `entryArtifactExists`：读 `main`/`exports`，两者都没有就回落 `index.js`）。本包是纯 bundle
  （只有 `dsh.bundle.patch`），从未声明 `main`；而它挂载的 `@deepseek-ai/dsh-mcp-client` 属于 harness 自身
  构建、不在 `node_modules` 里，于是该检查要看的 profile / 包内 / workspace 三个位置全空。结果：2.0.1 → 2.0.4
  的更新连续三次报「更新后缺少入口文件……且未能验证恢复原版本文件」，而回滚其实成功了 —— 旧版同样没有入口，
  所以回滚后的复检依然为 false。现已声明 `main: ./index.mjs`，并让该文件进入 `files[]`。
- **`index.mjs` 是真空插件，不是占位**：导出 `name` 与空 `apply()`，不注册行、不起进程、不写状态；真正起作用的
  行仍由 `cordis.patch.yml` 插入。若 harness 某天真把它当插件加载，行为仍是「什么都不做」，因此不会造出第二条
  `serverName: rea`。

### 文档

- 两份 README 新增「在市场里更新 / Updating from the market」小节：说明该报错来自市场侧的入口判定、与 tarball
  完整性无关、profile 未受损，以及 2.0.5 起的做法。

### 验证

- 用 `dshmarket` 自身的 `hasLoadableEntry` 实测：把本包按 profile 布局模拟安装，修复前 `false`、修复后 `true`；
  对仓库目录 `entryArtifactExists` 修复后为 `true`。
- 单测 42 条（新增 2 条：清单声明的入口必须存在且被 `files[]` 收录；入口可 `import`、导出的 `name` 与包名一致、
  `apply()` 返回 `undefined`）：Windows 39 过 + 3 平台跳过。
- `verify-branch.ps1` 新增 `main` 存在性与 `files[]` 收录检查；`validate.yml` 的清单检查与 npm 载荷检查加了同一条守卫。
- `npm pack --dry-run`：20 个文件，含 `index.mjs`。

## 2.0.4 — 2026-10-17

**两处已核实的缺陷：只读 bundle 目录下 shim 启动即崩；与上游 `rea setup --client dsh` 的同名注册冲突现在会被明确提示。**

### 修复

- **只读 bundle 根目录 + 陈旧 lock → shim 未捕获 EACCES 崩溃**：2.0.3 把删锁移出了 `if (fresh)`，却没包
  try/catch。目录只读（`chmod 555`、系统级安装目录）且锁已陈旧时，`rmSync(lock)` 抛 `EACCES`，shim 以
  未捕获异常退出（exit 1 + 堆栈）—— 比原来的静默更吵，但同样起不来。沙箱已复现（WSL `chmod 555`）。
  现在删锁失败返回 `unwritable`，走既有的「无法写入，请手动跑 setup」路径（exit 78，行不崩）。
- **与上游 `rea setup --client dsh` 的同名注册冲突**：该命令往 `<DSH_HOME>/cordis.patch.yml` 写入
  `id: rea-mcp`、`serverName: rea`，而本包是 `id: mcp-rea`、同一个 `serverName`；DSH 对同名条目只保留
  一个（后加载者报 duplicate server name）。已按上游 6.5.0 实测生成该文件确认。shim 现在启动时检测同
  文件的 `serverName: rea`（id 不是 `mcp-rea`）并向 stderr 提示「二选一」，`--shim-status` 也会在
  `duplicateRegistration` 下报告。

### 文档

- 两份 README 新增「只保留一条 REA 注册」小节：与 `rea setup --client dsh` 二选一，并说明两条路线的
  取舍（零依赖供给 vs 上游官方纯配置注册）。
- v1 分支 README 顶部加横幅：指向 2.x（`main`，默认推荐）与上游官方注册。

### 验证

- 单测 40 条：Windows 37 过 + 3 平台跳过；WSL 39 过 + 1 跳过（本轮新增 3 条，其中只读目录一条仅 POSIX）。
- 反向验证：回退删锁的 try/catch → 只读目录测试在 WSL 必红（EACCES/exit 1）；回退冲突检测 → 重复注册
  测试必红。
- `verify-branch.ps1` 全绿。

## 2.0.3 — 2026-10-16

**修复 11 处已核实的缺陷（每条都先确认存在、并配了"回退即变红"的回归测试）；上游 REA 钉子从 6.4.0 升到 6.5.0。**

### 上游

- `pins.reaAgents` 与 `components.reaAgents.sources.npm.version` → **6.5.0**：engines 与 bin 入口未变
  （`^22.19.0 || ^24.11.0 || >=26.0.0`、`scripts/rea.mjs`），工具数 170 → **207**（运行时 `rea doctor --json` 实测；上游源码静态清点为 206，多出的 1 个注册在 contracts 之外。新增：Frida 9、
  GDB 4、Rizin/Cutter 6、pcap/packet 4、flutter 2、sqlite/rust/go/wasm/electron/harmony/hopper 各 1 等）。
  新增的 `optionalDependencies.frida` 在 `--ignore-scripts` 下不会执行安装脚本。REA 探针正则收紧为
  `^6\.5\.0(\s|$)`，审计新增"下一个 patch/minor 不得通过"的断言。
- Ghidra 12.1.4 / apktool 3.0.3 / jadx-headless-mcp 0.7.1 **经核实仍是当前最新**；Node 24.22.0 虽已发布，
  但晚于本插件的实测矩阵，故保持 24.21.0（engines 完全满足）。

### 修复

- **`--only` 抹掉其它组件的记录**：bundle.json 由本轮结果整份重写，未点名组件的 `paths.jdk/ghidra` 变
  `null`，shim 不再导出 `JAVA_HOME`/`GHIDRA_INSTALL_DIR`——原生分析静默失效，下次完整跑还得重新解压
  750 MB。未点名的组件现在按旧记录结转（且只在记录的路径仍然存在时），缺依赖时优先用旧记录/机器/运行
  setup 的解释器来满足，而不是整段跳过检查。
- **完整的 `.part` 不被当作已完成**：只打一行日志，然后发 `Range: bytes=<全长>-`（416；四次重试后把
  已经下好的文件报成失败）。现在校验通过即改名收下。
- **Windows 下载主路线没有续传**：PowerShell 路线每轮先删 `.part`；失败后 Node 兜底仍用进本轮前的
  `have`，以 append 把 200 全量接在半成品后面（长度必然超标，只能重下）。两条路线现在都按盘上实际
  长度发 Range 续传。
- **POSIX 的 apktool wrapper 没有执行位**（copyFileSync 落 0644，而 REA 不加 shell 直接 spawn → EACCES）：
  manifest 里标了 `executable` 的条目落盘时 chmod 0755。
- **apktool wrapper 钉在 `master` 分支 + 硬校验 sha256**：上游对 wrapper 的任何一次提交都会让全网新装
  hash mismatch。改钉不可变的 `v3.0.3` tag，哈希按该 tag 重新实测。
- **`--reuse` 不校验版本**：JDK 只看 `javac` 存在、Ghidra 只看 `analyzeHeadless` 存在（JDK 8/11、Ghidra 11
  照收）。现在候选必须通过该组件自己的 probe；同时修好"文件型 probe 从不检查 `expect`"（Ghidra 的
  `application.version=` 断言此前是死配置）。
- **`bundle.json` 损坏即永久失败**：setup 读不了它、也没人启动 setup，用户只能手删文件。现在 setup 容忍
  它（并按需重写），shim 对 `malformed` 与 `missing` 一样触发供给。
- **失败后 shim 谎报 6 小时**：lock 现在记录状态与 pid；失败态如实报告"上一次失败了"，持有者已消失的
  lock 不再阻塞重试。
- **成功的 `--json` 轮次从不删 lock**：删除语句原先在非 `--json` 分支里，--json 成功也留下 lock。
- **shim 兜底 REA 路径少了 `node_modules`**：旧 bundle.json 缺 `paths.reaEntry` 时会把可用安装判成"CLI 丢了"。
- **`scripts/rea-bundle-bootstrap.ps1`**：`node -v` 输出非数字时 `[int]` 强转在 `$ErrorActionPreference='Stop'`
  下会炸掉整个 bootstrap（而它存在的意义就是这条路径）；`&` 调用失败时 `$LASTEXITCODE` 可能为 `$null` →
  `exit $null` = 假成功；engines 改从 manifest 的 `pins.nodeEngines` 读（不再抄第二份）；`-DryRun` 不再创建
  目录（它承诺"什么都没改"）。
- **`check-updates.ps1` 的 1.x 残留**：REA 节默认找 npm 全局包（2.x 是 vendored）、Ghidra 节读用户级
  `GHIDRA_INSTALL_DIR`、`rea doctor` 拿不到 vendored CLI（整段自检被静默跳过）、一体包对账对"未记录版本"
  的组件静默 `continue` 却打印"全部一致"。现在一律先读 `bundle.json`，并如实报告无法对账的项。

### 审计与 CI

- `audit-manifest.mjs` 新增 4 项：manifest 组件 ⇄ `INSTALL_ORDER` 对账、`pins.nodeEngines` ⇄ `package.json
  engines`、REA pin 探针不得放行下一个 patch/minor、POSIX wrapper 必须标 `executable`。
- `validate.yml` 新增 `windows-latest` job：PowerShell 下载路线、zip 解压与 bootstrap 此前是零 CI 覆盖的
  Windows 专属代码。
- 单测 33 条（32 过 + 1 条按平台跳过）；`--reuse adopts a compatible node` 在 engines 之外的宿主上改为显式
  skip（此前在 Node 20 上必红，而 CI 钉 22 看不出来）。

### 第二轮修复（同一份**更新后**的清单，2026-10-16 晚）

- 🔴 **过期 lock 永久卡死自动供给（2.0.0–2.0.2 三版全带）**：`maybeAutoProvision()` 只在 lock 新鲜时
  处理它，过期的 lock 既不清除也不报告 → 落到独占创建 → `EEXIST` → 返回 `in-flight`，而 `main()` 对
  `in-flight` **一个字都不打印**。于是「下载被 kill / 断电」这一常态，在 6 小时后再启动就变成**永久不再
  自动供给且完全静默**。已按清单复现（7 小时死 lock：不启动、lock 原样、无任何提示；5 分钟 lock 对照组
  正常删锁重启），修法：**不新鲜或持有者已死就一律清锁**（这正是注释里"只在新鲜时尊重它"的本意），
  并给 `in-flight` / `spawn-failed` / `unwritable` 补上如实提示。
- 🔴 **`examples/` 两个文件是 1.x 内容，却随 2.x 进了 npm 包**：`cordis.patch.posix.yml` 教人把整行换成
  `command: rea`、`cordis.patch.with-env.yml` 给的是 `cmd.exe /c rea` 的 1.x 行——对 2.x 全错（2.x 的行是
  跨平台的 `process.execPath` + bundle shim，照抄会整行绕过 bundle）。两份都已是孤儿（README 不再引用），
  故从 `main` **删除**，并同步 `package.json files[]` 与 `validate.yml` 的载荷/YAML/机器路径三项检查
  （v1 分支保留它们，在 1.x 语境里是对的）。npm 载荷由此 21 → 19 个文件。
- 🟡 **`--offline` 管不住 `reaAgents`**：`provisionReaAgents()` 里 0 处 offline 判断，`npm install` 永远
  联网——与「`--offline` is a promise, not a hint」直接矛盾。现在 `--offline` 且内置副本不可用时**直接
  FAIL** 并说明原因（而可用的内置副本仍照常跳过）。
- 🟡 **npm 那一步没有代理/镜像兜底**：压缩包有 direct→proxy→PowerShell 三路，npm 只读环境变量。失败时
  现在会打印这句提示，两份 README 的能力/注意里也写明 `HTTPS_PROXY` / `NPM_CONFIG_REGISTRY`。
- 🟡 **POSIX 缺 `unzip`/`xz` 必现失败**：Ghidra 全平台只有 zip，而 POSIX 解压原先只有 `unzip` 一条路。
  现在 zip 依次尝试 `unzip` → `python3 -m zipfile` → **已供给 JDK 自带的 `jar`**（JDK 在 Ghidra 之前供给，
  等于保底），tar 依次 `tar` → `python3`；三者皆无时打印明确的「no zip extractor available」而不是干巴巴的
  「extraction failed」。
- 🟡 **manifest 的 arm64 注释是错的**：Google 的 linux/darwin platform-tools 都是 x86_64 二进制，
  「The same archive serves x86-64 and arm64」不成立。三个条目改成如实描述（macOS 需 Rosetta 2、
  linux-arm64 上 probe 预期失败并被报为可选组件不可用）。
- 🟡 **`docs/bundle-design.md` 与实现漂移**：§3 的「row points at `<plugin>/bin/rea-shim.mjs`」改成
  「按 `DSH_HOME` 算出 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`（镜像副本）」；§7 的
  `vendor/rea-agents` 改成 `vendor/node_modules/rea-agents`。
- 🟢 **`release.yml` 的 `workflow_dispatch` 可绕过 Release 直接发 npm**：publish job 现在先断言
  `v<package.json version>` 的 tag 在 origin 上存在、且该 Release 挂着版本无关的 `dsh-plugin-rea.tgz`
  资产，否则拒绝发布（否则 npm 与市场兜底链接会岔开）。
- 🟢 **数值环境变量会变成 NaN**：`REA_BUNDLE_FETCH_RETRIES=abc` → `Math.max(1, NaN)` → 报
  「gave up after NaN attempt(s)」；NaN 的 socket 超时等价于 0（立即超时）。现在非正有限值一律回落到默认，
  且启动日志新增一行 `limits connect=… idle=… retries=…`，让覆盖生效可见。
- 🟢 注释与整洁：`downloadViaPowerShell` 的文档说自己是 fallback，实际在 Windows 上是主路线（已改口径）；
  去掉 setup.mjs 里 3 处对已静态导入成员的重复 `await import("node:fs")`（`readdirSync` 补进静态导入）。

## 2.0.2 — 2026-10-15

**仅文档，无行为变更。**

- 两份 README 的**末尾**（许可证之前）新增一节，说明**什么时候该用 1.x 线**以及它的安装方式
  （`dsh-plugin-rea@1.0.6` 或 `github:czcdr/dsh-plugin-rea#v1.0.6`）—— 此前 1.x 只出现在开头的版本说明与升级章节里。
## 2.0.1 — 2026-10-15

**仅文档与版式，无行为变更。**

- 两份 README 的**语言行正下方**现在先说明「这是哪个版本、1.x 与 2.x 各做什么」——此前版本说明排在
  首屏那张大截图之后，npm 页面首屏看不到，容易被误判成「README 没改」；对比表与升级章节位置不变。
- `docs/bundle-design.md` 的措辞跟上「`main` 已经是一体包线」这一事实（原先写的是「本分支新增、
  `main` 不变」）。
- 为什么纯文档也发一个补丁版：npm 的包页渲染的是**发布进 tarball 的 README**，不重新发布就更新不了首屏。
## 2.0.0 — 2026-10-15

**一体包线的首个正式版**（此前的 `2.0.0-bundle.1` / `2.0.0-bundle.2` 是它的两个预发布）。
`main` 现在就是这一条；1.x 的纯配置适配器保留在
[`v1` 分支](https://github.com/czcdr/dsh-plugin-rea/tree/v1)，npm 上仍可装 `dsh-plugin-rea@1.0.6`。

### 🔴 从 1.x 升级：先跑一次供给，再重启

1.x 的行指向 PATH 上的 `rea mcp`；2.x 的行指向 `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`，
而**那个文件只有 `setup.mjs` 会创建**。所以从 1.x 升上来后直接重启会：

- 让该行以 `MODULE_NOT_FOUND` 退出（harness 本身不受影响 —— `failOnStartupError: false` 是刻意的），
  于是 `mcp__rea__*` 工具消失，而且**不会得到任何修复提示**：会打提示的 shim 本身还不存在；
- 正确做法是在插件目录跑一次 `node scripts/setup.mjs`（或 `scripts\rea-bundle-bootstrap.ps1 -Reuse`），
  再重启 dsh，工具就回来了。此后每一次「状态缺失」都由 shim 自己发现并在后台补供给。

（如果你在 profile 的 `cordis.patch.yml` 里按 id 覆盖过 `mcp-rea`（例如钉 `cmd.exe /c rea mcp`），
那条覆盖会继续生效，升级不影响你。）

### 三个致命缺陷（按旧版说明走的用户每一步都会撞上）

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
- **`--dry-run` 在裸机上误报失败并退出 1。** 计划项返回 `{ planned: true }`（没有 `path`），而只有真实
  `path` 才被计入 `context.resolved`，于是每个依赖前序组件的计划项都被判成"依赖不可用"：在**裸机** —— 恰恰
  是 README 建议先跑 `--dry-run` 的那台机器 —— 整条链报 4 条 FAIL 且退出码为 1。现在计划项同样满足下游的
  `requires`。（本机 `--reuse` 会 adopt 成功，所以这个缺陷只在干净机器上可见。）
- **`release.yml` 的 npm 自更新**由 `npm@latest` 钉到 `npm@^11`：发布当天不该让流水线获得新行为。
- **`check-updates.ps1` 的 engines 判定**：不认识的 pattern（`22.x`、`>=22` 之类）此前返回"不满足"，误导
  用户去升级一个本来就满足的 Node；现在返回"无法解析"。三条实测：`22.x` → 无法解析、`>=99.0.0` → 不满足、
  `^24.11.0` → 满足。
- **README 的「先装插件也可以」改为诚实描述。** 发布的行指向的镜像 shim **由 setup 创建**，所以在第一次
  供给之前该行以 `MODULE_NOT_FOUND` 退出 —— 没有任何东西能启动后台供给。首次必须手动跑一次
  `setup.mjs`，此后才由 shim 自动补供给。

### 🔴 真机验证（Windows 11 x64，Electron 宿主 0.2.0-rc.2）当场抓到的

- **bootstrap 的便携 Node 路径必崩。** `$nodeFolder` 被连续剥了两次扩展名：`node-v24.21.0-win-x64.zip`
  → `node-v24.21`，而官方 zip 解出来的目录是 `node-v24.21.0-win-x64`。于是在**没有任何 Node 的机器**上
  —— 也就是这个脚本唯一的读者 —— 它会先成功下载（35 MiB）、校验通过、解压完成，然后抛
  `the Node zip did not contain node-v24.21`。本机有 Node，永远走不到这段分支，所以单测、审计、WSL 与
  沙箱端到端全都看不见它；真机复现（清空 PATH 模拟无 Node）一次即中。
  现在只剥一次，且解压后**接受任何真的带 `node.exe` 的目录**：已经付过下载代价的机器不该因为一次命名
  漂移而卡住。`-DryRun` 也会去认已经解压好的便携 Node（只认、不下载），这正是下面那条回归检查能
  **零下载**判定它的原因。

### 🟡 真机验证顺带修掉的（判据都来自仓库自身）

- **manifest 的 `optional: true` 被忽略。** `androidPlatformTools` 明写可选（"没有设备时这些工具只是报告
  没有设备"），而 `setup.mjs` 里 `optional` 出现 **0 次**：dl.google.com 不可达时整轮 exit 1 —— 其余组件
  都供给好了，却因为 adb 失败。现在可选组件的失败**照实报告**（`optional component(s) unavailable`），但
  不计入退出码、也不写进 `bundle.json`（shim 因此不会导出 `REA_ADB_PATH`）；被别的组件 `requires` 的组件
  永不被当作可选，免得"依赖失败却退出 0"。
- **`--reuse` 采纳 Node 只看"文件存在"。** manifest 的 `probe.why` 明写"reuse 路径必须在这里拒绝"，但旧代码
  只做 `fileExists`：PATH 上第一个是 Node 20 的机器会把它记进 `bundle.json`，失败推迟到 REA 启动才以难读的
  形式出现。现在每个候选（`REA_BUNDLE_NODE` 与**每一个** PATH 命中）都要先过 manifest 的版本闸门；跑不起来
  的候选（Windows 上 `.cmd`/`.bat` 包装器即 EINVAL）同样拒绝，并把原因打出来。
- **README：apktool 在 Windows 上实际不可用**（能力矩阵新增一行）——上游 `execFile` 不加 shell 直接起该命令，
  而 Windows 不能这样执行 `.bat`/`.cmd`。setup 的 apktool 探针走 `java -jar`（绕过包装器）所以报 `[ok]`，
  落差只在运行时暴露。
- **README：Electron 宿主不能用 `dsh plugin --profile desktop …`**（CLI 硬编码拒绝 `desktop` 这个 profile 名），
  改为指向应用内插件管理器。

### 回归防护

- `audit-manifest.mjs` 新增六项，全部做过反向验证（**故意写坏 6/6 都被抓住**）：`!!js` 裸标量 mapping
  检测、`DSH_HOME` 三态（未设/空/已设）求值一致性、README 与 patch 表达式不得漂移、镜像清单必须含
  manifest、镜像清单**不得**携带 `cordis.patch.yml`（它是 shim 区分两份副本的判据，被镜像进去会让镜像
  副本退回 `DSH_HOME` 规则）、**两份 README 结构平行**（节/子节数量，双语靠手工同步）。另外把
  「`DSH_HOME`/`USERPROFILE`/`HOME` 全空 → 根路径」这个**已知无害行为**钉成 warn（此前无覆盖）：该情形下
  该行报 `MODULE_NOT_FOUND`，不写文件、不下载，harness 照常。
- `validate.yml`：YAML 步骤注册 `!!js` 标量构造器（原先 `safe_load` 直接拒绝这个仓库要发布的行 ——
  **CI 一直是红的**）；行契约步骤断言 `args[0]` 是标量、不是 mapping；新增 `bundle:test` 与 `bundle:audit` 两步。
- `verify-branch.ps1`：dry-run 断言改为**不带 `--reuse`**（旧写法在本机 adopt 成功时正好掩盖了上面那个
  裸机缺陷），并新增"不得出现依赖不可用"一条；它现在也检查**自己**的 BOM，因为它是被编辑得最频繁的脚本。
- `verify-branch.ps1` 新增第 8 节：**空 PATH + 官方 zip 布局**下，bootstrap 必须认出已解压的便携 Node、
  且不得计划下载（`-DryRun`，零下载、零副作用）。反向验证：把该脚本 checkout 回 HEAD 版（双重剥离）
  → 两条断言立刻变红（`2 CHECK(S) FAILED`／`plan: download and extract ...`）。
- 单元测试新增四条**真的去 spawn shim**的用例（镜像布局、checkout 布局、`REA_BUNDLE_ROOT` 覆盖、裸跑只
  打印用法），并逐条做过反向验证：把 shim 改回"一律用自身位置"时 checkout 那条会红；去掉裸跑守卫时裸跑
  那条会红（后者自带桩保护，即使回退也只会跑到桩、不会下载）。
- 单元测试里的 POSIX 退化断言加平台守卫（`EXE` 为空时 `endsWith("java")` 恒真，在 Linux 上必红；
  WSL 实测修前 12/13、修后 17/17）。
- 单元测试新增四条（共 **21** 条；Windows 21/21、WSL 真 Linux 21/21）：`--reuse` 仍采纳兼容 Node、拒绝
  manifest 版本闸门不认的候选（用**改了正则的合成 manifest** 判定，跨平台确定，不依赖机器上恰好有什么）、
  拒绝跑不起来的候选、以及"可选组件失败不致命"。反向验证：把可选记账改回旧行为 → 那条立刻变红；把复用
  检查改回旧行为 → 另两条立刻变红；两次都确认了源码按字节复原。

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
