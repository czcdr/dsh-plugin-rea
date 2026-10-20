# dsh-plugin-rea

[![npm version](https://img.shields.io/npm/v/dsh-plugin-rea?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-rea)

**English** · [简体中文](README.zh-CN.md)

> **Which version is this? 2.x — and `main` is it.** 2.x provisions the runtime itself (Node, the REA CLI, a
> JDK, Ghidra) and then wires the row: install the plugin, run `scripts/setup.mjs` once, restart dsh.
> **1.x** is the older configuration-only adapter — it expects `rea` on PATH and Ghidra installed by you —
> kept on the [`v1` branch](https://github.com/czcdr/dsh-plugin-rea/tree/v1) and on npm as `dsh-plugin-rea@1.0.6`.
> Full comparison: [Two lines: 1.x and 2.x](#two-lines-1x-and-2x) · upgrading: [Upgrading from 1.x](#upgrading-from-1x).

> **You must run `node scripts/setup.mjs` yourself — once after installing, and once after every plugin
> upgrade.** Nothing runs it for you: a market install or update replaces the package and stops there.
> Since **2.0.8** a market upgrade keeps the *row* working (the mirrored launcher re-execs the new one), but it
> does **not** move the bundle to the new pins — REA and the engines stay at the versions recorded by the last
> setup run. Skip it on a first install and the row exits `MODULE_NOT_FOUND` with no tools and no message;
> skip it after an upgrade and you keep running the old REA silently (`check-updates.ps1` reports the drift).
> The full rule set is under [Updating](#updating--three-independent-things).

Brings the upstream **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** MCP server into
**DeepSeek Harness** (dsh), so its tools show up in a session as `mcp__rea__*`.

![dsh-plugin-rea: the session calls the official MCP client row, which launches the bundle's shim; the shim starts the provisioned REA and the Evidence comes back](assets/screenshot-1.png)

## What this is

A **Cordis bundle with a provisioning layer**. `package.json` declares `dsh.bundle.patch`, and that patch
inserts one row of the official MCP client plugin (`@deepseek-ai/dsh-mcp-client`). The row launches
`bin/rea-shim.mjs` with the running Node executable; the shim reads the machine-local state that
`scripts/setup.mjs` wrote and starts the REA CLI it provisioned. There is no analysis code here, and the
published patch contains no machine path.

> **Third-party adapter.** This repository is not part of REA, ships none of REA's code, and is not
> maintained by REA's authors. It composes one configuration row and fetches upstream's own releases.
> Upstream: [github.com/morluto/rea](https://github.com/morluto/rea) (MIT) ·
> [docs](https://github.com/morluto/rea#what-you-can-analyze) ·
> [rea.tools](https://rea.tools/) · npm package `rea-agents`.
> REA's own problems go to its tracker; **this plugin's** problems go to
> [this repository's issues](https://github.com/czcdr/dsh-plugin-rea/issues).

**It adds exactly three things:** the tool registration under the `mcp__rea__*` names, the per-machine
engine environment (`GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `REA_ADB_PATH`, `REA_APKTOOL_COMMAND`,
`REA_JADX_MCP_JAR`, `REA_BROWSER_EXECUTABLE`, …) scoped to that MCP child instead of the whole harness, and
the provisioning that puts those components on disk.

## What it can and cannot do

The analysis is upstream's; this section only restates upstream's own contract so expectations are right.

- **It cannot recover complete source code.** For native binaries upstream returns *pseudocode and
  assembly*, for Android APKs *decompiled methods*, for JEB units *pseudocode*, and for JavaScript/Electron
  *modules and their relations*. Upstream's tool contract states the pseudocode "is decompiler output, not
  original source and not text-equivalent" to another provider's output.
- Not recoverable in practice: original identifier names, types, comments, macros and template expansion,
  build scripts and assets. Optimisation (inlining, reordering), symbol stripping, obfuscation, packing and
  VM protection only make the output worse.
- Every result carries **confidence and limitations** (`observed` / `derived` / `inferred`, plus an explicit
  limitations list). Read them as evidence, never as recovered source.
- Good for: understanding behaviour, locating an implementation, interoperability and compatible
  re-implementation, security review, migration reference. To obtain actual source code, use the legitimate
  route — the upstream repository, vendor authorisation, or the vendor's own SDK.

**What provisioning cannot buy you.** These are upstream host gates, not settings this plugin forgot:

| Capability | Gate |
|---|---|
| Hopper provider | macOS only |
| IDA provider | needs your own IDA and `REA_IDA_MCP_CONFIG`; REA never launches IDA |
| firmware `binwalk` / `unblob` | Linux only |
| Wakaru JS recovery, pwntools ELF/recorded-crash paths | Linux x64 only |
| pwndbg / gdb core context | Linux, macOS |
| native mitmproxy captures | Linux (`REA_MITMDUMP_COMMAND`); HAR needs no engine |
| Apple toolchain (Mach-O, plist, asset catalog, LLDB) | macOS only |
| `capture_process_scenario` | Linux/macOS PTY |
| apktool (Android resource decoding) | available only when `REA_APKTOOL_COMMAND` points at something Node can **execute directly**: upstream `execFile`s that command without a shell, and Windows cannot execute a `.bat`/`.cmd` that way (EINVAL). This bundle wires the official `apktool.bat` as upstream documents, so on Windows the launcher reports no version and the capability stays unavailable; JADX (a jar) is unaffected |

## Two lines: 1.x and 2.x

| | **2.x** — this line, `main` | **1.x** — [`v1`](https://github.com/czcdr/dsh-plugin-rea/tree/v1) |
|---|---|---|
| What it is | the adapter **plus provisioning**: it prepares Node, the REA CLI, a JDK and Ghidra, then wires the row | configuration-only adapter: one MCP row pointing at a `rea` you installed yourself |
| What you need first | nothing for the runtime — provisioning fetches what is missing (with `--reuse` it adopts an existing Ghidra/JDK instead) | Node.js on REA's engines, `npm i -g rea-agents`, and Ghidra 12.1.x for native analysis |
| First run | run `scripts/setup.mjs` (or the bootstrap) once, then restart dsh | nothing to run |
| The row launches | the running Node executable plus `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`, which reads that machine's state | `cmd.exe /c rea mcp` on Windows, `rea mcp` on macOS/Linux |
| Machine state | `<DSH_HOME>/plugins/rea-bundle/` — `bundle.json`, `vendor/`, `cache/` | your own REA and Ghidra installs |
| Install | `dsh plugin --profile <profile> add dsh-plugin-rea` (npm `latest` ≥ 2.0.0) | `… add dsh-plugin-rea@1.0.6`, or `github:czcdr/dsh-plugin-rea#v1.0.6` |

Both lines ship the **same patch shape** — one `insert` row of `@deepseek-ai/dsh-mcp-client` — and offer the
same `mcp__rea__*` surface; they differ in who prepares the runtime. Moving from 1.x to 2.x takes two
commands: see [Upgrading from 1.x](#upgrading-from-1x).

Upstream also registers itself with dsh now (`rea setup --client dsh`); that route is essentially the
1.x model maintained upstream — configuration only, your own Node/REA/Ghidra. This bundle is the
zero-dependency route. Pick one of the three, and never keep two `serverName: rea` rows at once.

## Install

**Nothing to install first.** On a bare Windows x64 machine:

```
powershell -ExecutionPolicy Bypass -File scripts\rea-bundle-bootstrap.ps1 -Reuse
```

`-Reuse` adopts a Ghidra/JDK you already have; omit it to download both (about 775 MB from the official
releases, checksum-verified). Then install the plugin for your profile:

```
dsh plugin --profile <profile> add dsh-plugin-rea
# or pin this release instead of tracking npm latest:
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea#v2.0.11
```

> **On an Electron host (the DeepSeek Harness desktop app) the profile is owned by the application.**
> `dsh plugin --profile desktop …` is refused by the CLI (`profile "desktop" is managed exclusively by
> the Electron application`) — install or update through the in-app plugin manager instead. The CLI form
> above is for a profile you created yourself with the CLI under another name.

If Node is already installed, you can skip the bootstrap and run provisioning directly:

```
node scripts/setup.mjs --reuse      # or --dry-run to see the plan first
```

Node, when you provide it instead of letting setup fetch one, must satisfy REA's engines —
`^22.19.0 || ^24.11.0 || >=26.0.0` (check with `node -v`). A lower Node does not fail at install
time; the MCP row fails later, which reads as silence.

Installing the plugin **first** also works, but it takes two steps. The row resolves to
`<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`, and that file is created by setup — so until the first
provisioning run the row exits with `MODULE_NOT_FOUND`, and nothing is there to start a background
provisioning (the harness itself is unaffected: `failOnStartupError: false` is deliberate). Run
`node scripts/setup.mjs` once; from then on the shim is in place, and every later missing state is picked up
by the shim itself, which provisions in the background.

### Which DSH versions

`package.json` declares `engines.dsh: ">=0.1.7-rc.2 <0.3.0-0"`, and that declaration is the answer the plugin market
reads: with it the card says **compatible**; without it the market can only say *unknown*. The range is not a guess —
it is the dsh release list this plugin is checked against, and `node scripts/host-compat.mjs` fails the build when the
two disagree:

| Host | Covered |
|---|---|
| `0.1.7-rc.2` … `0.2.1-rc.2` — every release in between, alpha and rc | yes |
| `0.3.0` and later | no — a new minor line is a host nobody updated this row for yet |

What was actually compared across that range is the row provider: `packages/mcp/mcp-client` at `dsh-v0.1.7-rc.2` and at
`dsh-v0.2.1-rc.2` exposes the same config surface the shipped row uses (`serverName`, `transport`, `command`, `args`,
`env`, `failOnStartupError`), and `dsh.bundle.patch` exists at both tags. A host outside the range can still work; it is
simply not claimed.

### A REA you already have is used as-is

2.x exists to supply what a machine is missing. If REA is already installed — `rea` on PATH, the 1.x setup — the row
runs **that**, exactly as the 1.x line did, and nothing is provisioned:

| What the machine has | What the row runs |
|---|---|
| `rea` on PATH, at least as new as the provisioned build | your REA (`rea mcp`), with your Node and your PATH |
| `rea` on PATH but older than the provisioned build | the provisioned bundle — a stale global CLI would take the tool count backwards (6.4.0 ships 170 tools, 6.7.0 ships 207) |
| no `rea` on PATH | the provisioned bundle, provisioning itself on first use |

- `REA_BUNDLE_LAUNCH=auto|system|bundle` overrides the decision (`auto` is the default); `REA_BUNDLE_SYSTEM_REA=<path>`
  names a binary that is not on PATH.
- The probe is the CLI's own `--version`, bounded at 8 s: a `.cmd` shim on Windows takes ~2.4 s to answer, so the check
  runs once per start and only when a `rea` actually exists.
- `--shim-status` prints the decision — `launch.mode`, `launch.reason`, `launch.systemRea` — and its `launch.rejected`
  list says why a candidate was skipped (`"exit 7"`, `"inside the bundle"`, `"timeout"`).
- A delegated child carries `REA_BUNDLE_DELEGATED=1`, so a wrapper that calls this shim cannot make it delegate to
  itself forever.
- **On Windows a forced kill of the shim does not reap the delegated REA.** There is no job object here: Task Manager
  or a supervisor terminating the shim leaves your `rea` running with the row's pipes (a console Ctrl+C reaches the
  whole process group and does stop it). On POSIX the child is in the same group and dies with the terminal.

## Configure — nothing

The shipped row carries **no machine path**:

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

Three details in that row are load-bearing, and all three were bugs first:

- **The `!!js` scalar is quoted.** A bare scalar containing `? ` and `: ` is not one scalar: YAML reads it as an explicit key/value pair, so the loader receives a *mapping* where an expression belongs. Measured against the harness's own dialect (`JSON_SCHEMA` plus the `!!js` type from `app.asar`), the unquoted form made `args[0]` into `{"[object Object]": "..."}` — an object the row cannot launch with. Quoting removes the ambiguity, and the JS string literals inside then use single quotes.
- **Forward slashes, never backslashes.** A single-quoted YAML scalar keeps `\` literal, and JavaScript then consumes it: `'\plugins'` is not a path but the BEL control character, `'\rea-bundle'` becomes a carriage return and `'\bin'` a backspace — the path is destroyed silently. Forward slashes work on Windows and on POSIX.
- **The `DSH_HOME` fallback is `<home>/.dsh`, not `<home>`.** The shim, `setup.mjs` and `bootstrap.ps1` all resolve an unset `DSH_HOME` to `<home>/.dsh/...`; a fallback that stopped one level higher made the row point at a file provisioning never writes — invisible on any machine where `DSH_HOME` happens to be set.
- **No `path`/`require` in a `!!js` expression**: `ctx` is the loader scope, so the DSH_HOME fallback is written as plain concatenation.

`npm run bundle:audit` enforces the first three: it evaluates this exact expression with `DSH_HOME` unset, empty and set, and rejects a bare scalar that YAML would read as a mapping.

`ELECTRON_RUN_AS_NODE` only matters if the harness itself runs on Electron; it is harmless for a plain Node host, and stating it explicitly beats relying on it surviving the child-env scrub.

`command` is the running Node executable and `args[0]` is computed from `DSH_HOME`, so the same patch works
on Windows, macOS and Linux without a PATH entry. Everything machine-specific lives in
`<DSH_HOME>/plugins/rea-bundle/bundle.json`, written by setup and readable with:

```
node bin/rea-shim.mjs --shim-status      # resolved paths, versions, verification state
node bin/rea-shim.mjs --shim-print-env   # the environment the MCP child will see
```

Both commands answer with the same bundle whether you run them from the plugin directory (the checkout copy)
or from `<DSH_HOME>/plugins/rea-bundle` (the mirrored copy): the checkout resolves the location by the same
rule setup uses, while the mirror uses its own position — it cannot rely on `DSH_HOME`, which the harness
strips from an MCP child's environment.

Setting `REA_BUNDLE_AUTO_PROVISION=0` disables the first-run background provisioning.

To pin a different launch command on this machine (for example your own globally installed `rea`), override
the row from the profile's own `cordis.patch.yml` — that file is machine-local and never published. Only one
row may use `serverName: rea` in a profile.

A patch replaces the row's `config` **wholesale** — it does not deep-merge — so a partial override such as
`config: {env: {...}}` also deletes `command`, `args` and `serverName`, and the row stops starting. Supply the
complete config, or use `REA_BUNDLE_LAUNCH=system` (above), which needs no patch at all.

Ghidra and the JDK are not read from your environment at launch: `setup.mjs` records their absolute paths in
`bundle.json` and the shim exports `GHIDRA_INSTALL_DIR` / `JAVA_HOME` from that record — which is why a
non-standard install location works without touching the row. To adopt an existing install, point
`GHIDRA_INSTALL_DIR` / `JAVA_HOME` at it and run `node scripts/setup.mjs --reuse`: the manifest's probe checks
the candidate and falls back to a download when it does not match, so a wrong path is reported during setup
instead of failing later inside a tool call.

### One REA registration only

Upstream REA 6.5.0 can register itself with DSH:

```
rea setup --client dsh
```

That writes a row with `id: rea-mcp` and `serverName: rea` into `<DSH_HOME>/cordis.patch.yml`. This
bundle's row is `id: mcp-rea` with the same `serverName`, and DSH rejects the later of two entries
that share a server name — so which REA row survives depends on load order. **Use one, not both.**

Which one? Upstream's is the configuration-only route: it expects Node on REA's engines,
`rea-agents` reachable, and a Ghidra/JDK you provisioned yourself. This bundle is the
zero-dependency route: it fetches Node, REA, JDK and Ghidra on first run. The patch shape and the
`mcp__rea__*` surface are the same either way.

The shim reports the conflict on startup — `setup.mjs` records the DSH home it ran under in
`mirror.json`, and the mirrored copy reads that when the harness has stripped `DSH_*` from its
environment; `node bin/rea-shim.mjs --shim-status` lists it under `duplicateRegistration`.

## Verify

Ask for a `mcp__rea__*` call — `binary_session` reports the engine checks
(`configuration` / `installation` / `headless` / `native_decompiler` / `java`), all of which should be
`ok: true`. Then `open_binary` a PE, `binary_overview`, and `procedure_pseudo_code`.

Provisioning itself ends with two probes: `rea doctor --json` (reported, with unmet checks named) and the
exact shim launch the MCP row will use.

## Verified against

Author's machine, 2026-10-13 / 14 / 16 / 19:

| Component | Version |
|---|---|
| REA (`rea-agents`) | **6.7.0** (207 tools) |
| DeepSeek Harness | desktop runtime **0.2.0-rc.2**, with its bundled dsh CLI 0.1.7-rc.2 |
| `@deepseek-ai/dsh-mcp-client` (row provider) | bundled by the harness |
| Ghidra | 12.1.4 |
| JDK | Temurin 21 (provisioned) / Microsoft OpenJDK 25.0.4 (adopted) |
| Node.js | 24.21.0 (REA engines: `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`) |
| Host | Windows 11 x64 (build 26200) |

Exercised live: a clean `setup.mjs --reuse` run reached `setup complete`; an MCP `initialize` handshake
**through the shim with no `rea` on PATH** answered `serverInfo {name: rea, version: 6.7.0}`; and the whole
chain ran under the real desktop host — its own Electron binary launched
`<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs mcp`, the shim started the **vendored** REA, and a live tool
call reported `path_source: environment` for a path only that machine's `bundle.json` knows.

Not exercised end to end here, and therefore not claimed: the ~775 MB JDK + Ghidra download branch (planned
by `--dry-run`, but this machine adopted its existing installs with `--reuse`), and first runs on
macOS/Linux.

## Scope and caveats

- REA exposes 207 tools at 6.7.0, so every session's tool list grows.
- Provisioning is honest about checksums: where a vendor publishes one it is pinned and verified; where none
  exists (jadx-headless-mcp, the apktool wrapper, Android platform-tools, the rolling "latest" URLs) the
  hash is **measured once and recorded**, and later drift is reported rather than silently accepted.
  `bundle.json` lists which components are in that state under `unverifiedChecksums`.
- Downloads are slow on some networks (measured 0.35–0.54 MiB/s from the GitHub release CDN here, so Ghidra
  alone takes ~25–45 min). Fetching is resumable on both routes: a partial `.part` is continued with a Range
  request, and a `.part` that already holds the whole file is verified and kept instead of re-fetched.
- Some REA tools launch processes, write files and access the network — DSH's permission policy applies.
  Analyse only artifacts you are authorized to inspect.
- The MCP child and the engines it launches are ordinary processes running as **you**. DSH's tool
  approvals govern what the model asks for, not what that child may read, write or send on its own;
  treat the plugin like any third-party code you install.
- On Linux, upstream's process-ownership checks need a **procps-compatible `ps`** on PATH; the
  Ghidra/JADX and firmware paths use it. A minimal image without it fails those tools, not the install.
- `scripts/setup.mjs` runs `npm install` for the REA CLI with `--ignore-scripts`: the published tarball
  carries no `node_modules`, so a dependency closure must be resolved, and package lifecycle scripts are
  skipped on purpose during provisioning. That step is also the **only** one that cannot use this bundle's
  own route/proxy resolution — npm reads `HTTPS_PROXY`/`HTTP_PROXY` and `NPM_CONFIG_REGISTRY` from the
  environment, so on a network that needs a mirror, set one of those before provisioning
  (`NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`). With `--offline` the step is refused outright
  instead of quietly going online.
- On POSIX, extraction falls back when the usual tools are missing: a zip is opened with `unzip`, then
  `python3 -m zipfile`, then the provisioned JDK's `jar`; a tarball with `tar`, then `python3`. A minimal
  image that has none of them fails with an explicit "no zip extractor available" line rather than a bare
  "extraction failed". This matters because Ghidra is a zip on every platform and `unzip` is not installed
  everywhere by default.

## Updating — three independent things

> **Two standing rules — for this release and for every later 2.x release.**
>
> `setup.mjs` reconciles the **bundle**, never the **plugin**: it reads the manifest of the plugin that is
> installed *right now*. Installed 2.0.9? setup provisions 6.5.0 even after a newer release exists. The package changes
> only through the market (or `npm i -g dsh-plugin-rea@<version>` / a `file:` reinstall); running setup more
> often never substitutes for that.
>
> **And nothing runs it for you.** A market install or update replaces the package and stops; the first
> `setup.mjs` — and one after every upgrade — is yours to run, from the plugin directory.
>
> 1. **The row executes a copy of this plugin's launcher.** `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs` is a
>    mirror made by setup, and a market upgrade replaces the package without replacing it — so the mirror can keep
>    running old code with **no symptom at all**. Since **2.0.8** the mirror compares itself with the launcher
>    recorded in `mirror.json` and re-execs the plugin's copy when the two differ (one hop, guarded by
>    `REA_BUNDLE_SHIM_REEXEC`). A mirror **older than 2.0.8 cannot do this**, so upgrading from **2.0.0–2.0.7**
>    still needs one `node scripts/setup.mjs`. `--shim-status` reports `mirror.stale`; `check-updates.ps1` says
>    when to re-run.
> 2. **The mirrored `scripts/setup.mjs` is a copy too, and it has no self-heal of its own.** Running setup from the
>    bundle root therefore executes the version from when the bundle was created, not the one you just installed.
>    Run it once **from the plugin directory** to refresh that copy. Since **2.0.9** the copy strips the UTF-8 BOM
>    from `mirror.json` / `bundle.json` exactly as the shim does, so a BOM-ed record no longer reads as "no record"
>    on the setup side (which used to re-mirror the previous manifest).

### Updating from the market

Update it where you installed it. Updating **to 2.0.5 or later** is routine; updating an installed 2.0.1–2.0.4
*through the in-app market* failed with this, three times on a healthy profile:

> dsh-plugin-rea 更新后缺少入口文件（package.json 的 main/exports 指向的文件不存在），且未能验证恢复原版本文件

That message is not about a broken tarball. On every update the market asks whether the new build's
`package.json` points at an entry file that exists (`hasLoadableEntry` in `dshmarket`), and rolls the build back
when the answer is false. A bundle may legitimately own no entry — but only if a package it *mounts* has one, and
the package this bundle mounts (`@deepseek-ai/dsh-mcp-client`) ships inside the harness build rather than in
`node_modules`, so every location that test probes comes back empty. The 1.x and 2.0.x manifests also declared
no `main` at all, so the answer was false even though the profile was working; the rollback was then reported as
unverifiable for the same reason. Nothing in the profile was actually damaged — the update simply did not apply.

2.0.5 declares `main: ./index.mjs`. That file is a real, deliberately empty Cordis plugin: it registers nothing,
spawns nothing, touches no state — the working row is still inserted by `cordis.patch.yml` — and it exists so the
question "can this package load?" has an honest answer, and so `import 'dsh-plugin-rea'` resolves. On an older
version, update to `>=2.0.5`; if the market refuses before that version exists, install `dsh-plugin-rea@2.0.5`
(Desktop: through the plugin manager) instead of updating in place.

### Upgrading from 1.x

Install 2.x, then run provisioning **once** before restarting dsh:

```
node scripts/setup.mjs          # or: powershell -File scripts\rea-bundle-bootstrap.ps1 -Reuse
```

Why it matters: the 1.x row launched `rea mcp` from PATH, while the 2.x row launches
`<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs` — a file only `setup.mjs` creates. Upgrade and restart
without provisioning and that row exits with `MODULE_NOT_FOUND`: the harness stays up
(`failOnStartupError: false` is deliberate), but the `mcp__rea__*` tools are gone and you get **no
remediation message**, because the shim that prints one does not exist yet. After the setup run they are
back on the next start.

- **This plugin** never updates itself. Installed from a market? Update it there. Installed from a `file:`
  checkout? Overwrite the directory and reinstall.
- **The row runs a COPY of this plugin's launcher.** `<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs` is a mirror
  made by setup, so a market upgrade replaces the package but not the file the row executes — until setup runs
  again. From **2.0.8** the mirror notices that the installed plugin ships a different launcher and re-execs it
  (one hop, guarded by `REA_BUNDLE_SHIM_REEXEC`), so upgrades carry. On an older version the mirror stays behind
  silently; `--shim-status` now reports `mirror.stale`, and `check-updates.ps1` says to re-run setup. If you are
  upgrading from 2.0.0–2.0.7, run `node scripts/setup.mjs` once after the upgrade.
- **The mirrored `scripts/setup.mjs` is a copy too.** A market upgrade replaces the package but not that copy,
  so a remediation command that points at `<DSH_HOME>/plugins/rea-bundle/scripts/setup.mjs` runs the setup from
  when the bundle was created — not the one you just installed. From **2.0.9** both the shim and setup strip a
  UTF-8 BOM from `mirror.json` / `bundle.json` (a BOM-ed record used to read as "no record" on the setup side,
  which re-mirrored the previous manifest). Running `node scripts/setup.mjs` once **from the plugin directory**
  refreshes that copy too.
- **Upgrading from `2.0.0-bundle.1`**: that release mirrored the shim and `setup.mjs` but not the manifest,
  and recorded nothing about the plugin checkout, so a bundle it provisioned cannot repair itself — its
  background provisioning dies on the missing manifest, invisibly, and its own lock suppresses retries for
  six hours. Re-run `node scripts/setup.mjs` **from the plugin directory** once; it re-mirrors all three
  files and writes the record that lets later runs find the checkout. `check-updates.ps1` reports this state.
- **Provisioned components**: re-run `node scripts/setup.mjs`; it re-verifies what is on disk and only
  fetches what is missing or wrong. Pins live in `manifest/bundle.manifest.json`.
- **Upstream REA / Ghidra**: update the pins in the manifest, then re-run setup. REA version-gates Ghidra
  (12.1.x today), so update REA first.

`check-updates.ps1` (Windows PowerShell) reports the state of all of these at once.

## Still prefer the configuration-only 1.x line?

1.x is the adapter **without** provisioning: one row that launches `rea mcp` from PATH and expects Ghidra to be
installed by you. It is the right choice when you already manage REA and Ghidra yourself, when you do not want
the plugin fetching anything, or when you want the row to keep pointing at your own `rea` binary:

```
dsh plugin --profile <profile> add dsh-plugin-rea@1.0.6
# or pin the branch instead of the version:
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea#v1.0.6
```

Both lines publish the same patch shape and the same `mcp__rea__*` surface. 1.x is maintained on the
[`v1` branch](https://github.com/czcdr/dsh-plugin-rea/tree/v1), where its own install notes live (Node on REA's
engines, `npm i -g rea-agents`, Ghidra 12.1.x for native analysis).

## License

MIT (this adapter). REA is MIT and owned by its authors; Ghidra is Apache-2.0 and owned by the NSA; Temurin
is GPLv2+CE; Node.js is MIT; apktool, jadx-headless-mcp and Android platform-tools keep their own licences.
**No upstream code or binary is redistributed in this package** — provisioning fetches each component from
its official source.
