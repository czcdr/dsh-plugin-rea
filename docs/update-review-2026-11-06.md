# 2.0.14 — 外部审计的逐条修复与 DSH 宿主适配（2026-11-06）

输入是一份针对 `dsh-plugin-rea 2.0.13`（提交 `4d8a082`）的外部审计（18 项），外加一次宿主版本适配请求。
本轮**没有升级任何上游组件**：REA 6.8.0 / Ghidra 12.1.4 / JDK 21 / apktool 3.0.3 / jadx 0.7.1 / Node 24.22.1 全部原地。

结论先说：审计的主线判断是对的，而且比它自己写的更一致 —— **这七项动态缺陷的共同点是「验证的对象不是要交付的那个对象」**。
一次部分失败被记录成成功、一个坏路径被另一份好安装背书、一条超时的锁被从活进程手里删掉、一个探针只验证「同名组件在某处存在」。
所以本轮的修法也统一：让探针去看真正要交付的那份东西，并把「无法证明」和「证明失败」分开。

---

## 一、18 项审计条目：逐条状态

| # | 审计条目 | 严重性 | 状态 | 落点 |
|---|---|---|---|---|
| 1 | 多文件组件部分失败会记录成新版本并假绿 | 高 | **已修** | `scripts/setup.mjs` multi-file 段 |
| 2 | 已记录组件的探针没绑定 `recorded.path`（且不校验 pin） | 高 | **已修** | `scripts/setup.mjs` `recordedMatchesPin()` |
| 3 | 损坏 bundle 阻止 auto 回退，状态命令仍退出 0 | 中 | **已修** | `bin/rea-shim.mjs` `bundleUsable` |
| 4 | 六小时过期会删掉活进程的锁 | 中 | **已修** | `bin/rea-shim.mjs` + `setup.mjs` 心跳/token |
| 5 | JDK 探针不保证 21+ | 中 | **已修** | `manifest/bundle.manifest.json` |
| 6 | 当前策略使 Frida 原生绑定缺失 | 中 | **已修** | `scripts/setup.mjs` `ensureFridaBindings()` |
| 7 | 损坏的 `setup.lock` 让手动 setup 抛 `SyntaxError` | 低 | **已修** | `scripts/setup.mjs` `acquireRunLock()` |
| 8 | `check-updates.ps1` 假绿（drift/warn 不进结论） | 中 | **已修** | `check-updates.ps1` 判绿条件 |
| 9 | `bin/rea-guide.mjs` 忽略 `REA_BUNDLE_ROOT` | 低 | **已修** | root 解析链统一 |
| 10 | `ghidra-gate-override.mjs` 忽略自定义 root | 低 | **已修** | 同上 |
| 11 | `--dry-run` 仍创建 root/cache/log | 低 | **已修** | 一个字节都不写 |
| 12 | 归档替换先删后 rename，失败丢两份 | 中 | **已修** | `.backup` + 回滚 |
| 13 | `bundle.json`/`mirror.json` 非原子写 | 中 | **已修** | `writeJsonAtomic()` |
| 14 | override 先 patch 后写恢复记录 | 低 | **已修** | 先落盘再改 + 回滚 |
| 15 | override `--disable` 缺 vendor containment | 低 | **已修** | `containedPath()` + `lstat` |
| 16 | `tarfile.extractall()` 未用安全 filter | 纵深 | **已修** | `filter='data'` |
| 17 | Zod 4.4.3 落在 advisory 内（依赖闭包未锁） | 高 | **已修** | `scripts/vendor-lock/` + `npm ci` |
| 18 | `engines.node` 与宿主自带 Node 不一致 | 未列入 | **未解决，已记录** | 见 §五-1 |

---

## 二、关键缺陷的修法与实测证据

### 1. 多文件组件全有或全无（#1、#12）

复现形状：apktool 的 jar 下载失败、wrapper 成功，目标目录里残留 2.0.0 的 jar 通过了 `java -jar --version`，
记录写成 3.0.3 且哈希取自 wrapper，下一次运行 `already provisioned (3.0.3)` 不再下载。

修法四层：
1. **全部 entry 先取全**，缺一个即整体失败并打印 `N of M entries were available; nothing was installed`；
2. 所有文件先进 `<target>.staging`，**全就位后才原子换入**；
3. 旧目录改名 `.backup`，rename 失败或**探针失败**都回滚并明说 `the previous install was put back`；
4. 记录改成**每 entry 独立**的 `{id, version, sha256, tofu}`，`jarName`/`sha256` 按类型（`.jar`）而非列表顺序选主。

真机实测（本机 `D:\dsh-home\plugins\rea-bundle`，先手工备份 `vendor/apktool`）：摘掉 `bundle.json` 的 apktool 记录后
`--only apktool` 走完整路径 —— jar 用缓存、wrapper 重新下载（2386 B，pin 版本），目录里**恰好两个文件**
（历史遗留的 `apktool.bat.bak-2348` 随旧目录被丢弃，这是「目录内容严格等于 manifest」的预期结果），
无残留 `.staging`/`.backup`，`java -jar apktool.jar --version` 答 `3.0.3`，退出 0。

### 2. 探针绑定记录路径 + pin 校验（#2）

`recorded` 分支现在用**独立 context** 把该组件解析到 `recorded.path` 再探针（与 reuse 分支同一手法），
并新增 `recordedMatchesPin()`：记录版本必须等于 manifest 的 pin；JDK 按**主版本下限**匹配。

一个必须处理的例外：**已启用的 Ghidra 闸门覆盖**。本机 manifest 钉 12.1.4、盘上是 12.2，
若 pin 校验不认 `ghidra-gate-override.json`，一次普通 setup 会把操作员显式打开的覆盖**悄悄重钉回 12.1.4** ——
这是「修一个新缺陷时制造另一个」。实测 `--dry-run`：

```
[skip] node — already provisioned (24.22.1) — pinned 24.22.1
[skip] jdk — already provisioned (25.0.5) — major 25 satisfies the pin's major 21
[skip] ghidra — already provisioned (12.2) — recorded 12.2 matches the enabled gate override
[skip] apktool — already provisioned (3.0.3) — pinned 3.0.3
[skip] jadxHeadlessMcp — already provisioned (0.7.1) — pinned 0.7.1
[skip] androidPlatformTools — already provisioned (latest (37.0.1)) — pinned latest (37.0.1)
[skip] reaAgents — already provisioned (6.8.0) — pinned 6.8.0
```

### 3. 统一「bundle 可用」判定（#3）

`loaded.ok`（JSON 解析成功）曾被当成「已供给」，一口气决定三件事：启动选择、状态退出码、是否进入修复。
现在 `bundleUsable = loaded.ok && resolveRea(...).ok`，三处共用：

- 启动选择：不可用的 bundle 不再凭「记录版本更新」赢过可用的系统 REA；
- `--shim-status`：不可用且无系统 REA → 退出 **78**（原来 0），报告新增 `bundleUsable` 字段；
- 修复路径：状态可解析但运行时缺失，现在也会进入 auto-provision（原来直接 `fail()`）。

### 4. 锁：存活 pid 是硬证据，过期只是软证据（#4）

原规则只信任 6 小时内的锁，超时后**不问持有者是否还活着**就删。慢下载确实会跑过六小时，删锁后第二个
provisioning 会写同一份 cache、同一批 `.staging` 和同一份 `bundle.json`。

现在：
- pid 活着 → **永不删**；超过窗口报 `in-flight-stale`（附 pid 与「多久没汇报」），由操作员决定；
- pid 证明已消失 → 回收；
- **无 pid 的旧式数字锁**（没有人可查）→ 仍按时间处理，否则「无法判断」会永远读成「活着」；
- 配套：`setup` 的 `log()` 兼作**心跳**（30 s 节流刷新 `at`）—— `spawnSync` 下载会饿死定时器，所以心跳挂在进度输出上；
- shim→setup 的交接从 **PID 交接改为 token 交接**（`REA_BUNDLE_LOCK_TOKEN`）：原窗口里 setup 可能在 shim 改写
  `child.pid` 之前就读到一个不属于自己的活 pid，于是倒在自己的锁上、退出 75（审计把它列为静态风险，100 次自然启动未命中）。

`failed` 记录**仍然优先于 pid 检查**：失败进程的 pid 必然已消失，顺序颠倒会把「阻止无限重试的刹车」当成陈旧锁删掉。

### 5. JDK 探针（#5）

`jdk.compiler` 只区分完整 JDK 与裁剪运行时 —— 真实 Java 17.0.20 同样打印 `jdk.compiler@17.0.20`。
`expect` 现在同时要求两件事（`runProbe` 对 `contains` 和 `regex` 是 AND）：
`contains: jdk.compiler` **且** `regex` 匹配版本段 ≥ 21（21–29 / 30–99 / 100+）。8 组版本串正反验证通过，
含本机真实输出 `jdk.compiler@25.0.5`。

### 6. Frida 原生绑定（#6）

实测复现：`import('frida')` → `Could not locate the bindings file. Tried: … frida\build\frida_binding.node`。
原因是 frida 的 `install` 脚本（`prebuild-install`）是放置这个 .node 的**唯一**途径，而 `--ignore-scripts` 跳过了它。

修法不是删 `--ignore-scripts`（那是正确的加固），而是**点名这一个包**：`npm rebuild frida` → 用
`import('frida')` + `enumerateDevices()` 验证。修好后 135.7 MB 的 `frida_binding.node` 落地，
实测 `IMPORT OK` + 3 个设备（`local/local`、`socket/remote`、`barebone/remote`），即 `FRIDA_OK 3`。

**检查放在 `main` 层而不是 provisioning 路径里** —— 否则「已记录 6.8.0 的存量 bundle」（也就是每一次升级）
永远不会进入那段代码，绑定会一直缺着而每行都在说 `already provisioned`。结果写进
`components.reaAgents.frida = {available, binding, sha256, devices}`；不可用时按 `browser` 的先例报 `skip`，
不把一次可用供给判成失败（`step(..., "FAIL")` 会进 `failed` 数组并让 setup 退出 1）。

### 7. 依赖闭包（#17）

`rea-agents@6.8.0` 对 zod 是**精确锁 `"4.4.3"`**，所以「装一个 4.6.7 覆盖它」会得到**两份 zod**，REA 仍吃坏的那份
（实测否决）。`overrides` 是唯一不改发布 tarball 的杠杆，`npm ci` + lockfile 再补上「每次同一份字节」。

放大实测（同一个 `.max(2)` schema 喂 25 个元素）：zod 4.4.3 → **26 条 issue**，4.6.7 → **1 条**；
REA 自己的 `inspectAnalysisSettingsInputSchema` 同样 26 → 1。

落地：`scripts/vendor-lock/`（lockfileVersion 3，183 条目）→ `zod 4.6.7` / `minimatch 11.0.5` / `glob 14.0.4`，
各单副本。兼容性实测：`@electron/asar` 在 glob 14 / minimatch 11 下 create/list/extract/stat **往返通过**；
REA 真实 MCP stdio 握手 `tools/list` 仍是 **229/229 且每个都有 inputSchema**（与 4.4.3 基线一致）。

---

## 三、修复过程中发现的、审计没提的问题

三处都是「修完之后自查」抓到的，不是审计输入的：

1. **`"21"` 这种只有主版本的 pin 被当成「家族前缀」**（`scripts/pin-match.ps1`、`bin/rea-guide.mjs`）。
   `25.0.5` 对 pin `21` 被判成漂移 → `check-updates.ps1` 说「重跑 setup 对齐」，而 setup 说
   「already provisioned (25.0.5) — major 25 satisfies the pin's major 21」。Ghidra 要求的是「JDK 21 **或更新**」，
   所以**只有主版本的 pin 是下限，不是前缀**。三个文件现在的判定一致。
2. **`check-updates.ps1` 的假红**：`rea doctor` 退出码 1 涵盖「任何可选能力未配置」（Hopper / IDA / Kuna /
   skill 副本 / 五个客户端登记），于是一台供给完好的机器恒报「需要动作」。退出码降为 `[上游]`，
   实际状态由输出解析出的 provider 检查决定 —— 假绿修完之后不能顺手留下假红。
3. **依赖锁的新读取绕过了 BOM 处理**：`.mjs` 里新增的两处 `JSON.parse(readFileSync(...))` 会被
   `verify-branch.ps1` 的「no BOM-blind JSON read」判定拦下（确有其事：带 BOM 的 lock 会被读成「锁里什么都没钉」）。
   改为走 `readJsonSafe()`。附带发现 `verify-branch.ps1` 的这条检查会把**注释里**的同名字面量也算进去 ——
   所以注释措辞一并改掉了。

---

## 四、DSH 宿主适配（0.2.1-rc.3 → 0.2.2-rc.1）

细节见 [`host-compat-2026-11-06.md`](host-compat-2026-11-06.md)。要点：

- `HOST_RELEASES` 10 → **16**，`engines.dsh` 声明与 `OUTSIDE_HOSTS` 都没动（6 个新版本全在范围内）。
- 6 个 tag 三源交叉核实（releases 页 / atom / npm registry）**全部真实存在**，原有 10 条一条未被撤下；
  `0.2.2-rc.1` 是当前 `latest`。排序按**发布日**而非 semver（`0.2.1-rc.5` 晚于 `0.2.2-alpha.2`），这处倒序钉死在测试里。
- 接口面逐条核对：6 个版本都没有触及本插件依赖的五处表面。唯一沾边的是 `0.2.2-rc.1` 的
  Cordis Core 4.1.0 / Loader 1.1.0，**已在本机 0.2.2-rc.1 上实测**：`GET /dsh-plugin-rea/guide-state` → 200。
- 现场取证市场语义：`dshmarket/lib/verify.js` 与 `discovery-compatibility.js` 都**只读 `engines.dsh`**，
  不读 `engines.node`。

---

## 五、没有解决的，以及为什么

1. **`engines.node` 仍是 `^22.23.4 || ^24.22.1 || >=26.12.1`**，而 `0.2.2-rc.1` 桌面宿主自带 Node **24.21.0**。
   实测市场不读这个字段，npm 默认也只警告 —— **但 `engine-strict=true` 的用户会装不上**。
   没放宽的原因不是怕，而是它现在被 `audit-manifest.mjs` 强制与 `manifest.pins.nodeEngines`（REA 的真实要求）
   **逐字相等**；拆开「插件的 Node 要求」与「REA 的 Node 要求」是一次独立改动，塞进本轮会让那条守护变模糊。
   运行期不受影响：REA 用 `bundle.json` 的 `paths.node`（24.22.1）启动。
2. **`dsh.client.inject` 仍列出 `@deepseek-ai/dsh-client-runtime`**，该包在 `0.2.2-rc.1` 宿主里**一次都不出现**
   （331 个 `@deepseek-ai` 包目录、整份 213 MB asar 字节扫描，0 命中；它是构建期 `devDependency`）。
   宿主对未知 inject 项**静默跳过**（`dsh-client-modules/lib/client.js` 的 `graphRows.get()` 取不到就什么也不做），
   且本插件 `client.js` 不 require 它，真实闸门是服务 `["slots"]`。所以卡片照常渲染；保留它是为了不损害旧宿主适配。
   属清理项，不是缺陷。
3. **Ghidra 默认 pin 仍是 12.1.4**（带那四个 CVE）。审计明确说这不是本轮新发现，也明确说「不能只把 manifest 改成
   12.2」—— 12.2 需要 JDK 25+ 且 REA 未验证，只能通过 `ghidra-gate-override.mjs` 显式开启。
   **在升级这个 pin 之前，不要用内置 Ghidra 分析来源不可信的样本。**
4. **硬链接逃逸没做 containment**：同卷硬链接与 bundle 内文件共享 inode，纯路径检查区分不了。
   本轮拒绝的是 `../`、绝对路径、符号链接/junction（均已实测）。
5. **minimatch / glob 在 REA 默认 MCP 路径上的可达性仍未证实**：本轮把它们抬到修复线上，没有证明可利用性。
   `glob 13 → 14` 是跨大版本（asar 声明 `^13.0.2`），已用 asar 往返与 229 工具 schema 验证，但**没有**把真实
   `.asar` 喂进 REA 的 asar 工具端到端跑一遍（没有现成样本）。
6. **lock 放在 `scripts/vendor-lock/` 而不是仓库根**：根级新目录不在 `package.json` 的 `files` 白名单里，
   发出去会静默走降级路径。setup 同时认 `HERE/vendor-lock` 与 `PLUGIN_ROOT/vendor-lock`，
   所以将来搬到根级只需加一条 `files`，代码不用动。已实测 `npm pack` 确实带上了这两个文件。
7. **CI 时序**：`bundle:deps` 已作为独立 step 接进 `validate.yml` 的两个 job，但它是在本轮**第二个**提交里补上的
   —— 第一次推送用的凭据缺 GitHub `workflow` scope，服务端拒绝改 workflow 文件
   （`refusing to allow an OAuth App to create or update workflow … without 'workflow' scope`），
   所以那一次提交刻意排除了 workflow 改动。第二次换用带 `workflow` scope 的凭据后才补上，
   期间 CI 的 Windows job 先红了一次（原因见 §三 的测试夹具 bug），已修复。

---

## 六、验证清单

```
单测        154 项：151 过 / 0 失败 / 3 跳过
            setup.test 98 · deps.test 17 · host-compat.test 25 · hardening.test 14
manifest    audit 24 条下载 entry 全部 SHA-256 钉死，0 TOFU，clean
依赖闸门    zod 4.6.7 · minimatch 11.0.5 · glob 14.0.4，各单副本
宿主兼容    16 releases covered，5 correctly outside
verify-branch   ALL CHECKS PASSED
```

新增回归测试（**在 2.0.13 的代码上会红**）：部分失败不成假绿且第二次仍重试、记录路径不被 vendor 背书、
pin 漂移不被信任、JDK 17/11/9 被拒、`--dry-run` 不写盘、坏锁不抛异常、`tarfile` 带 filter、
坏 bundle 回退系统 REA、`--shim-status` 对不可用 bundle 返回 78、活 pid 的过期锁不被删。

真机链路：`--dry-run` 7 组件正确 skip → 强制重装 apktool 走 staging（无残留）→ `--reuse` 全量 8 组件 +
`fridaBindings FRIDA_OK 3` → `probe 229 tools` / `smoke 28 s` / `shim 6.8.0`，退出 0；
`check-updates.ps1` 由退出 1（假绿/假红混合）转为退出 0。

## 七、复现命令

```powershell
cd D:\dsh-plugin-rea
node --test ./scripts/setup.test.mjs ./scripts/deps.test.mjs ./scripts/host-compat.test.mjs ./scripts/hardening.test.mjs
node scripts/audit-manifest.mjs
node scripts/check-dependency-advisories.mjs
node scripts/host-compat.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-branch.ps1
node scripts/setup.mjs --dry-run --root "$env:DSH_HOME\plugins\rea-bundle"
```
