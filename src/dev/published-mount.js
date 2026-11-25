import { PUBLISHED_MOUNT } from '../site/published.js'
import { forwardRequest, problem } from './forward.js'

// Re-exported: it was first written here, for this mount.
export { firstPartyCookie } from './forward.js'

/**
 * `uniweb dev --published` — the dev server answers a published site's services at addresses of
 * its own and forwards each request to the published address (`../site/published.js` has the
 * contract and how the addresses are made).
 *
 * ⭐ Same-origin on purpose, as `mountDevApi` is. The page asks the dev server, so a session
 * cookie the published site's backend sets is first-party on the dev server's origin, and nothing
 * exercises CORS or third-party-cookie rules the published site does not have. A cookie is kept
 * on the dev server's origin, for its whole path, and loses `Secure` over plain http, where a
 * browser could drop it — except a `__Host-` or `__Secure-` cookie, whose name requires it.
 *
 * ⭐ The request goes as the published page would send it: its method, body and headers, with the
 * published page's origin as its `Origin`, since that is the page a visitor's request comes from.
 * The dev server's own `Host` and `Referer` stay behind, and so does `Accept-Encoding`, because
 * the answer is read whole and handed on decoded. A redirect is handed to the browser as it came.
 *
 * ⚠️ The answer is read whole before it is sent on, so a streamed one arrives at its end.
 *
 * ⛔ Registered SYNCHRONOUSLY, like `mountDevApi`: Vite runs the middleware registered before
 * `configureServer` returns ahead of its SPA fallback, which would answer every address with
 * `index.html`.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {Record<string, string>} options.targets - service → the origin it forwards to (`localServices`)
 * @param {string} options.site - the published page's address
 * @param {string} [options.base] - the dev site's base path, which a request may still carry
 * @param {typeof fetch} [options.fetch] - injected in tests
 * @param {(line: string) => void} [options.log]
 */
export function mountPublished(server, { targets, site, base = '/', fetch: send = globalThis.fetch, log = console.log }) {
  const siteOrigin = new URL(site).origin

  server.middlewares.use(async (req, res, next) => {
    const url = withoutBase(req.url || '', base)
    if (!url.startsWith(`${PUBLISHED_MOUNT}/`)) return next()
    const after = url.slice(PUBLISHED_MOUNT.length + 1)
    const cut = after.search(/[/?]/)
    const name = cut === -1 ? after : after.slice(0, cut)
    const rest = cut === -1 ? '/' : after[cut] === '?' ? `/${after.slice(cut)}` : after.slice(cut)
    const origin = targets[name]
    if (!origin) {
      return problem(res, 404, 'No Such Service', `The site published at ${siteOrigin} offers no ${name} service.`)
    }

    const sent = await forwardRequest(req, res, `${origin}${rest}`, { origin: siteOrigin, fetch: send })
    if (!sent.ok) {
      const err = sent.error
      return problem(res, 502, 'Published Site Unreachable', `Could not reach ${origin}: ${err?.cause?.message || err.message}`)
    }
  })

  const names = Object.keys(targets)
  log(
    names.length
      ? `[dev-published] ${names.map((n) => `${PUBLISHED_MOUNT}/${n}`).join(', ')} → the site as published at ${siteOrigin}`
      : `[dev-published] the site published at ${siteOrigin} offers no service with an address`
  )
}

/** A request may still carry the site's base path; the address is the dev server's own. */
function withoutBase(url, base) {
  const prefix = String(base || '/').replace(/\/+$/, '')
  return prefix && (url === prefix || url.startsWith(`${prefix}/`)) ? url.slice(prefix.length) || '/' : url
}
