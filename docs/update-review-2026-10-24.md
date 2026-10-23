# 更新审查：为什么现在不动这些钉子（2026-10-24）

一次针对“能不能把运行时升到最新”的核查。结论写在最前面，证据按下表逐条可复现；
最后是重开这个决定的条件，以及本轮**没有**做的事。

## 0. 结论

| 组件 | 上游最新 | 本机/钉子 | 能否升 | 依据 |
|---|---|---|---|---|
| REA（`rea-agents`） | 6.7.0 | 6.7.0 | 已是最新 | npm `dist-tags.latest = 6.7.0` |
| Node | 24.22.1 | 24.22.1 | 已是最新 | `nodejs.org/dist/index.json`：24 线最高 24.22.1（2026-10-20） |
| apktool | 3.0.3 | 3.0.3 | 已是最新 | GitHub latest = v3.0.3（2026-07-20），jar 15,478,013 B / `dbf930b0…` 一致 |
| platform-tools | 滚动 | 钉了当前字节 | 无需动 | 下载今日 `platform-tools-latest-windows.zip`：8,044,989 B / `45f4d631…` 与钉子逐字节一致 |
| Ghidra | **12.2**（2026-10-22） | 12.1.4 | **不能** | REA 只接受 12.1.x，12.2 判 `unsupported` |
| jadx 桥接 | **0.8.0**（2026-10-19） | 0.7.1 | **不能** | REA 硬校验引擎自报版本必须等于 0.7.1 |
| JDK | 21.0.13+9 / 25.0.5+8 | 21.0.12.1（vendor）/ Corretto 25.0.5（运行） | **Windows 上不能** | 两个 release 都没有任何 Windows 资产 |

**净结论：本轮不移动任何 pin。** 能升的两项会当场打掉整组工具；JDK 在 win32-x64 上没有可指的构建；
其余三项已是上游最新。现有组合实测 207 个工具全绿（见 §3）。

## 1. Ghidra 12.2：被 REA 的发布线挡住

REA 运行时的策略常量：

```
dist/ghidra/GhidraReleasePolicy.js:2   export const SUPPORTED_GHIDRA_VERSION = "12.1.4";
dist/ghidra/GhidraReleasePolicy.js:13  if (raw === SUPPORTED_GHIDRA_VERSION) → verified
                                       else version.major/minor 相同 → compatible
                                       else → unsupported
dist/ghidra/GhidraReleasePolicy.js:54  ghidraReleaseAccepted = status === "verified" || "compatible"
```

把该模块直接加载执行的结果：

```
12.1.4 → verified
12.1.5 → compatible        ← 若上游发 12.1.5，会自动放行
12.2   → unsupported       ← 12.2.0 同样
12.0.4 → unsupported
```

`GhidraInstallation.js` 在 `:515` 用 `ghidraReleaseAccepted(raw)` 决定 `passed`，`:107/:135-145` 一旦
有 failed check 就返回 `unavailable`。也就是说升 12.2 之后：provider 直接不可用，
`analyze_function` / `procedure_pseudo_code` / `list_segments` / `search_bytes` 等整组消失——不是降级。

插件的 `check-updates.ps1:228` 也钉着 `^12\.1\.`，会同步报“REA 当前要求 Ghidra 12.1.x”。

**代价**：Ghidra 12.1.4 的四个 CVE 继续留在链上（见 §4）。

## 2. jadx 桥接 0.8.0：一条版本等值断言

REA 对 jar 的准入分三层，前两层 0.8.0 都能过，第三层过不去：

```
dist/android/JadxConfiguration.js:224-241   要求 jar 内含 5 个桥接类（0.8.0 全部存在）
dist/android/JadxSession.js:55-57           serverInfo 必须是 rea-jadx-bridge/4（由 REA 自己的桥提供，不在 jar 里）
dist/android/JadxSession.js:59-62           const runtime = await tools.json("rea_jvm_status", {});
                                            if (runtime.engine_reported_version !== JADX_RELEASE.version) throw
                                            `Expected engine 0.7.1; JAR reported …`
dist/android/JadxRelease.js:3               version: "0.7.1"
dist/android/JadxRelease.js:5               sha256: 6e5eacf5…ff75（仅用于 source_revision，不参与准入）
```

实测两个 jar 的 `com/atxx/jhmcp/BuildInfo.class`（`javap -v`，`VERSION` 是 `ConstantValue`，
只有 `-c` 看不到赋值）：

```
0.7.1-all.jar → ConstantValue: String 0.7.1
0.8.0-all.jar → ConstantValue: String 0.8.0
```

失败点在 `load_apk`（`JadxSession.js:64`）之前，即 JVM 起 + MCP initialize + 一次工具往返之后，
抛出的是明确错误，不是静默不可用。

另一条有用的事实：两个 jar 只有 `BuildInfo` 与 `JadxSession` 两个类字节不同，
`SessionHolder`、`jadx/api/JadxDecompiler`、`gson/Gson`、MCP `Server` 逐字节相同——
所以坏的纯粹是那一条版本断言，不是 ABI 或编译不兼容。**只要 REA 放开这个常量，0.8.0 是安全的。**

## 3. JDK：上游有新版，Windows 没有构建

`adoptium/temurin21-binaries` 的 `jdk-21.0.13+9`（2026-10-22T08:58Z）共 204 个资产，
**没有任何 `windows` 资产**；`temurin25-binaries` 的 `jdk-25.0.5+8`（147 个资产）同样没有。

| manifest 钉的平台 | 21.0.13+9 是否存在 |
|---|---|
| win32-x64 | **缺失**（`OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip` 不存在） |
| darwin-x64 | `OpenJDK21U-jdk_x64_mac_hotspot_21.0.13_9.tar.gz` 193,957,782 B |
| darwin-arm64 | `OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz` 199,754,598 B |
| linux-x64 | `OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz` 207,858,352 B |
| linux-arm64 | `OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.13_9.tar.gz` 205,995,218 B |

顺带：`jdk-25.0.5+8` 连 `x64_mac` 的 JDK 资产都没有，darwin-x64 也跟不了 25.x 线。

所以“把 manifest 的 JDK 钉到 21.0.13”这件事在 win32-x64 上**无法执行**；只改另外 4 个平台会制造
平台间版本分裂，而 Windows（本插件的主平台）仍是旧信任库。

REA 侧对 JDK 没有版本钉子：Ghidra 12.1.4 的 `application.properties` 是 `application.java.min=21`、
`max=`（空=无上限），接受逻辑是 `major >= min && (max 为空 || major <= max)`
（`dist/ghidra/GhidraInstallationPolicy.js:74-76`），所以 21.0.13 与今天的 25.0.5 都能过。
`SUPPORTED_GHIDRA_JAVA_MAJOR = 21` 只是缺属性时的兜底常量，不是“必须等于 21”。

## 4. 风险与缓解

**Ghidra 12.1.4 的四个 CVE（NVD 实测编号与分数）**

| CVE | 分数 | 影响 |
|---|---|---|
| CVE-2026-100504 | 7.3 | 反编译器 `leftshift128` 负移位导致栈越界写，可致代码执行 |
| CVE-2026-100505 | 4.8 | `StringManager::getCodepoint` 多字节解码堆越界读（9.2–12.1.4） |
| CVE-2026-100503 | 4.8 | 反编译器 `Funcdata::opInsertAfter` UAF 拒绝服务 |
| CVE-2026-113604 | 6.8 | ELF 加载器 `ElfHeader` 内存耗尽拒绝服务（10.2–12.1.4） |

缓解只能是流程上的：**不要用这套环境分析来源不可信的样本**；根治要等 REA 放开 12.1.x 这条线。

**CVE-2026-91403（9.1，JSSE，eMudhra 中间 CA）**

Oracle 的 Security Alert 把 `21.0.13` 和 `25.0.5` 都列为受影响版本。实测信任库里的 eMudhra 锚：

| 锚（SHA-256 指纹前缀） | Temurin 21.0.12.1 | Temurin 21.0.13 | Corretto 25.0.5（本机运行） |
|---|---|---|---|
| g1 `40:F6:AF:03…` | 有 | **有** | 有 |
| c1 `12:56:09:AA…` | 有 | 无 | 有 |
| c3 `BC:4D:80:9B…` | 有 | 无 | 有 |
| g3 `86:A1:EC:BA…` | 有 | 无 | 有 |
| g2 `1A:A0:C2:70…` | 无 | 无 | 有 |

即：21.0.12.1 → 21.0.13 会移除 c1/c3/g3，**但保留 g1**；本机运行的 Corretto 25.0.5 反而五张全在。
**没有任何一份已发布版本是“干净”的**，所以“升到 21.0.13 就修掉这个 9.1”不成立。

可用的缓解有两条，都要动信任库，需人工确认：

1. 给 REA 单独指定 truststore（`-Djavax.net.ssl.trustStore=<剔除了 emsign 锚的副本>`），不动系统 JDK——
   `F:\game\xbox` 同时是别的程序（Minecraft）的运行时，直接删证书会波及它们。
2. 等 Adoptium 发布带 Windows 资产、且移除了全新 eMudhra 锚的下一版，再统一升 manifest。

注：插件自身的下载都是 sha256 固定的，伪造证书无法改写字节，只能误导版本探测；这条风险主要落在
“REA/Java 去访问任意 HTTPS 站点”上，而不是供给链路。

**信任库统计陷阱（记录一下，避免再犯）**：只 grep `emudhra` 会漏掉 Corretto 的 `emsignrootca-*` 别名，
把“5 张锚”读成“0 张”。正确做法是 `(?i)emsign|emudhra`，或直接按 SHA-256 指纹比对。

## 5. 本轮实测：工具面全绿

| 检查 | 结果 |
|---|---|
| Ghidra（`C:\Windows\System32\whoami.exe`） | 9 段 / 341 函数 / 308 字符串；`entry` 反编译出 `FUN_1400021b4(); FUN_140001af0();` |
| Ghidra 冷启动 | CLI `rea analyze` 52 s；同进程内后续 `list_segments` 立即返回 |
| apktool | `inspect_apktool_client` → 3.0.3；wrapper 直接跑 `--version` → 3.0.3（280 ms） |
| adb | `inspect_adb_client` → 37.0.1-15733141；`adb version` → 1.0.41 |
| jadx 桥接 | 0.7.1-all.jar 在 JDK 25.0.5 下正常启动（输出 usage） |
| managed（mscorlib.dll） | 20,899 行元数据，MVID 2acc5ce0-… |
| sqlite | 3.53.4，schema + 行读取正常 |
| 仓库门禁 | `audit-manifest` 24/24 hash-pinned clean；单测 85 过 / 3 平台跳过 / 0 失败；`verify-branch.ps1` ALL CHECKS PASSED |

不可用的工具族都是“需要外部工具”的那批，与版本无关：`inspect_with_objdump`（本机无 GNU objdump）、
`inspect_pcap_*`（无 Wireshark/tshark）、`extract_firmware`（无 binwalk/unblob）、`inspect_wasm_artifact`
（无 WABT）、`recover_javascript_sources`（无 Wakaru）、`inspect_binary_layout`（无 pwntools）、
`inspect_evm_interface`、JEB 家族、macOS 专属项。

## 6. 什么时候重开这个决定

1. **Ghidra 12.2**：`rea-agents` 新版本把 `SUPPORTED_GHIDRA_VERSION` 提到 12.2（或新增 12.2 兼容分支）
   → 同步放宽 `check-updates.ps1:228` 的 `^12\.1\.`，改 manifest 的 `ghidra` 源，重跑
   `bundle:audit` + `bundle:test` + `setup --reuse`（含末尾 smoke）。
2. **jadx 0.8.0**：`JadxRelease.js` 的 `version` / `sha256` 变化 → 换 jar、改 manifest 的
   `jadxHeadlessMcp` 与 `probe`、重跑一次真实 APK 分析。
3. **JDK**：Adoptium 发布带 Windows 资产的 21.0.13+（或更新的 LTS 补丁）→ 一次改 5 个平台的
   url/size/sha256，跑 audit + test + `setup --reuse --skip-smoke`，再用 vendor JDK 跑一次 smoke。
4. 任何一项落地时，都保持“先验证再切换”：本机当前的运行组合随时可回退。

## 7. 本轮的已知弱点（未修，留待决定）

- `manifest/bundle.manifest.json:293` 的 jadx probe 只检查 jar 路径存在（`{"file": …}` 没有 `expect`），
  `setup.mjs` 的 `runProbe` 对 file probe 只做 `existsSync`。换一个同名但版本不同的 jar，setup 会静默放行，
  直到第一次 Android 调用才报 `Expected engine 0.7.1`。
- JDK probe 只要求 `java --list-modules` 含 `jdk.compiler`，一个 JDK 11 也能通过（`setup.mjs:1116-1118`
  的注释正描述了这类事故）。Ghidra 的 `application.java.min` 会在运行期兜住，但那时已经装完了。
- `setup.mjs:1147-1155` 的“已供给”分支只跑组件 probe，不比对落盘文件哈希，所以装在机器上的
  `vendor/apktool/apktool.bat` 一度是旧 master 副本（2,348 B / `9440ec9d…`）而 manifest 钉的是 tag 副本
  （2,386 B / `d81a91bd…`）。本轮已把该文件对齐到钉子（备份 `apktool.bat.bak-2348`），两者行为实测一致。

## 8. 本轮没有做的事

- 没有移动任何 pin（`manifest`/`package.json` 未改）。
- 没有提交、没有推送；工作树保持干净（本文件与 README 的说明除外）。
- 没有重启 dsh / REA：运行中的 MCP 进程与 Ghidra 会话不受影响。

## 附：外部评审文档的核对结果

| 说法 | 判定 |
|---|---|
| Ghidra 12.2 被 REA 的 12.1.x 硬线挡住 | ✅ |
| 不存在 12.1.5 | ✅（Ghidra release 列表里 12.1.4 之后直接是 12.2） |
| jadx 0.8.0“不会被硬拒绝”“大概率能用”“失败是静默的” | ❌ 硬拒绝、明确报错，见 §2 |
| 升 JDK 21.0.13 能修掉 CVE-2026-91403 | ❌ 只移除 4 张锚里的 3 张，g1 仍在；Oracle 把 21.0.13 列为受影响 |
| 改 manifest 的六个平台条目即可升 JDK | ❌ 只有 5 个平台条目；win32-x64 无资产 |
| `SUPPORTED_GHIDRA_JAVA_MAJOR = 21` 意味着“只接受主版本 21” | ❌ 实际是 `>= application.java.min`（25.0.5 今天就被接受） |
| apktool 3.0.3 已是上游最新、哈希与官方一致 | ✅ |
| platform-tools 无钉子、始终取最新 | ⚠️ URL 是滚动的，但 manifest 钉了当前字节的 sha256（今日仍一致） |
| jadx 0.7.1 受 CVE-2022-39259 / CVE-2024-32653 影响 | ❌ 类目错误：0.7.1 是 jadx-headless-mcp 的版本号，不是 jadx-core 的 |
