/**
 * Package entry — the smallest thing that makes this adapter a *loadable* package.
 *
 * Everything the 1.x line does is in `cordis.patch.yml`: it inserts one row of
 * `@deepseek-ai/dsh-mcp-client` that launches the `rea mcp` you installed
 * yourself. This file registers nothing and starts nothing.
 *
 * It exists because a package that declares no `main`/`exports` is judged by its
 * consumers as "has no entry file", whether or not the loader ever needs one. On
 * 2.x that judgement broke market updates outright (see that branch's CHANGELOG);
 * the same check applies here, so this manifest declares the same entry rather
 * than repeating the defect. The harness still never loads this file for its own
 * sake — the row is inserted by the patch, not by this module.
 */

/** Cordis plugin name. Also the package name, which is what the loader expects. */
export const name = 'dsh-plugin-rea'

/**
 * Intentionally empty: registering the MCP client here would add a second
 * `serverName: rea` row on top of the one the patch inserts, and the harness
 * refuses duplicates. Doing nothing is the contract.
 */
export function apply() {}