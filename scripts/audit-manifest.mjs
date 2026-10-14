#!/usr/bin/env node
/**
 * manifest audit — validate the component manifest before it is published.
 *
 * JSON.parse cannot see duplicate keys (the last one silently wins), and this
 * manifest is long enough that a duplicated field is easy to introduce while
 * editing. So the checks are:
 *
 *  1. duplicate object keys inside any single object            (parse-level)
 *  2. every fetch entry has a sha256 that is either 64-hex or the literal
 *     "unverified", never a placeholder or an invented value
 *  3. every fetch entry declares a size, except formats where the vendor does
 *     not publish one
 *  4. every platform we claim to support has every entry it needs
 *  5. the apktool wrapper for a platform is the right script (the osx wrapper
 *     is not the linux one) and jar+wrapper both land in the same directory
 *  6. every probe token is one the substitution step actually understands
 *  7. `requires` names refer to real components and cannot form a cycle
 *
 * Exit code 0 = clean, 1 = findings. Also usable as `npm run bundle:audit`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "..", "manifest", "bundle.manifest.json");
const raw = readFileSync(MANIFEST, "utf8");

const findings = [];
const add = (severity, where, message) => findings.push({ severity, where, message });

/* -------------------------------------------------- 1. duplicate object keys */

/** Walk the raw text and report any key that appears twice in one object. */
function findDuplicateKeys(text) {
  const duplicates = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(new Set());
      i += 1;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i += 1;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') break;
        else i += 1;
      }
      const key = text.slice(start + 1, i);
      i += 1;
      // A key is followed by ':' after optional whitespace.
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === ":" && stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.has(key)) duplicates.push({ key, index: start });
        frame.add(key);
      }
      continue;
    }
    i += 1;
  }
  return duplicates;
}

const duplicates = findDuplicateKeys(raw);
if (duplicates.length > 0) {
  const lineOf = (index) => raw.slice(0, index).split("\n").length;
  for (const duplicate of duplicates) {
    add("error", `line ${lineOf(duplicate.index)}`, `duplicate object key "${duplicate.key}" — JSON.parse silently keeps only the last one`);
  }
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  add("error", "manifest", `not valid JSON: ${String(error.message)}`);
}

if (manifest) {
  /* ------------------------------------------- 2/3. every fetch entry is sound */

  const HEX64 = /^[0-9a-f]{64}$/;
  const fetchEntries = [];
  for (const [componentName, component] of Object.entries(manifest.components ?? {})) {
    if (component.sources) {
      for (const [key, source] of Object.entries(component.sources)) {
        if (key === "npm") continue;
        fetchEntries.push({ where: `${componentName}.sources.${key}`, entry: source });
      }
    }
    if (component.entries) {
      for (const [key, list] of Object.entries(component.entries)) {
        if (key === "byPlatform") {
          for (const [platform, platformList] of Object.entries(list)) {
            for (const [index, entry] of platformList.entries()) {
              fetchEntries.push({ where: `${componentName}.entries.byPlatform.${platform}[${index}]`, entry });
            }
          }
        } else {
          for (const [index, entry] of list.entries()) {
            fetchEntries.push({ where: `${componentName}.entries.${key}[${index}]`, entry });
          }
        }
      }
    }
  }

  for (const { where, entry } of fetchEntries) {
    const sha = entry.sha256;
    if (sha === undefined) {
      add("error", where, "has no sha256 field");
    } else if (sha !== "unverified" && !HEX64.test(sha)) {
      add("error", where, `sha256 is neither 64 lowercase hex nor "unverified": ${JSON.stringify(sha)}`);
    }
    if (entry.size === undefined && entry.format !== "npm") {
      add("warn", where, "has no size, so a truncated transfer cannot be detected by length");
    }
    if (!entry.url) add("error", where, "has no url");
    if (entry.url && /localhost|127\.0\.0\.1/.test(entry.url)) add("error", where, "url points at loopback");
    if (entry.sha256 === "unverified" && !entry.sha256Source) {
      add("warn", where, "is unverified but does not say why");
    }
  }

  /* ------------------------------------------------- 4. platform coverage */

  const DECLARED_PLATFORMS = ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
  for (const [name, component] of Object.entries(manifest.components ?? {})) {
    if (!component.sources) continue;
    // An `all` source is platform-independent and an npm source has no platform
    // at all; neither is expected to enumerate every platform.
    if (component.sources.all || component.kind === "npm" || component.sources.npm) continue;
    for (const platform of DECLARED_PLATFORMS) {
      if (!component.sources[platform]) {
        add("error", `${name}.sources`, `no source for declared platform ${platform}`);
      }
    }
  }

  /* ------------------------------- 5. apktool wrapper mapping is not crossed */

  const apktool = manifest.components?.apktool;
  if (apktool?.entries?.byPlatform) {
    const byPlatform = apktool.entries.byPlatform;
    const jarDirectory = apktool.entries.all?.[0]?.moveTo;
    for (const [platform, list] of Object.entries(byPlatform)) {
      for (const entry of list) {
        const wantsWindows = platform.startsWith("win32");
        const wantsOsx = platform.startsWith("darwin");
        if (wantsWindows && !entry.url.includes("/windows/")) {
          add("error", `apktool.entries.byPlatform.${platform}`, `expects the windows wrapper but points at ${entry.url}`);
        }
        if (wantsOsx && !entry.url.includes("/osx/")) {
          add("error", `apktool.entries.byPlatform.${platform}`, `macOS must use scripts/osx/apktool, not ${entry.url}`);
        }
        if (platform.startsWith("linux") && !entry.url.includes("/linux/")) {
          add("error", `apktool.entries.byPlatform.${platform}`, `expects the linux wrapper but points at ${entry.url}`);
        }
        if (entry.moveTo !== jarDirectory) {
          add("error", `apktool.entries.byPlatform.${platform}`, `wrapper lands in ${entry.moveTo} but the jar lands in ${jarDirectory}; the wrapper resolves the jar next to itself`);
        }
      }
    }
  }

  /* ------------------------------------------------------- 6. probe tokens */

  const KNOWN_TOKENS = ["{root}", "{vendor}", "{vendorDir}", "{node}", "{jdk}", "{jvm}", "{javahome}", "{ghidra}", "{exe}"];
  const probes = [];
  for (const [name, component] of Object.entries(manifest.components ?? {})) {
    if (component.probe?.argv) for (const value of component.probe.argv) probes.push({ where: `${name}.probe`, value });
    if (component.probe?.file) probes.push({ where: `${name}.probe`, value: component.probe.file });
  }
  for (const { where, value } of probes) {
    for (const token of String(value).match(/\{[a-zA-Z]+\}/g) ?? []) {
      if (!KNOWN_TOKENS.includes(token)) add("error", where, `unknown probe token ${token} in ${JSON.stringify(value)}`);
    }
  }

  /* -------------------------------------------------- 7. requires integrity */

  const names = new Set(Object.keys(manifest.components ?? {}));
  for (const [name, component] of Object.entries(manifest.components ?? {})) {
    for (const requirement of component.requires ?? []) {
      if (!names.has(requirement)) add("error", `${name}.requires`, `unknown component "${requirement}"`);
      if (requirement === name) add("error", `${name}.requires`, "depends on itself");
    }
  }
  // Cycle check over `requires`.
  const visiting = new Set();
  const visited = new Set();
  const walk = (name, trail) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      add("error", `${name}.requires`, `dependency cycle: ${[...trail, name].join(" -> ")}`);
      return;
    }
    visiting.add(name);
    for (const requirement of manifest.components[name]?.requires ?? []) {
      if (names.has(requirement)) walk(requirement, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of names) walk(name, []);

  /* ------------------------------------- 8. the published patch's JS escapes */

  // This check exists because of a real bug: the row used
  //   process.env.DSH_HOME + '\plugins\rea-bundle\bin\rea-shim.mjs'
  // YAML single quotes keep the backslashes literal, and JavaScript then eats
  // them — '\p' is not a path separator, '\r' is a carriage return and '\b' is a
  // backspace, so the evaluated path was a string full of control characters
  // that could never start. Nothing in a manifest audit would notice; evaluating
  // the expression does.
  const patchPath = path.join(HERE, "..", "cordis.patch.yml");
  const patchText = readFileSync(patchPath, "utf8");
  const controlChar = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

  // Evaluate every JS string literal in the patch the way JavaScript would, so
  // the escape handling is the real one and not a re-implementation.
  const literals = [...patchText.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]);
  const evaluated = literals.map((literal) => {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`return '${literal}'`)();
    } catch {
      return literal;
    }
  });
  for (const value of evaluated) {
    if (controlChar.test(value)) {
      add(
        "error",
        "cordis.patch.yml",
        `a single-quoted literal evaluates to a string containing control characters (${JSON.stringify(value.slice(0, 60))}) — use forward slashes in JS string literals`,
      );
    }
  }
  if (/\\p|\\r|\\b|\\n|\\t/.test(patchText.replace(/^\s*#.*$/gm, ""))) {
    add("error", "cordis.patch.yml", "a JS string literal contains a backslash escape (\\p, \\r, \\b, ...); use forward slashes");
  }
  if (!/rea-shim\.mjs/.test(patchText)) {
    add("error", "cordis.patch.yml", "the patch does not reference rea-shim.mjs");
  }
  if (!/DSH_HOME/.test(patchText) || !/USERPROFILE|HOME/.test(patchText)) {
    add("error", "cordis.patch.yml", "no fallback for an unset DSH_HOME was found");
  }

  /* --------------------------- 9. the row, the shim and setup agree on DSH_HOME */

  // This check exists because of a real bug: the row fell back to the bare home
  // directory while the shim, setup.mjs and bootstrap.ps1 all fall back to
  // `<home>/.dsh`. setup therefore mirrored the launcher one level below where
  // the row looked for it, and the row could never start — but only on a machine
  // where DSH_HOME happened to be unset, so it stayed invisible. Evaluating the
  // published expression is the only way to catch it.
  // A bare `!!js` scalar containing "? " and ": " is not one scalar at all: YAML
  // reads `? a : b` as an explicit key/value pair, so the loader receives a
  // mapping instead of an expression node. Reproduced against the harness's own
  // schema (JSON_SCHEMA + the !!js Type from app.asar): args[0] became
  // {"[object Object]": "..."} and the row could not start. Quoting the scalar
  // removes the ambiguity, so this check requires quotes around any expression
  // that would otherwise be read as a mapping.
  for (const match of patchText.matchAll(/^[ \t]*-[ \t]*!!js[ \t]+(\S.*)$/gm)) {
    const scalar = match[1].trim();
    if (scalar.startsWith('"') || scalar.startsWith("'")) continue;
    if (/\?\s/.test(scalar) && /:\s/.test(scalar)) {
      add(
        "error",
        "cordis.patch.yml",
        `a bare !!js scalar contains "? " and ": " (${scalar.slice(0, 48)}...), which YAML reads as a mapping: quote the scalar so the loader receives an expression`,
      );
    }
  }

  // Pull the shim-path expression out of the row — quoted (required for a ternary)
  // or bare. The trailing YAML quote follows the expression's own closing quote,
  // so the match takes the rest of the line and strips the outer quoting.
  const rowMatch = patchText.match(/^[ \t]*-[ \t]*!!js[ \t]+(.+rea-shim\.mjs.*)$/m);
  let jsExpression = rowMatch ? rowMatch[1].trim() : null;
  if (jsExpression) {
    const first = jsExpression[0];
    const last = jsExpression[jsExpression.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      jsExpression = jsExpression.slice(1, -1);
    }
  }
  const shimSuffix = "/.dsh/plugins/rea-bundle/bin/rea-shim.mjs";
  if (!jsExpression) {
    add("error", "cordis.patch.yml", "the !!js expression that computes the shim path was not found");
  } else {
    const evaluate = (env) => {
      // eslint-disable-next-line no-new-func
      return new Function("process", `return ${jsExpression}`)({ env });
    };
    for (const [label, env] of [
      ["DSH_HOME unset", { USERPROFILE: "C:\\Users\\probe", HOME: "/home/probe" }],
      ["DSH_HOME empty", { DSH_HOME: "   ", USERPROFILE: "C:\\Users\\probe", HOME: "/home/probe" }],
      ["DSH_HOME unset, POSIX only", { HOME: "/home/probe" }],
    ]) {
      let value;
      try {
        value = evaluate(env);
      } catch (error) {
        add("error", "cordis.patch.yml", `the !!js expression throws with ${label}: ${error && error.message}`);
        continue;
      }
      if (typeof value !== "string" || !value.endsWith(shimSuffix)) {
        add(
          "error",
          "cordis.patch.yml",
          `with ${label} the row resolves to ${JSON.stringify(value)}; it must end in ${shimSuffix} — the shim, setup.mjs and bootstrap.ps1 all fall back to <home>/.dsh, so the row would look one level too high for a file provisioning writes`,
        );
      }
    }
    let withHome;
    try {
      withHome = evaluate({ DSH_HOME: "/custom/home" });
    } catch (error) {
      withHome = `threw: ${error && error.message}`;
    }
    if (withHome !== "/custom/home/plugins/rea-bundle/bin/rea-shim.mjs") {
      add("error", "cordis.patch.yml", `with DSH_HOME set the row resolves to ${JSON.stringify(withHome)}, expected /custom/home/plugins/rea-bundle/bin/rea-shim.mjs`);
    }

    // A machine with no DSH_HOME, USERPROFILE and HOME resolves the row to the
    // filesystem root. That is a known, harmless divergence rather than a bug: the
    // row reports MODULE_NOT_FOUND, writes and downloads nothing, and the harness
    // carries on (`failOnStartupError: false`). It cannot be reconciled from inside
    // a `!!js` expression either — setup.mjs resolves such a machine through
    // `os.homedir()`, which falls back to the passwd entry on POSIX. Pinned as a
    // warning so the behaviour stays known instead of being rediscovered as a bug.
    let rootless;
    try {
      rootless = evaluate({});
    } catch (error) {
      rootless = `threw: ${error && error.message}`;
    }
    if (rootless !== "/.dsh/plugins/rea-bundle/bin/rea-shim.mjs") {
      add(
        "warn",
        "cordis.patch.yml",
        `with DSH_HOME, USERPROFILE and HOME all absent the row resolves to ${JSON.stringify(rootless)}; the documented behaviour is "/.dsh/plugins/rea-bundle/bin/rea-shim.mjs"`,
      );
    }

    // Both READMEs print this row so a reader can copy it, and a documented row
    // that has drifted from the shipped one is what people actually install.
    for (const doc of ["README.md", "README.zh-CN.md"]) {
      const text = readFileSync(path.join(HERE, "..", doc), "utf8");
      if (!text.includes(jsExpression)) {
        add("error", doc, "the documented !!js expression differs from cordis.patch.yml, so copied instructions would install the wrong row");
      }
    }
  }

  /* ------------------------------------------- 10. the mirror list is complete */

  // Another real bug: mirrorLauncher() copied the shim and setup.mjs but not the
  // manifest. The mirrored setup.mjs derives its plugin root from its own
  // location, so loadManifest() then read <bundle>/manifest/bundle.manifest.json
  // — a file nothing created — and every later run died with a bare ENOENT that
  // the detached auto-provision swallowed.
  const setupText = readFileSync(path.join(HERE, "..", "scripts", "setup.mjs"), "utf8");
  const mirrorBody = setupText.match(/function mirrorLauncher\(context\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  if (!mirrorBody) {
    add("error", "scripts/setup.mjs", "mirrorLauncher() was not found, so the mirror list can no longer be verified");
  } else {
    // Only the array literal counts. Scanning the whole function body would also
    // match the explanatory comment above it, which is exactly how this check
    // first let a sabotaged mirror list pass.
    const sourcesBody = mirrorBody.match(/const sources = \[([\s\S]*?)\];/)?.[1];
    if (sourcesBody === undefined) {
      add("error", "scripts/setup.mjs", "the mirror list (const sources = [...]) was not found");
    } else {
      for (const needed of ["bin/rea-shim.mjs", "scripts/setup.mjs", "manifest/bundle.manifest.json"]) {
        if (!sourcesBody.includes(`"${needed}"`)) {
          add("error", "scripts/setup.mjs", `mirrorLauncher() does not mirror ${needed}, which the mirrored copy reads at run time`);
        }
      }
      // The shim tells its two copies apart by `cordis.patch.yml`, which only the
      // checkout ships: a mirrored copy resolves its bundle from its own location
      // (an MCP child has no DSH_HOME to consult), a checkout copy resolves the
      // same root setup writes. Mirroring the discriminator would silently flip a
      // mirrored copy back to the DSH_HOME rule — wrong wherever DSH_HOME is
      // custom, and wrong in every MCP child, where it is stripped.
      if (/cordis\.patch\.yml/.test(sourcesBody)) {
        add(
          "error",
          "scripts/setup.mjs",
          "the mirror list ships cordis.patch.yml, which bin/rea-shim.mjs uses to tell a checkout from a mirrored copy — a mirrored copy would then resolve its bundle through DSH_HOME, which an MCP child does not have",
        );
      }
    }
  }

  /* ------------------------------------------------------------- summary */

  const pinned = fetchEntries.filter((entry) => entry.entry.sha256 && entry.entry.sha256 !== "unverified").length;
  const tofu = fetchEntries.length - pinned;
  console.log(`manifest audit: ${fetchEntries.length} fetch entries — ${pinned} hash-pinned, ${tofu} TOFU`);
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warn");
  for (const finding of findings) {
    console.log(`  ${finding.severity === "error" ? "ERROR" : "warn "} ${finding.where}: ${finding.message}`);
  }
  console.log(errors.length === 0 ? `clean${warnings.length ? ` (${warnings.length} warning(s))` : ""}` : `${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length === 0 ? 0 : 1);
}
