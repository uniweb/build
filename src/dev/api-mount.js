import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/**
 * Where `uniweb dev` answers the site's `backend` service when `$devBackend` names a handler.
 * The dev server is the host here, so the address is its own.
 */
export const DEV_API_ADDRESS = '/_api'

/**
 * Mount a site's own request handler in the dev server.
 *
 * A site that talks to a backend needs one running to be developed against, and
 * making that a live deployment is slow, costs money, and puts a shared database
 * behind a developer's experiments. So a site may name a **local handler**, and in
 * `uniweb dev` the dev server answers the site's `backend` service with it:
 *
 * ```yaml
 * # site.yml
 * services:
 *   backend: true              # ask your host for it (in production)
 * $devBackend: ./mock/api.js   # what answers it in `uniweb dev`, at /_api
 * ```
 *
 * ⭐ THE DEV SERVER SUPPLIES THE ADDRESS [Diego, 2026-10-06]. In `uniweb dev` it is
 * the host, so where it answers is its own to choose — `DEV_API_ADDRESS` — and the
 * plugin puts that address in the dev payload's `config.backend`, the site tier
 * `resolveService` reads when no host speaks. ⛔ *Until then the site wrote it, as a
 * top-level `api: /_api` "the same in development and in production" — an address
 * that, under `services:`, would read as "the site brings its own backend" and ask the
 * host to turn its own off.* ⛔ *And until 2026-10-07 the service was `api` and this
 * key `$devApi`; both are refused by those names now — `services.api` by
 * `refuseUnreadableServices`, `$devApi` by `refuseRetiredServiceKeys`.*
 *
 * ```js
 * // mock/api.js — default-export a fetch handler
 * export default (request) => new Response('{}', { headers: { 'content-type': 'application/json' } })
 * ```
 *
 * ## ⭐ The framework mounts; the site supplies
 *
 * This knows nothing about what it is mounting — not the routes, not the shapes,
 * not which backend is being imitated. It takes a `Request` handler and puts it on
 * a path. ⛔ **That is deliberate and load-bearing:** the moment the framework
 * knows what a "mock backend" is, it has a favourite one, and a site talking to
 * something else is a second-class citizen in its own dev server. A handler is the
 * whole contract, and anything that can produce one — a hand-written stub, a
 * recorded fixture, someone's real service in a function — mounts the same way.
 *
 * ## ⛔ Development only, and it cannot leak
 *
 * `$devBackend` is read by the dev plugin and by nothing else: no build reads it, no
 * `info` key carries it, and only the dev server's payload names its address. What
 * answers the site's `backend` service locally is a fact about one machine.
 *
 * ⚠️ **Same-origin on purpose.** Mounting inside the dev server means cookies and
 * `credentials: 'same-origin'` behave as they do in production, where a site's app
 * backend answers on the site's own origin. A handler on another port would work
 * too, and would exercise CORS and third-party-cookie rules that production does
 * not have — so a problem found that way might not be a real one.
 *
 * ## ⛔ Registered SYNCHRONOUSLY, and that is not a style choice
 *
 * Vite adds middleware registered during `configureServer` BEFORE its own — but
 * only what is registered before that hook returns. An `await` first, and the
 * middleware lands after the SPA fallback, which answers every path with
 * `index.html`: the API returns a 200 of HTML, the client fails to parse it, and
 * nothing in the log says why. So the config is read with `readFileSync` and the
 * middleware goes on the stack immediately; only the module load is deferred, and
 * the middleware awaits it on the first request.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {string} options.root - the site directory
 * @returns {string|null} the address the handler answers on, or null when none was mounted
 */
export function mountDevApi(server, { root }) {
  // ⛔ Read from the RAW site.yml, never from the collected `config`. `$`-prefixed
  // keys are stripped from the payload precisely because they are local to a
  // checkout — so the one place that needs this one goes to the file. That is the
  // rule working: if it were readable from `config`, it would also be published.
  let site
  try {
    site = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return null
  }

  const spec = site.$devBackend
  if (!spec) return null
  const mount = DEV_API_ADDRESS

  // Loaded once, lazily, and awaited by the middleware. ⚠️ Loud and specific on
  // failure: a dev API that silently fails to load looks exactly like a backend
  // refusing every request, and a developer debugs their own client for an hour
  // before finding a typo in a path.
  let loading = null
  const getHandler = () => {
    if (!loading) {
      loading = server
        .ssrLoadModule(pathToFileURL(resolve(root, spec)).href)
        .then((loaded) => {
          const handler = loaded?.default ?? loaded?.fetch
          if (typeof handler !== 'function') {
            throw new Error(`'${spec}' must default-export a function (request) => Response`)
          }
          return handler
        })
        .catch((err) => {
          console.error(`[dev-api] could not load '${spec}': ${err.message}`)
          throw err
        })
    }
    return loading
  }

  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount

  server.middlewares.use(async (req, res, next) => {
    if (!req.url || (req.url !== prefix && !req.url.startsWith(`${prefix}/`))) return next()

    // The handler sees the path WITHOUT the mount point: where a site chooses to
    // expose its backend is the site's business, and a handler written against one
    // deployment's prefix would not survive another's.
    const inner = req.url.slice(prefix.length) || '/'
    const origin = `http://${req.headers.host || 'localhost'}`
    const init = { method: req.method, headers: req.headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      if (chunks.length) init.body = Buffer.concat(chunks)
    }

    try {
      const handler = await getHandler()
      const response = await handler(new Request(new URL(inner, origin), init))
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      const text = await response.text()
      res.end(text || undefined)
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 500, title: 'DevApiFailure', detail: err?.message }))
    }
  })

  console.log(`[dev-api] '${spec}' answering ${prefix}/*`)
  return mount
}
