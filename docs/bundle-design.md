# one-plugin bundle — design notes

Goal: a fresh machine installs **one DSH plugin** and gets a working `mcp__rea__*`
tool surface, without first installing Node, REA, a JDK, or Ghidra by hand.

`main` **is** this variant: the self-provisioning one-plugin bundle. The earlier
**config-only adapter** (a single MCP row pointing at a `rea` the user installed
themselves) is preserved on the [`v1` branch](https://github.com/czcdr/dsh-plugin-rea/tree/v1)
and on npm as `dsh-plugin-rea@1.0.6`; nothing here changes that line.

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

Measured on Windows 11 x64, REA 6.7.0, Ghidra 12.1.4, Temurin JDK 25.0.4:

| Fact | Evidence |
| --- | --- |
| A row can launch REA with **no PATH `rea`** | `node <pkg>/scripts/rea.mjs mcp` answered the MCP `initialize` handshake (`serverInfo.name = rea`, version 6.7.0) and `rea doctor --json` reported 207 tools. `healthy` is `false` on a bundle-only install: 6.7.0 also checks the host's own setup (Hopper, IDA registration, Kuna, `rea setup` skill/registrations), which provisioning deliberately never touches — the row does not require `healthy`, only a CLI that runs and a catalog it can read |
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
3. **Patch (wiring, published).** `cordis.patch.yml` on `main`, carrying
   **no machine path**: the row computes `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`
   at load time from `DSH_HOME` alone, and that mirrored shim is responsible for the
   rest. (The checkout's own copy is what a human runs; the row never points at it.)

The published plugin therefore stays portable, while the machine-specific truth
lives in one small JSON file under the DSH home.

```
<dsh home>/plugins/rea-bundle/
  bundle.json          # machine-local truth: resolved paths + versions + hashes
  mirror.json          # which plugin checkout the mirrored files came from
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
  └─ MCP row: node <bundle root>/bin/rea-shim.mjs   (setup mirrors it there)
       ├─ mirrored copy differs from the installed plugin → re-exec that copy, once
       ├─ a working `rea` on PATH is at least as new as the bundle
       │                                            → exec it (the 1.x contract)
       ├─ bundle.json present & components verify  → exec the provisioned REA
       ├─ missing, auto-provision allowed         → start setup detached, print
       │                                            remediation, exit non-zero
       └─ missing, auto-provision refused         → print exact command, exit
```

The shim resolves its bundle root from **its own location**, not from `DSH_HOME`:
the harness strips every `DSH_*` name from an MCP child's environment, so with a
custom `DSH_HOME` the shim would look in `~/.dsh`, find nothing, and start a second
provisioning run there.

`setup` stages, each idempotent and individually verifiable:

1. `detect`  — host platform/arch, DSH home, plugin dir, existing installs
2. `resolve` — manifest entry per component; candidate URLs are ordered
3. `fetch`   — download to cache with resume + retries; skip if checksum matches
4. `verify`  — sha256 against the manifest (and vendor checksum file when present)
5. `unpack`  — platform-native extraction, atomic into `vendor/`
6. `wire`    — write `bundle.json`, export the environment variables REA reads
7. `mirror`  — copy the launcher to the path the published patch computes
8. `probe`   — `rea doctor --json`, then launch the **mirrored** shim exactly as the row would
9. `report`  — human summary + exit code; every failure names its remediation

Two notes on stages that exist because their absence was a bug:

- **7 (mirror).** The patch points at `<bundle root>/bin/rea-shim.mjs`, and the
  plugin itself is not guaranteed to live anywhere the patch can compute. Setup
  therefore copies the launcher (and the setup script it re-invokes) into the
  bundle root. Without this, provisioning could succeed and the row would still
  fail — and the "install the plugin first, it provisions itself" path could
  never start, because the shim that does the provisioning would not exist at
  the path being launched. The copy list is exactly what a mirrored run reads
  back, **including `manifest/bundle.manifest.json`**: a mirrored `setup.mjs`
  resolves its plugin root to the bundle root, so `loadManifest()` reads
  `<bundle>/manifest/bundle.manifest.json` — a file only this stage can create.
  It also writes `<bundle>/mirror.json`, naming the checkout the files came
  from: the bundle outlives any particular checkout location, and without that
  record a later mirrored run can only copy the bundle onto itself (provisioning
  the manifest it was mirrored with, forever) and its remediation text would
  point the operator at a copy that cannot start.
- **The row's `!!js` scalar is quoted.** A bare scalar containing `? ` and `: `
  is not one scalar: YAML reads it as an explicit key/value pair, so the loader
  receives a mapping where an expression belongs — measured against the
  harness's own dialect, `args[0]` became `{"[object Object]": "..."}` and the
  row could not launch at all. Any future expression with a ternary needs the
  quotes; `audit-manifest.mjs` rejects the bare form.
- **Launch mode (2.0.7).** 2.x exists to supply a runtime a machine lacks, so a
  machine that already has one should not be provisioned. Before touching bundle
  state the shim asks whether `rea` is on PATH and answers `--version`; if it
  does, and its version is not older than `bundle.json`'s `versions.reaAgents`,
  the row execs that install exactly as the 1.x row did. The probe is asynchronous
  and bounded (8 s: a `.cmd` shim needs ~2.4 s), runs with
  `REA_BUNDLE_DELEGATED=1` and `REA_BUNDLE_AUTO_PROVISION=0` so a candidate that
  wraps this shim cannot recurse or start an 800 MB run, and kills its whole tree
  on timeout. `REA_BUNDLE_LAUNCH=auto|system|bundle` overrides the choice; an
  unorderable pair (a prerelease on either side) keeps the bundle.
- **Self-healing mirror (2.0.8).** The row launches a COPY, and a market upgrade
  runs no setup, so without this the copy keeps executing the code it was made
  from — invisibly, because it still works. The copy therefore compares its own
  hash with `<mirror.json.pluginRoot>/bin/rea-shim.mjs` and re-execs that file
  when they differ: one hop, guarded by `REA_BUNDLE_SHIM_REEXEC`, and only from a
  mirror (a checkout ships `cordis.patch.yml`, so it never hops into another
  copy). `mirror.json` carries `shimSha256`, `pluginVersion` and `dshHome` —
  the last one because the harness strips `DSH_*` from an MCP child, so the
  duplicate-registration check would otherwise read `~/.dsh` on a machine with a
  custom home. `--shim-status` reports `mirror.stale` instead of hopping.
- **3 (fetch).** Route order is deliberate and environment-dependent: direct
  first, then the system proxy, and on Windows the .NET route ahead of both
  because it follows the GitHub release-asset redirect that the Node routes
  cannot. Neither "always direct" nor "always proxy" is correct — measured on
  the development machine, the local proxy answers github.com but returns 403
  for nodejs.org and 404 for dl.google.com, while the reverse also happens.

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
| `rea-agents` | the MCP server itself | vendored copy under `vendor/node_modules/rea-agents` |
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

## 8. Honest limits of this approach

- npm's per-package limits (unpacked/compressed size) rule out shipping the JDK
  and Ghidra inside the tarball. "One plugin install" therefore means *one
  install plus an automatic, checksum-verified fetch*, not a 600 MB npm package.
- First run is network- and time-bound: the full payload is roughly 800 MB
  (Ghidra 570 MB, JDK 205 MB) plus the REA package. Progress is reported and the
  download is resumable; a pre-seeded cache makes it offline-capable.
- Version pins age. `manifest/bundle.manifest.json` carries the pins, and
  `check-updates.ps1` gains a bundle section so drift is reported rather than
  discovered later.
