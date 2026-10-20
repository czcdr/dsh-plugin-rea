/**
 * Package entry — a loadable package, plus the read-only route behind the
 * one-shot setup guide.
 *
 * Two jobs, deliberately kept apart:
 *
 *   1. Make this package loadable. The row that does the real work lives in
 *      `cordis.patch.yml`: it inserts one row of `@deepseek-ai/dsh-mcp-client`
 *      that launches `bin/rea-shim.mjs`. A package that declares no
 *      `main`/`exports` is judged by its consumers as "has no entry file",
 *      whether or not the loader needs one: dshmarket's `hasLoadableEntry`
 *      asks that on every update and rolls a working build back when the answer
 *      is false (measured 2026-10-18, 2.0.1 → 2.0.4), and npm metadata resolves
 *      `main` too. So this is a real module with a real Cordis shape.
 *
 *   2. Answer GET /dsh-plugin-rea/guide-state for `client.js`. The guide has to
 *      tell a first install apart from an upgrade — not by guessing, but by
 *      comparing the REA version recorded in `plugins/rea-bundle/bundle.json`
 *      with the version this package pins. `bin/rea-guide.mjs` computes it as a
 *      pure function; this file only serves the result. Nothing here provisions,
 *      spawns or mutates: the route is read-only, and the guide never runs
 *      setup for the user.
 *
 * The route is mounted only when the host has a webServer (the Web GUI), through
 * `ctx.inject`, so a headless/ACP host loads this plugin exactly like before.
 */

import { GUIDE_ROUTE, computeGuideState, localPackageFacts } from './bin/rea-guide.mjs'

/** Cordis plugin name. Also the package name, which is what the loader expects. */
export const name = 'dsh-plugin-rea'

/** Cached package facts; the files change only when the package is replaced. */
let cachedFacts = null

function packageFacts() {
  if (!cachedFacts) cachedFacts = localPackageFacts()
  return cachedFacts
}

function sendJson(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(headOnly ? undefined : body)
}

/**
 * Register the read-only guide route on a host that has a webServer.
 *
 * `webServer.register` takes `{ kind: 'exact', path, handler }` and returns a
 * disposer; `ctx.effect` ties that disposer to this plugin's lifetime, so a
 * hot disable removes the route instead of leaving a handler over unloaded code.
 */
function mountGuideRoute(host) {
  const server = host && host.webServer
  if (!server || typeof server.register !== 'function') return
  if (typeof host.effect !== 'function') return

  host.effect(() =>
    server.register({
      kind: 'exact',
      path: GUIDE_ROUTE,
      handler: (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'GET only' })
            return
          }
          const facts = packageFacts()
          const state = computeGuideState({
            pluginVersion: facts.pluginVersion,
            pinnedRea: facts.pinnedRea,
          })
          sendJson(res, 200, state, req.method === 'HEAD')
        } catch (error) {
          sendJson(res, 500, {
            error: error && error.message ? error.message : String(error),
          })
        }
      },
    }),
  )
}

/**
 * Mount the guide route when the host can serve it.
 *
 * `ctx.inject` is the normal path: it runs the callback once `webServer` exists,
 * and never on a host that has none. The direct fallback keeps older Cordis
 * shapes working. Neither path touches the MCP row — that row is the bundle
 * patch's, and registering a second `serverName: rea` here would be the exact
 * duplicate the shim warns about.
 */
export function apply(ctx) {
  if (!ctx) return
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (host) => mountGuideRoute(host))
      return
    } catch {
      /* fall through to the direct check */
    }
  }
  if (ctx.webServer) mountGuideRoute(ctx)
}
