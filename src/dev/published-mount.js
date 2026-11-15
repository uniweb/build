import { PUBLISHED_MOUNT } from '../site/published.js'

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

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || NOT_SENT.has(key)) continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    if (headers.has('origin')) headers.set('origin', siteOrigin)
    const init = { method: req.method, headers, redirect: 'manual' }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      if (chunks.length) init.body = Buffer.concat(chunks)
    }

    let response
    try {
      response = await send(`${origin}${rest}`, init)
    } catch (err) {
      return problem(res, 502, 'Published Site Unreachable', `Could not reach ${origin}: ${err?.cause?.message || err.message}`)
    }
    res.statusCode = response.status
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie' && !NOT_RETURNED.has(key)) res.setHeader(key, value)
    })
    const cookies = response.headers.getSetCookie?.() ?? []
    if (cookies.length) {
      const secure = Boolean(req.socket?.encrypted)
      res.setHeader('set-cookie', cookies.map((cookie) => firstPartyCookie(cookie, { secure })))
    }
    // Bytes, never text: an answer may be an image or a file.
    const bytes = Buffer.from(await response.arrayBuffer())
    res.end(bytes.length ? bytes : undefined)
  })

  const names = Object.keys(targets)
  log(
    names.length
      ? `[dev-published] ${names.map((n) => `${PUBLISHED_MOUNT}/${n}`).join(', ')} → the site as published at ${siteOrigin}`
      : `[dev-published] the site published at ${siteOrigin} offers no service with an address`
  )
}

/**
 * A cookie the published site set, for the dev server's origin: no `Domain`, the whole path, and,
 * over plain http, no `Secure` — so `SameSite=None`, which needs it, becomes `Lax`, the
 * first-party default — unless its name requires `Secure`.
 *
 * @param {string} cookie - one `Set-Cookie` value
 * @param {{ secure: boolean }} options - whether the dev server is reached over https
 * @returns {string}
 */
export function firstPartyCookie(cookie, { secure }) {
  const [pair, ...attributes] = cookie.split(';')
  const name = pair.split('=')[0].trim()
  const keepSecure = secure || /^__(Host|Secure)-/.test(name)
  const kept = []
  for (const raw of attributes) {
    const attribute = raw.trim()
    const key = attribute.split('=')[0].trim().toLowerCase()
    if (!attribute || key === 'domain' || key === 'path') continue
    if (!keepSecure && (key === 'secure' || key === 'partitioned')) continue
    if (!keepSecure && key === 'samesite' && /=\s*none\s*$/i.test(attribute)) {
      kept.push('SameSite=Lax')
      continue
    }
    kept.push(attribute)
  }
  return [pair.trim(), 'Path=/', ...kept].join('; ')
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const NOT_SENT = new Set([...HOP_BY_HOP, 'host', 'referer', 'content-length', 'accept-encoding'])
// `fetch` hands the body on decoded, so its length and encoding are no longer the answer's.
const NOT_RETURNED = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding'])

function problem(res, status, title, detail) {
  res.statusCode = status
  res.setHeader('content-type', 'application/problem+json')
  res.end(JSON.stringify({ status, title, detail }))
}

/** A request may still carry the site's base path; the address is the dev server's own. */
function withoutBase(url, base) {
  const prefix = String(base || '/').replace(/\/+$/, '')
  return prefix && (url === prefix || url.startsWith(`${prefix}/`)) ? url.slice(prefix.length) || '/' : url
}
