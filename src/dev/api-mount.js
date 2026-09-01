import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

/**
 * Mount a site's own request handler in the dev server.
 *
 * A site that talks to a backend needs one running to be developed against, and
 * making that a live deployment is slow, costs money, and puts a shared database
 * behind a developer's experiments. So a site may name a **local handler** and the
 * dev server mounts it at the site's own service address:
 *
 * ```yaml
 * # site.yml
 * api: /_api                 # where the site's app backend answers
 * devApi: ./mock/api.js      # what answers it, in development only
 * ```
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
 * `devApi` is read by the dev plugin and by nothing else: no build reads it, no
 * `info` key carries it, and nothing writes it into a payload. A site's *address*
 * (`api:`) is authored config and travels; what answers that address locally is a
 * fact about one machine.
 *
 * ⚠️ **Same-origin on purpose.** Mounting inside the dev server means cookies and
 * `credentials: 'same-origin'` behave as they do in production, where a site's app
 * backend answers on the site's own origin. A handler on another port would work
 * too, and would exercise CORS and third-party-cookie rules that production does
 * not have — so a problem found that way might not be a real one.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {string} options.root - the site directory
 * @returns {Promise<boolean>} whether a handler was mounted
 */
export async function mountDevApi(server, { root }) {
  // ⛔ Read from the RAW site.yml, never from the collected `config`. `$`-prefixed
  // keys are stripped from the payload precisely because they are local to a
  // checkout — so the one place that needs this one goes to the file. That is the
  // rule working: if it were readable from `config`, it would also be published.
  let site
  try {
    site = yaml.load(await readFile(join(root, 'site.yml'), 'utf8')) || {}
  } catch {
    return false
  }

  const spec = site.$devApi
  if (!spec) return false

  const declared = site.api
  const mount = typeof declared === 'string' ? declared : declared?.endpoint
  if (!mount) {
    console.error("[dev-api] `$devApi` needs an `api:` address to answer on — add `api: /_api` to site.yml.")
    return false
  }

  let handler
  try {
    const loaded = await server.ssrLoadModule(pathToFileURL(resolve(root, spec)).href)
    handler = loaded?.default ?? loaded?.fetch
  } catch (err) {
    // ⚠️ Loud and specific. A dev API that silently fails to load looks exactly
    // like a backend that is refusing every request, and a developer debugs their
    // own client for an hour before finding a typo in a path.
    console.error(`[dev-api] could not load '${spec}': ${err.message}`)
    return false
  }
  if (typeof handler !== 'function') {
    console.error(`[dev-api] '${spec}' must default-export a function (request) => Response.`)
    return false
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
  return true
}
