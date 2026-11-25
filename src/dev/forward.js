/**
 * Forward one dev-server request to a backend, as the page's own origin would reach it.
 *
 * Two mounts use it, and both exist so a page stays SAME-ORIGIN with what answers it:
 * `uniweb dev --published` (`./published-mount.js`), forwarding to a published site's services,
 * and `$devBackend: <address>` (`./api-mount.js`), forwarding the site's `backend` service to a
 * backend running on the developer's machine. A sign-in cookie is then first-party on the dev
 * server's origin, and nothing exercises CORS or third-party-cookie rules production does not have.
 *
 * ⭐ The request goes with its method, body and headers, and with `origin` as its `Origin`: the
 * origin a request reaches the backend from in production, where the backend answers on the
 * site's own origin. The dev server's own `Host` and `Referer` stay behind, and so does
 * `Accept-Encoding`, because the answer is read whole and handed on decoded. A redirect is handed
 * to the browser as it came.
 *
 * ⭐ A cookie the backend sets is kept on the dev server's origin (`firstPartyCookie`).
 *
 * ⚠️ The answer is read whole before it is sent on, so a streamed one arrives at its end.
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} target - the whole address to send to
 * @param {object} options
 * @param {string} options.origin - the `Origin` the request carries, when it carries one
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{ ok: true } | { ok: false, error: Error }>} not ok when the backend could not be reached; nothing has been written to `res` then
 */
export async function forwardRequest(req, res, target, { origin, fetch: send = globalThis.fetch }) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || NOT_SENT.has(key)) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  if (headers.has('origin')) headers.set('origin', origin)
  const init = { method: req.method, headers, redirect: 'manual' }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length) init.body = Buffer.concat(chunks)
  }

  let response
  try {
    response = await send(target, init)
  } catch (error) {
    return { ok: false, error }
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
  return { ok: true }
}

/**
 * A cookie the backend set, for the dev server's origin: no `Domain`, the whole path, and,
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

/** An answer the dev server gives itself, in the shape a backend's refusal has. */
export function problem(res, status, title, detail) {
  res.statusCode = status
  res.setHeader('content-type', 'application/problem+json')
  res.end(JSON.stringify({ status, title, detail }))
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const NOT_SENT = new Set([...HOP_BY_HOP, 'host', 'referer', 'content-length', 'accept-encoding'])
// `fetch` hands the body on decoded, so its length and encoding are no longer the answer's.
const NOT_RETURNED = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding'])
