# Building Ghidra's native decompiler for macOS arm64

**Status: verified on real hardware, 2026-11-09.** This closes the `smoke` failure described in the README
section [The `smoke` step fails on macOS](../README.md#the-smoke-step-fails-on-macos-and-that-is-not-a-provisioning-fault).
Ghidra's public zip ships no macOS native binary (`Ghidra/Features/Decompiler/os/` contains only
`linux_x86_64` and `win_x86_64`), so the provider stays unavailable until one is built. It can be built from
the pinned tag with nothing but a C++ compiler and `make`.

After the build, on the same machine:

```
rea doctor                                     → ghidra-native_decompiler: ok
                                                 "…reports mach-o arm64, which matches darwin/arm64"
                                                 provider ghidra: available: true
setup.mjs --reuse                              → [ok] smoke — imported java in 7s via ghidra
                                                 setup complete.
```

## Environment this was measured in

| | |
|---|---|
| Host | macOS 27.2 (build 26B123), arm64 (Apple Silicon) |
| Compiler | Apple clang 21.0.0, Command Line Tools only — **no `Xcode.app`** |
| Build tool | GNU make 3.81 |
| Ghidra | 12.1.4 from `ghidra_12.1.4_PUBLIC_20260921.zip` — the bundle's `<bundle>/vendor/ghidra` |
| Not required | `cmake`, `gradle`, Homebrew's bison, `Xcode.app` |

`/usr/bin/bison` on macOS is 2.3 and Ghidra wants 3.x — irrelevant here, because the generated parsers are
committed to the repository (see step 2).

## Recipe

```bash
# 1) only the decompiler sources, not the whole repository (~13 MB at the pinned tag)
git clone --depth 1 --branch Ghidra_12.1.4_build --filter=blob:none --sparse \
  https://github.com/NationalSecurityAgency/ghidra.git /tmp/ghidra-src
git -C /tmp/ghidra-src sparse-checkout set Ghidra/Features/Decompiler/src/decompile/cpp

# 1a) a tag is a movable ref; everything else in this repo pins a digest, so pin the
#     commit too and fail loudly if the tag ever points somewhere else
test "$(git -C /tmp/ghidra-src rev-parse HEAD)" = \
  "8b6bbb857accdfa20dc5b2f5dea471178c2e9fbc" || {
  echo "Unexpected Ghidra source revision" >&2
  exit 1
}

cd /tmp/ghidra-src/Ghidra/Features/Decompiler/src/decompile/cpp

# 2) the generated bison/lex outputs are in the tree; a newer mtime keeps make from
#    invoking the system bison, which is too old to regenerate them
touch grammar.cc grammar.hh xml.cc pcodeparse.cc slghparse.cc slghparse.hh slghscan.cc

# 3) ghidra_opt is the binary Ghidra launches as `decompile`
make -j"$(sysctl -n hw.ncpu)" ghidra_opt CXX="clang++ -std=c++17" ARCH_TYPE="" ADDITIONAL_FLAGS="-w"

# 4) where REA and Ghidra look for it (GHIDRA_INSTALL_DIR is exported by the bundle's shim)
GHIDRA_INSTALL_DIR="${GHIDRA_INSTALL_DIR:-$HOME/.dsh/plugins/rea-bundle/vendor/ghidra}"
install -d "$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/os/mac_arm_64"
install -m 755 ghidra_opt "$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/os/mac_arm_64/decompile"
```

The build is 81 translation units and takes a couple of minutes on an M-series machine; the artifact is a
~3.1 MB `Mach-O 64-bit executable arm64`. `ARCH_TYPE=` and `ADDITIONAL_FLAGS=` are cleared because the
Makefile's `Darwin` branch hardcodes `-arch x86_64` and a `10.6` deployment target from the Intel era; a
native compile needs neither. `-w` hides the legacy warnings the default `-Wall -Wno-sign-compare` surfaces.

## What was verified after the build

| Observation | Value |
|---|---|
| `rea doctor` → `ghidra-native_decompiler` | `ok` — "reports mach-o arm64, which matches darwin/arm64" |
| `rea doctor` → provider `ghidra` | `configured: true`, `available: true`, `providerVersion: 12.1.4` (was `available: false`, `executable_missing`) |
| `binary_overview` on a thinned `/bin/ls` (`arm64e` slice) | 17 segments, 218 procedures, 302 strings |
| `procedure_pseudo_code` at `0x100000700` | decompiled body (a `_strcoll` wrapper over two `+0x68` fields) |
| `setup.mjs --reuse` | `[ok] smoke — imported java in 7s via ghidra`, `setup complete.` |

## Caveats

- **The binary lives inside the Ghidra installation.** A provisioning run that re-extracts Ghidra (a plugin
  upgrade to new pins, or a repaired install) deletes `os/mac_arm_64/` with the rest of the tree. Keep a copy
  and re-run the recipe, or re-install the copy after the run.
- **It is built locally, unsigned, and not hash-pinned.** There is no quarantine attribute and REA only checks
  the architecture and executability, so this is fine on the machine that built it — but running it adds one
  more unverified assumption to an analysis chain that is otherwise pinned end to end. That is a trade a reader
  should make knowingly, and it is the reason the commit pin in step 1a exists rather than a bare tag.
- **Universal (fat) Mach-O still needs thinning.** Ghidra v1 cannot enforce an architecture when importing a
  universal binary; `lipo -thin arm64e input -output thinned` (or `arm64`) first. That is independent of the
  decompiler and unchanged by this build.
- **Version pairing matters.** The source revision must match the Ghidra the bundle runs
  (`manifest/bundle.manifest.json` pins 12.1.4 today). The same recipe applies to a later 12.1.x once both the
  tag and the commit pin are updated, and REA's version-equality gate still governs which Ghidra it accepts.
