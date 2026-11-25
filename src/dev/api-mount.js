import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { forwardRequest, problem } from './forward.js'

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
 * ## Or an address: a backend running on this machine
 *
 * ```yaml
 * $devBackend: http://localhost:1234/api   # forward /_api/* here
 * ```
 *
 * An `http:` or `https:` address instead of a module, and the dev server forwards each
 * request under `/_api` to it, `/_api/<rest>` → `<address>/<rest>` (`./forward.js`): the page
 * stays same-origin, so the backend needs no CORS, and a cookie it sets is kept first-party
 * on the dev server's origin. The developer writes the whole address, and nothing here
 * composes a route onto it. The request carries the address's origin as its `Origin`, the
 * origin a site's backend is reached from in production, where it answers on the site's own.
 *
 * A backend there holds the foundation's types as `register` stored them, `@<scope>/x`, so the
 * working copy is stamped with its scope, as a build is (`foundation/scope-define.js`, through
 * `DEV_BACKEND_ADDRESS_MARKER`), and sends full names. A module keeps `@/x`, which is how a
 * local mock holds them.
 *
 * ## And a backend's records, beside it
 *
 * ```yaml
 * $devBackend:
 *   backend: http://localhost:1234/api                          # as above
 *   records: http://localhost:1234/records/{locale}   # its public records
 * ```
 *
 * The map form names each service the backend answers, a whole address each. With `records`, the
 * dev server is the site's host: it answers the site's records itself, merging its record files
 * with the backend's public records (`./records-mount.js`). The string form is `backend` alone.
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

  const spec = devBackendParts(site.$devBackend).backend
  if (!spec) return null
  const mount = DEV_API_ADDRESS
  const address = devBackendAddress(spec)
  if (address) return mountDevAddress(server, address)

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
      // Bytes, never text: a handler may answer an image or a file, and reading it as
      // text decodes it as UTF-8, turning every byte above 127 into U+FFFD.
      const bytes = Buffer.from(await response.arrayBuffer())
      res.end(bytes.length ? bytes : undefined)
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 500, title: 'DevApiFailure', detail: err?.message }))
    }
  })

  console.log(`[dev-api] '${spec}' answering ${prefix}/*`)
  return mount
}

/**
 * The address `$devBackend` names, or null when it names a module.
 *
 * ⛔ A value with a scheme that isn't http(s) is refused rather than loaded as a path:
 * `localhost:1234/api` parses as the scheme `localhost:`, and loaded as a module it would fail
 * with a message about a file.
 *
 * @param {unknown} spec - `site.yml::$devBackend` as written
 * @returns {string|null}
 * @throws {Error} for an address that is not http(s)
 */
export function devBackendAddress(spec) {
  if (typeof spec !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null
  let url = null
  try {
    url = new URL(spec)
  } catch {
    // reported below
  }
  if (!url || !/^https?:$/.test(url.protocol) || !url.host) {
    throw new Error(
      `$devBackend: '${spec}' is neither a module path nor an http(s) address. ` +
        'Write a backend’s whole address, e.g. http://localhost:1234/api, or a module, e.g. ./mock/api.js.'
    )
  }
  return url.href.replace(/\/+$/, '')
}

/**
 * Whether the site at `root` forwards its `backend` service to an address in `uniweb dev`.
 * Read from the raw `site.yml`, as `mountDevApi` reads it.
 *
 * @param {string} root - the site directory
 * @returns {boolean}
 */
export function forwardsDevBackend(root) {
  try {
    const site = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
    return Boolean(devBackendAddress(devBackendParts(site.$devBackend).backend))
  } catch {
    return false
  }
}

/** `$devBackend: <address>` — forward the mount to it. Synchronous, as `mountDevApi` must be. */
function mountDevAddress(server, address) {
  const prefix = DEV_API_ADDRESS
  const origin = new URL(address).origin
  server.middlewares.use(async (req, res, next) => {
    if (!req.url || (req.url !== prefix && !req.url.startsWith(`${prefix}/`) && !req.url.startsWith(`${prefix}?`))) return next()
    // `/_api/x` → `<address>/x`, `/_api?q` → `<address>?q`, `/_api` → `<address>`
    const sent = await forwardRequest(req, res, `${address}${req.url.slice(prefix.length)}`, { origin })
    if (!sent.ok) {
      const err = sent.error
      problem(
        res,
        502,
        'Backend Unreachable',
        `$devBackend: could not reach ${address} (${err?.cause?.message || err.message}). Is the backend running?`
      )
    }
  })
  console.log(`[dev-api] ${prefix}/* → ${address}`)
  return prefix
}

/**
 * `$devBackend` as its parts: the string form is the `backend` service alone; the map form names
 * each service, `backend` and `records`.
 *
 * @param {unknown} value - `site.yml::$devBackend` as written
 * @returns {{ backend: string|null, records: string|null }}
 * @throws {Error} for a value that is neither, or a map with a key it doesn't take
 */
export function devBackendParts(value) {
  if (value === undefined || value === null || value === false || value === '') return { backend: null, records: null }
  if (typeof value === 'string') return { backend: value, records: null }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('$devBackend is a module, a backend\'s address, or a map of `backend:` and `records:` addresses.')
  }
  const unknown = Object.keys(value).filter((k) => k !== 'backend' && k !== 'records')
  if (unknown.length) {
    throw new Error(`$devBackend takes \`backend:\` and \`records:\`, not ${unknown.map((k) => `\`${k}:\``).join(', ')}.`)
  }
  return {
    backend: typeof value.backend === 'string' && value.backend ? value.backend : null,
    records: typeof value.records === 'string' && value.records ? value.records : null,
  }
}

/**
 * The backend's records address the site's `$devBackend` names, or null when it names none.
 * Read from the raw `site.yml`, as `mountDevApi` reads it.
 *
 * @param {string} root - the site directory
 * @returns {string|null}
 * @throws {Error} for an address that is not http(s), or has no `{locale}` slot
 */
export function devRecordsAddress(root) {
  let site
  try {
    site = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return null
  }
  const { records } = devBackendParts(site.$devBackend)
  if (!records) return null
  let url = null
  try {
    url = new URL(records.replace('{locale}', 'x'))
  } catch {
    // reported below
  }
  if (!url || !/^https?:$/.test(url.protocol) || !url.host) {
    throw new Error(`$devBackend.records: '${records}' is not an http(s) address. Write the backend's whole records address.`)
  }
  if (!records.includes('{locale}')) {
    throw new Error(`$devBackend.records: '${records}' has no {locale} slot, where each question's language goes.`)
  }
  return records
}

/**
 * The services a site's `site.yml` names, read from the raw file.
 *
 * @param {string} root - the site directory
 * @returns {string[]}
 */
export function siteServiceNames(root) {
  try {
    const site = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
    return site.services && typeof site.services === 'object' && !Array.isArray(site.services) ? Object.keys(site.services) : []
  } catch {
    return []
  }
}
