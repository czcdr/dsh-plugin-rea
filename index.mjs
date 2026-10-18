/**
 * Package entry — the smallest thing that makes this bundle a *loadable* package.
 *
 * Everything this plugin DOES lives in `cordis.patch.yml`: it inserts one row of
 * `@deepseek-ai/dsh-mcp-client` that launches `bin/rea-shim.mjs`, and that row is
 * what the harness loads. This file registers nothing, starts nothing and
 * provisions nothing.
 *
 * It exists because a package that declares no `main`/`exports` is judged by its
 * consumers as "has no entry file", whether or not the loader ever needs one:
 *
 *   - The market's update path (`hasLoadableEntry` in dshmarket) asks that
 *     question on every update and, when the answer is false, treats the new
 *     build as broken and rolls back. A bundle with no entry of its own is
 *     *supposed* to survive the test through the packages it mounts — but the
 *     package this one mounts (`@deepseek-ai/dsh-mcp-client`) is part of the
 *     harness build, not of `node_modules`, so every location that test probes
 *     comes back empty. Measured on 2026-10-18: updating an installed, working
 *     2.0.1 to 2.0.4 failed three times with "updated build has no loadable
 *     entry", and the rollback was then reported as unverifiable for the same
 *     reason.
 *   - `npm pack` metadata and `import 'dsh-plugin-rea'` both resolve `main`;
 *     absent, both fall back to `index.js`, which this repository never shipped.
 *
 * So this is a real module with a real Cordis plugin shape rather than a stub
 * for a checker: if the harness ever does load this package as a plugin, it
 * loads cleanly and does nothing.
 */

/** Cordis plugin name. Also the package name, which is what the loader expects. */
export const name = 'dsh-plugin-rea'

/**
 * Intentionally empty.
 *
 * The row that does the work is inserted by the bundle patch, not by this
 * function: registering the MCP client from here would create a second
 * `serverName: rea` entry, which the harness refuses as a duplicate (the same
 * collision `bin/rea-shim.mjs` warns about for upstream's `rea setup --client
 * dsh`). Doing nothing is the correct behaviour, and the function present keeps
 * this a valid Cordis plugin instead of an arbitrary module.
 */
export function apply() {}
