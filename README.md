# dsh-plugin-rea

[![npm version](https://img.shields.io/npm/v/dsh-plugin-rea?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-rea)

**English** · [简体中文](README.zh-CN.md)

Brings the upstream **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)** MCP server into
**DeepSeek Harness** (dsh), so its tools show up in a session as `mcp__rea__*`.

![dsh-plugin-rea: a session calls the local rea mcp through the official MCP client row, and the Evidence comes back](assets/screenshot-1.png)

> **This branch (`feat/one-plugin-bundle`) is the all-in-one variant.** `main` stays the original
> configuration-only adapter, which assumes you installed Node, `rea-agents` and Ghidra yourself. This
> branch keeps that patch shape but adds a provisioning layer: install the plugin on a bare machine and it
> prepares the runtime, then wires the row itself.

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

## Install

**Nothing to install first.** On a bare Windows x64 machine:

```
powershell -ExecutionPolicy Bypass -File scripts\rea-bundle-bootstrap.ps1 -Reuse
```

`-Reuse` adopts a Ghidra/JDK you already have; omit it to download both (about 775 MB from the official
releases, checksum-verified). Then install the plugin for your profile:

```
dsh plugin --profile <profile> add github:czcdr/dsh-plugin-rea#feat/one-plugin-bundle
```

> **On an Electron host (the DeepSeek Harness desktop app) the profile is owned by the application.**
> `dsh plugin --profile desktop …` is refused by the CLI (`profile "desktop" is managed exclusively by
> the Electron application`) — install or update through the in-app plugin manager instead. The CLI form
> above is for a profile you created yourself with the CLI under another name.

If Node is already installed, you can skip the bootstrap and run provisioning directly:

```
node scripts/setup.mjs --reuse      # or --dry-run to see the plan first
```

Installing the plugin **first** also works, but it takes two steps. The row resolves to
`<DSH_HOME>/plugins/rea-bundle/bin/rea-shim.mjs`, and that file is created by setup — so until the first
provisioning run the row exits with `MODULE_NOT_FOUND`, and nothing is there to start a background
provisioning (the harness itself is unaffected: `failOnStartupError: false` is deliberate). Run
`node scripts/setup.mjs` once; from then on the shim is in place, and every later missing state is picked up
by the shim itself, which provisions in the background.

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

## Verify

Ask for a `mcp__rea__*` call — `binary_session` reports the engine checks
(`configuration` / `installation` / `headless` / `native_decompiler` / `java`), all of which should be
`ok: true`. Then `open_binary` a PE, `binary_overview`, and `procedure_pseudo_code`.

Provisioning itself ends with two probes: `rea doctor --json` (reported, with unmet checks named) and the
exact shim launch the MCP row will use.

## Verified against

Author's machine, 2026-10-13:

| Component | Version |
|---|---|
| REA (`rea-agents`) | **6.4.0** (170 tools) |
| DeepSeek Harness | desktop runtime **0.2.0-rc.2**, with its bundled dsh CLI 0.1.7-rc.2 |
| `@deepseek-ai/dsh-mcp-client` (row provider) | bundled by the harness |
| Ghidra | 12.1.4 |
| JDK | Temurin 21 (provisioned) / Microsoft OpenJDK 25.0.4 (adopted) |
| Node.js | 24.21.0 (REA engines: `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`) |
| Host | Windows 11 x64 (build 26200) |

Exercised live: a clean `setup.mjs --reuse` run reached `setup complete`; an MCP `initialize` handshake
**through the shim with no `rea` on PATH** answered `serverInfo {name: rea, version: 6.4.0}`.

## Scope and caveats

- REA exposes 170 tools at 6.4.0, so every session's tool list grows.
- Provisioning is honest about checksums: where a vendor publishes one it is pinned and verified; where none
  exists (jadx-headless-mcp, the apktool wrapper, Android platform-tools, the rolling "latest" URLs) the
  hash is **measured once and recorded**, and later drift is reported rather than silently accepted.
  `bundle.json` lists which components are in that state under `unverifiedChecksums`.
- Downloads are slow on some networks (measured 0.35–0.54 MiB/s from the GitHub release CDN here, so Ghidra
  alone takes ~25–45 min). Fetching is resumable: the cache is kept and re-verified, and a killed run
  continues instead of restarting.
- Some REA tools launch processes, write files and access the network — DSH's permission policy applies.
  Analyse only artifacts you are authorized to inspect.
- `scripts/setup.mjs` runs `npm install` for the REA CLI with `--ignore-scripts`: the published tarball
  carries no `node_modules`, so a dependency closure must be resolved, and package lifecycle scripts are
  skipped on purpose during provisioning.

## Updating — three independent things

- **This plugin** never updates itself. Installed from a market? Update it there. Installed from a `file:`
  checkout? Overwrite the directory and reinstall.
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

## License

MIT (this adapter). REA is MIT and owned by its authors; Ghidra is Apache-2.0 and owned by the NSA; Temurin
is GPLv2+CE; Node.js is MIT; apktool, jadx-headless-mcp and Android platform-tools keep their own licences.
**No upstream code or binary is redistributed in this package** — provisioning fetches each component from
its official source.
