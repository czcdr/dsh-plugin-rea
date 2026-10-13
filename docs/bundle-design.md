# one-plugin bundle — design notes

Goal: a fresh machine installs **one DSH plugin** and gets a working `mcp__rea__*`
tool surface, without first installing Node, REA, a JDK, or Ghidra by hand.

`main` keeps the original **config-only adapter** (a single MCP row pointing at a
`rea` the user installed themselves). This branch adds the self-provisioning
variant next to it. Nothing on `main` changes.

---

## 1. What upstream will and will not do

REA is explicit: it never installs or upgrades unrelated software, and every
dependency is "caller-supplied" (`SKILL.md`, `install.sh`, and the remediation
strings in `dist/`). That is a deliberate upstream boundary, not an oversight.
Consequently **all provisioning must live on our side**, and it must not pretend
to be REA.

Two upstream rules shape the runtime wiring:

- Only `GHIDRA_INSTALL_DIR` + `JAVA_HOME` (and `REA_IDA_MCP_CONFIG`,
  `HOPPER_LAUNCHER_PATH`) are ever published by `rea setup`. Every other knob —
  `REA_ADB_PATH`, `REA_APKTOOL_COMMAND`, `REA_JADX_MCP_JAR`,
  `REA_BROWSER_EXECUTABLE`, `REA_ILSPY_CMD_PATH` — must be supplied by the
  launching environment. We supply them per machine from one JSON file.
- REA hard-requires an **absolute** Node/runtime path in practice: it rejects
  relative paths for `GHIDRA_INSTALL_DIR` and resolves Windows `java.exe` by
  walking PATH itself. We therefore never rely on PATH at all.

## 2. Verified facts this design rests on

Measured on Windows 11 x64, REA 6.4.0, Ghidra 12.1.4, Temurin JDK 25.0.4:

| Fact | Evidence |
| --- | --- |
| A row can launch REA with **no PATH `rea`** | `node <pkg>/scripts/rea.mjs mcp` answered the MCP `initialize` handshake (`serverInfo.name = rea`, version 6.4.0) and `rea doctor --json` reported 170 tools, `healthy: true` |
| `!!js` expressions are supported in this profile layer | the existing profile patch already used one; the loader evaluates them |
| A row-level `env:` block reaches the MCP child | `binary_session` reported `registrationEnvironment` = `GHIDRA_INSTALL_DIR`, `JAVA_HOME` |
| No fixed home/layout is promised | the disk layout differs per install; nothing may assume one |
| Windows is an explicit POC boundary upstream | `DoctorDiagnostics`: "the experimental Windows x64 Ghidra P0 boundary" |

## 3. Architecture

Three responsibilities, kept strictly apart:

1. **Shim (runtime, per launch).** A tiny Node script the MCP row points at. It
   loads the machine-local `bundle.json`, exports the discovered paths into the
   child environment, and execs REA. It never downloads anything on the normal
   path and never writes to the plugin directory.
2. **Setup (provisioning, explicit or first-run).** A Node script that resolves
   the component manifest, downloads what is missing into a cache, verifies
   checksums, unpacks, runs the readiness probe, and writes `bundle.json`.
   Idempotent and re-runnable; `--reuse` adopts pre-existing installs.
3. **Patch (wiring, published).** `cordis.patch.yml` from this branch, carrying
   **no machine path**: the row points at `<plugin>/bin/rea-shim.mjs` and the
   shim is responsible for the rest.

The published plugin therefore stays portable, while the machine-specific truth
lives in one small JSON file under the DSH home.

```
<dsh home>/plugins/rea-bundle/
  bundle.json          # machine-local truth: resolved paths + versions + hashes
  cache/               # downloaded archives (resumable, checksum-verified)
  vendor/              # unpacked payloads (node, jdk, ghidra, apktool, jadx, adb)
  logs/setup.log
```

## 4. Why a shim instead of an `!!js` expression

`!!js` can inject values into the row at load time, but it cannot:
download, verify, unpack, run a readiness probe, or report progress. It also
couples the published patch to expressions that must parse on every platform.
A shim is boring, testable, and can report an action's clear remediation text
through `failOnStartupError: false` without breaking the harness.

## 5. Control flow

```
dsh starts
  └─ MCP row: node <plugin>/bin/rea-shim.mjs
       ├─ bundle.json present & components verify  → exec REA (normal path)
       ├─ missing, auto-provision allowed         → start setup detached, print
       │                                            remediation, exit non-zero
       └─ missing, auto-provision refused         → print exact command, exit
```

`setup` stages, each idempotent and individually verifiable:

1. `detect`  — host platform/arch, DSH home, plugin dir, existing installs
2. `resolve` — manifest entry per component; candidate URLs are ordered
3. `fetch`   — download to cache with resume + retries; skip if checksum matches
4. `verify`  — sha256 against the manifest (and vendor checksum file when present)
5. `unpack`  — platform-native extraction, atomic into `vendor/`
6. `wire`    — write `bundle.json`, export the environment variables REA reads
7. `probe`   — run `rea doctor --json` and one real analysis smoke test
8. `report`  — human summary + exit code; every failure names its remediation

## 6. What is genuinely impossible on Windows

Declared up front so no release note over-promises. These are **upstream
host gates**, not configuration gaps:

| Capability | Gate |
| --- | --- |
| Hopper provider | macOS only |
| IDA provider | requires a user-owned IDA + `REA_IDA_MCP_CONFIG`; REA never launches it |
| firmware `binwalk` / `unblob` | Linux only |
| Wakaru JS recovery | Linux x64 only |
| pwntools paths (ELF layout, recorded crash) | Linux x64 only |
| pwndbg / gdb core context | Linux/macOS |
| `mitmdump` native capture decode | Linux only (HAR needs no engine) |
| Apple toolchain (Mach-O, plist, asset catalog, LLDB) | macOS only |
| process capture (`capture_process_scenario`) | Linux/macOS PTY |

Everything else — native Ghidra analysis, static JS/Electron, .NET, archives,
Android (JADX/apktool/adb), browser scenarios, EVM, HAR — is reachable on
Windows and is what this bundle targets to complete.

## 7. Component matrix (Windows x64 first)

| Component | Needed for | Provisioned as |
| --- | --- | --- |
| Node runtime | running REA at all | reuse a compatible existing node, else portable `node.exe` |
| `rea-agents` | the MCP server itself | vendored copy under `vendor/rea-agents` |
| Temurin JDK 21/25 | Ghidra headless + JADX bridge | portable JDK zip (full JDK, not a JRE) |
| Ghidra 12.1.x | native analysis | official release zip, extracted |
| apktool | Android resource decode | `apktool.bat` + jar in one directory |
| jadx-headless-mcp jar | Android class/method decompile | pinned 0.7.1 jar (REA validates its classes) |
| Android platform-tools | `adb` device tools | official zip |
| a Chromium-family browser | browser/CDP scenarios | reuse an installed Edge/Chrome; never downloaded |
| `ilspycmd` (optional) | .NET decompilation | optional; only wired when present |

Ghidra itself is **not** redistributed inside the plugin package: the release is
~570 MB, which no npm package can carry. It is fetched from the official release
and checksum-verified, or adopted from an existing install with `--reuse`.

## 8. Honest limits of this branch

- npm's per-package limits (unpacked/compressed size) rule out shipping the JDK
  and Ghidra inside the tarball. "One plugin install" therefore means *one
  install plus an automatic, checksum-verified fetch*, not a 600 MB npm package.
- First run is network- and time-bound: the full payload is roughly 800 MB
  (Ghidra 570 MB, JDK 205 MB) plus the REA package. Progress is reported and the
  download is resumable; a pre-seeded cache makes it offline-capable.
- Version pins age. `manifest/bundle.manifest.json` carries the pins, and
  `check-updates.ps1` gains a bundle section so drift is reported rather than
  discovered later.
