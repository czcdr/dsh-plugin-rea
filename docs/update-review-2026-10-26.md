# 更新落地：REA 6.7.0 → 6.8.0（2026-10-26）

上游在 2026-10-25 放出 `rea-agents@6.8.0`（npm `latest`）。本轮按以往的做法核对全部钉子、只升级能升的那一个，
并在真机上把整条链路重跑一遍。**结论：只动 REA 一个 pin，但它连带改了 Node 的 engines 下限，所以三处措辞一起动；
Ghidra / jadx / JDK / apktool / platform-tools / Node 全部原地不动。**

---


## 0. 结论

| 组件 | 上游最新 | 本轮钉子 | 动作 | 依据 |
|---|---|---|---|---|
| REA（`rea-agents`） | **6.8.0**（2026-10-25） | **6.8.0** | **升** | npm `dist-tags.latest = 6.8.0`，`time.modified 2026-10-25T09:07:31Z` |
| Node | LTS 24.22.1（2026-10-20）；current 26.12.1（非 LTS） | 24.22.1 | 不动 | 24.22.1 仍是 24 线最新 LTS，且**正好等于 6.8.0 的 24 线下限** |
| Ghidra | **12.2**（2026-10-22） | 12.1.4 | **不动**（本机可覆盖，见 §9） | 6.8.0 的 `SUPPORTED_GHIDRA_VERSION` 仍是 `12.1.4`；12.2 判 `unsupported`，Ghidra 系工具整组消失 |
| jadx 桥接 | **0.8.0**（2026-10-19） | 0.7.1 | **不动** | 6.8.0 的 `JADX_RELEASE` 仍是 0.7.1，`sha256` 与盘上 jar 逐字节相同 |
| JDK | 21.0.13+9（无 Windows 资产）/ 25.0.4.1+1（Windows 线） | 21.0.12.1 | 不动 | Adoptium `/v3/assets/latest/21/...os=windows` 仍返回 21.0.12.1+1（`updated 2026-08-21`） |
| apktool | 3.0.3（2026-07-20） | 3.0.3 | 不动 | GitHub latest 未变；jar 15,478,013 B / `dbf930b0…` 现场复核 |
| platform-tools | 滚动 | 37.0.1 | 不动 | 现场 `adb version` = 37.0.1 (1.0.41)，`source.properties` `Pkg.Revision=37.0.1` |

本轮唯一变化的 pin：`reaAgents 6.7.0 → 6.8.0`。唯一连带变化：`nodeEngines` 与 node probe。

**例外：Ghidra 12.2 在本机是「有记录的本机覆盖」，不是 pin 变更**（§9）。四项 CVE 的修复版就是 12.2，实测桥接可用、
分析结果与 12.1.4 逐字节一致，所以给了 `scripts/ghidra-gate-override.mjs` 这条显式通道；`setup.mjs` 仍按 12.1.4 供给。

---

## 1. 6.8.0 是什么

不是修 bug 的补丁版，**是工具扩容**：

| 项 | 6.7.0 | 6.8.0 |
|---|---|---|
| tarball 条目 | 1775 | **2398** |
| `node_modules` 条目 | 0 | 0（仍由 `npm install --ignore-scripts` 解闭包） |
| 解包体积 | — | 49,251,336 B（压缩包 9,944,902 B） |
| MCP 工具 | 207 | **229**（+22） |
| CLI 命令 / prompt | — | 175 / 6 |
| catalog 记录 | 无 | `dist/mcp-catalog.json`（含 `identity.counts` 与三个 digest） |
| engines.node | `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` | **`^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1`** |
| 依赖闭包 | 42 条 | 44 条（+`@bufbuild/protobuf 2.16.0`、+`@msgpack/msgpack 3.1.3`） |

文件级差异（按路径比对）：**+843 / −225**。新增族从目录名就能看出来：`dist/apkSignature/*`（APK 签名与证书）、
`dist/application/binaryDiagnostics/*`（PE 证书/导入/加载配置、ELF notes、内核模块、devicetree、Apple IPS、
字节熵）、`inspect_model_artifact`（GGUF v2/v3、safetensors 声明）、`inspect_gpu_code_objects`（CUDA fatbin /
CUBIN / PTX / HIP bundle 的静态解析）。后两者**不需要外部引擎**（描述里明写 "without loading models or
executing code" / "No GPU tools"），所以 `notProvisionable` 不用新增条目。

catalog 自带的三个 digest（可用来判定「装的是不是同一份工具表」）：

```
tools_sha256    a98940ba69acd9c1781d180cee362d4ddab18f77eefdd3e3216f10e1bf98e5e9
prompts_sha256  9609379442110570cd52fdea61a777242350873bc28958f54827ca3590e680b7
combined_sha256 fe938a7c6eba3763b22ae2022de76dc4a7812d35d86f1d4efd36b9962b04da0b
```

---

## 2. 为什么只有 REA 动了：两道闸门实测

把 6.8.0 的策略模块直接加载执行（不是读代码推断）：

```
dist/ghidra/GhidraReleasePolicy.js
  12.1.4 → verified
  12.1.5 → compatible        （这个 release 并不存在，12.1.x 最后一版就是 12.1.4）
  12.2   → unsupported
  12.2.0 → unsupported

dist/android/JadxRelease.js
  JADX_RELEASE = { version: "0.7.1",
                   revision: "5844800a486d2248fa949b74c9896285f5b54de2",
                   sha256:   "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75" }
  ↑ 与盘上 vendor/jadx/jadx-headless-mcp-0.7.1-all.jar 的实测哈希一致
```

也就是说：**6.8.0 没有放宽任何一条版本线**。Ghidra 12.2 会照旧让整个 Ghidra 族消失，jadx 0.8.0 会照旧在
`load_apk` 之前抛 `Expected engine 0.7.1`。这两项维持 10-24 那轮的决定。

---

## 3. engines 抬升：一处声明，三处执行

REA 抬了下限，本包有三处必须同时跟上，否则会出现「文档说一套、reuse 路径执行另一套」：

| 位置 | 值 | 谁在校验 |
|---|---|---|
| `manifest.pins.nodeEngines` | `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1` | `audit-manifest.mjs` §12 与 `package.json engines.node` 逐字比对 |
| `package.json engines.node` | 同上 | npm / DSH 市场 |
| `components.node.probe.expect.regex` | 见下 | setup 的 reuse 路径（把一个 24.11 的 Node 判成可用就是静默降级） |

probe 只有一条正则、没有版本比较器，所以写成一条交替：

```
^v(22\.23\.(?:[4-9]|[1-9][0-9]+)      # 22.23.4 … 22.23.x
 |22\.(?:2[4-9]|[3-9][0-9])\.\d+      # 22.24+ … 22.9x
 |24\.22\.(?:[1-9]|[1-9][0-9]+)      # 24.22.1 … 24.22.x
 |24\.(?:2[3-9]|[3-9][0-9])\.\d+      # 24.23+ … 24.9x
 |26\.12\.(?:[1-9]|[1-9][0-9]+)      # 26.12.1 … 26.12.x
 |26\.(?:1[3-9]|[2-9][0-9])\.\d+      # 26.13+ … 26.9x
 |2[7-9]\.\d+\.\d+|[3-9][0-9]\.\d+\.\d+)
```

用 24 组版本正反验证（正例 12 / 反例 12，0 处不符）：

```
接受  v22.23.4 v22.23.10 v22.24.0 v22.30.1 v24.22.1 v24.22.9 v24.22.12
      v24.23.0 v26.12.1 v26.12.15 v26.13.0 v26.20.0 v27.0.0 v30.1.2
拒绝  v22.19.0 v22.23.3 v24.11.0 v24.21.0 v24.22.0 v25.0.0 v26.0.0
      v26.12.0 v20.19.0 v18.20.0
```

**用户可见的后果**：6.7.0 时代合法的 Node 22.19–22.23.3 与 24.11–24.22.0，现在会被 reuse 路径拒绝。
钉住的 24.22.1 现在是 24 线**既最新、又最低**可接受的那一个 —— 这种「钉值同时是下限」的情况本包第一次遇到。

---

## 4. 实测记录（Windows 11 x64）

`node scripts/setup.mjs --reuse`：

```
[skip] node    — reusing existing node from PATH: F:\jiuguan\node.exe
[skip] jdk     — reusing existing jdk from JAVA_HOME: F:\game\xbox\
[skip] ghidra  — reusing existing ghidra from GHIDRA_INSTALL_DIR: D:\ghidra\ghidra_12.1.4_PUBLIC
[skip] apktool — already provisioned (3.0.3)
[skip] jadxHeadlessMcp — already provisioned (0.7.1)
[skip] androidPlatformTools — already provisioned (latest (37.0.1))
[ok  ] reaAgents — …\vendor\node_modules\rea-agents
[ok  ] probe   — cli=6.8.0 healthy=false tools=229 unmet=10
[ok  ] smoke   — imported java.exe in 26s via ghidra
[ok  ] shim    — resolved to REA 6.8.0
setup complete.
```

`healthy=false` 与 `unmet=10` 是**预期**：Hopper / IDA / Kuna / 五个客户端的 registration / skill 都属「调用方自备」，
供给刻意不碰（与 6.7.0 时同样的 10 条）。

独立 stdio MCP 握手（不经 PATH 的 `rea`）：

```
initialize → serverInfo {name: rea, version: 6.8.0}, protocol 2024-11-05
tools/list → 229, nextCursor null
prompts/list → 6
```

`rea doctor --json` 的 identity 段与 tarball 里的 catalog 一致：

```
cli_package_version 6.8.0 · expected_skill_version 49 · sdk 2.3.1
catalog.counts {cli_commands: 175, mcp_tools: 229, mcp_prompts: 6}
```

各引擎现场复核：`java --version` = openjdk 25.0.5（宿主 Corretto）；`java -jar vendor/apktool/apktool.jar --version`
= 3.0.3；`vendor/platform-tools/adb.exe version` = 1.0.41 / 37.0.1；`vendor/jadx/jadx-headless-mcp-0.7.1-all.jar`
= 42,619,858 B / `6e5eacf5…`。

门禁：单测 **88（85 过 / 3 平台跳过 / 0 失败）**、`audit-manifest` **24/24 hash-pinned clean**、
`verify-branch.ps1` **ALL CHECKS PASSED**、`host-compat` 10 covered / 5 outside。

---

## 5. 供给过程里的一个坑（值得写进排障）

第一次 `setup --reuse` 在 reaAgents 这一步失败：

```
[FAIL] reaAgents — npm install failed (4294963219): npm error network … ECONNRESET
```

npm 日志显示 `rea-agents-6.8.0.tgz` 取包时 `read ECONNRESET`（`errno -4077`），reify 回滚后 probe 仍读 6.7.0 /
207 工具 —— 读起来像「升级根本没生效」。原因不是哈希、不是权限：**setup 的 npm 子进程不继承本脚本自己的代理
路由**，而直连 registry 的 tarball 在这条网络上是断的（同一个 URL 用 `Invoke-WebRequest` 却能下完，所以只看
浏览器/`curl` 会误判）。

解法：给 setup 的进程环境加代理后重跑即可。

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7890"; $env:HTTP_PROXY="http://127.0.0.1:7890"
node scripts/setup.mjs --reuse
```

---

## 6. 仍不能升的四项（与 10-24 结论一致）

1. **Ghidra 12.2**：`SUPPORTED_GHIDRA_VERSION = "12.1.4"` 未变；跨 minor 即 `unsupported`，Ghidra 族工具整组不可用。
   —— 但这条闸门**不等于 12.2 坏了**：实际测下来它可用，见 §9。
2. **jadx 0.8.0**：`JADX_RELEASE.version` 仍是 0.7.1，`JadxSession` 在其自报版本不等时立刻抛错。
3. **JDK 21.0.13**：Adoptium 的 Windows 资产仍停在 21.0.12.1+1；且 21.0.13 只移除 4 个 eMudhra 锚里的 3 个。
4. **Node 26**：`26.12.1` 是本轮唯一的 26 线新版本，但它是 current 而非 LTS；本包钉 LTS，且 24.22.1 已满足
   6.8.0 的 `^24.22.1`。

---

## 7. 重开条件

| 触发 | 动作 |
|---|---|
| REA 把 `SUPPORTED_GHIDRA_VERSION` 提到 `12.2.x` | 换 Ghidra 源（一个 zip 通吃三平台），重跑冒烟（首次导入 26–64 s） |
| REA 把 `JADX_RELEASE` 提到 0.8.0 | 换 jar 的 url/size/sha256（vendor 侧 sha256 可自算），并确认桥接类仍能加载 |
| Adoptium 为 21 线发布 Windows 资产 | 换 5 条 jdk 源（win32-x64 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64） |
| Node 26 转为 LTS | 重新评估是否把 `pins.node` 抬到 26（engines 已允许 `>=26.12.1`） |

---

## 8. 本轮没做的事

- **没有 npm publish、没有 GitHub Release**：`package.json` 到 2.0.13，仓库与 tag 先行，npm `latest` 仍是 2.0.12。
- **没有动 Ghidra / jadx / JDK / apktool / platform-tools 的任何一个字节**。
- **没有清理 `C:\Users\lenovo\.dsh`** 下的旧 bundle（本机 `DSH_HOME=D:\dsh-home`，那份是历史遗留，与当前宿主无关）。
- **没有跑 macOS / Linux 的首次供给分支**（本机只有 Windows）。

---

## 9. 能不能升到 Ghidra 12.2（这四个 CVE 的修复版）：能，但要覆盖上游闸门

用户问的是「这些不是漏洞吗，能不能升到最新版、同时保证 REA 能用」。答案分两半：**「升」可以，「默认升」不行**，
因为挡住 12.2 的不是兼容性，是 REA 自己的一条版本等值判定。

### 9.1 试了什么

```
下载   ghidra_12.2_PUBLIC_20261016.zip   569,712,708 B
sha256 2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67  ← 与 release body 一致
解包   application.version=12.2 · application.java.min=25 · analyzeHeadless.bat / win_x86_64 decompile.exe 均在
```

只改了 **vendored 副本**里那三处常量（`dist/ghidra/GhidraReleasePolicy.js`、`dist/cli-runtime/KunaCommand-*.js`、
`dist/mcp/binary-*.js`，都是 `SUPPORTED_GHIDRA_VERSION = "12.1.4"`），把值换成 `12.2`。

### 9.2 结果

| 检查 | 12.1.4（pin） | 12.2（覆盖后） |
|---|---|---|
| `rea doctor` ghidra-version | `12.1.4` ok | `12.2; compatible 12.2.x release` ok |
| `rea doctor` ghidra-java | `25.0.5 … accepted a 64-bit full JDK 21 or newer` | `25.0.5 … accepted a 64-bit full JDK 25 or newer` |
| `rea analyze whoami.exe` | 52 s · 9 段 / 341 函数 / 308 字符串 | 52 s · 9 段 / 341 函数 / 308 字符串 |
| `list_segments`（MCP，经 shim） | 基准 | **逐字节相同** |
| `list_procedures`（MCP） | 基准 | **逐字节相同**（74,483 字符） |
| `procedure_pseudo_code("entry")` | `FUN_1400021b4(); FUN_140001af0();` | **逐字节相同**（101 字符） |
| `provider.version` | `12.1.4` | `12.2` |

即：**段表、函数表、入口伪代码三样在两个版本上完全一致**，桥接也没有出现 API 漂移的编译/运行错误。

### 9.3 所以怎么用

```powershell
node scripts/ghidra-gate-override.mjs --status                 # 现在是什么状态
node scripts/ghidra-gate-override.mjs --enable --version 12.2  # 打补丁 + 记录
node scripts/ghidra-gate-override.mjs --disable                # 还原成上游闸门
```

- 状态写进 `<bundle>/ghidra-gate-override.json`（原值、目标值、改了哪几个文件、何时启用）。
- **重跑 `setup.mjs` 会重新供给 rea-agents，补丁随之消失** —— 这是刻意的：选错方向的默认值应该是「回到钉住的
  已验证组合」，而不是「悄悄继续跑未验证的版本」。
- `check-updates.ps1` 认得这份记录：盘上是 12.2 时它打印「本机覆盖 Ghidra 闸门」，不再劝你「重跑 setup 对齐」。
- 12.2 要求 **JDK ≥ 25**（`application.java.min=25`）。本机 `JAVA_HOME=F:\game\xbox` 是 Corretto **25.0.5**，
  正好满足；而本包钉的 vendor JDK 是 **21**，所以「干净机器 + 12.2」还得把 JDK 钉到 25
  （Adoptium 25 线 Windows 资产是 25.0.4.1+1）。

### 9.4 没被验证的部分（说清楚）

只测了 PE 的 `open_binary` / `list_segments` / `list_procedures` / `procedure_pseudo_code` / `analyze`。
**没测**：ELF / macOS / COM / DOL / raw 这些走各自 `ReaGhidraPrepare*` 的路径、PSP 扩展、
值流（`trace_native_values`）、decompiler hook（`ReaGhidraNoReturnFix`、`ReaGhidraMipsSoftFloat`）的边角。
上游没有验证 12.2，这些边角现在记在使用者名下 —— 这正是上游闸门存在的理由，覆盖它就得承担它。

---

## 10. CVE-2026-91403（JSSE / eMudhra）为什么不靠「升级」解决

- **没有已发布的 JDK 移除全部 5 张 eMudhra 锚**：Temurin 21.0.13 只掉了 c1/c3/g3（保留 g1），Corretto 25.0.5 五张全在。
  所以「升到某个版本就干净」在任何厂商都不成立。
- **这条链上没有 Java 侧出站 TLS**：REA 本体是 Node（用 Node 自带的 CA 集，不用 Java truststore）；Ghidra 是本地
  headless，jadx 桥接也是本地进程。Java truststore 里那几张锚在这条链上**没有被使用的调用点**。
- 真要清理，只能给 REA 单独做一份剔除了 emsign 锚的 truststore 并通过 JVM 参数指过去；那属于硬化动作，
  不改变本链路的实际暴露面。本轮没有做。

---

## 11. jadx 0.8.0 为什么不在这次

它没有对应的 CVE 修复诉求（用户的问题是关于漏洞的），而 REA 对它的要求是**精确等于 0.7.1 + 该 jar 的 sha256**；
0.8.0 会在 `load_apk` 之前抛 `Expected engine 0.7.1`。要升它同样得覆盖 `JADX_RELEASE`，风险与本轮无关，暂不动。

---

## 附：WSL 侧核对

用户的会话标题带「WSL 环境更新」，所以顺带查了一遍：

| 项 | 实测 | 判断 |
|---|---|---|
| WSL 发行版 | Ubuntu 22.04.5 LTS（WSL2，内核 6.18.54.1） | 与本次更新无关 |
| WSL 原生 Node | `/usr/bin/node` = **v22.23.4** | 正好等于 6.8.0 的 22 线下限（旧 engines 的 `^22.19.0` 也吃它）→ 无可升级项 |
| WSL 侧 `~/.dsh` | 不存在 | 没有第二份 bundle 要供 |
| WSL 里的 `dsh` | `/mnt/d/dev/npm-global/dsh`（Windows 侧实体） | 用的仍是 `D:\dsh-home` 那一份 → 更新一处即覆盖两边 |

结论：**WSL 侧不需要单独更新**，REA 6.8.0 通过共享的 `D:\dsh-home\plugins\rea-bundle` 同时生效。
