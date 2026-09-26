/**
 * A PREVIEW FETCHES THE MEDIA ITS BACKEND SERVES — from that backend.
 *
 * A clone keeps a serve URL wherever the backend held one the pull cannot map back to an author's
 * file — a record's image, a param (`uwx/asset-map.js::restoreAssetRefs`: *"the URL that works"*).
 * A root-relative one names a file on the origin that served the document holding it. On the dev
 * server's origin it names nothing, and a dev server answers a path it lacks with `index.html` —
 * so the image broke with a 200.
 *
 * So in a preview (`./preview.js`), a request for media the site does not hold is answered by the
 * backend the site is on. ⭐ Nothing is composed: the path is the URL the content holds, resolved
 * against the origin it came from. ⛔ Only media — a request whose destination is an image, a video,
 * audio, a track or a font — and only what the site does not hold, in `public/` or under its root:
 * the site's own files, its routes and Vite's own paths are never sent anywhere. The request carries
 * no credential; a served asset is public.
 */
import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

const MEDIA_DESTINATIONS = new Set(['image', 'video', 'audio', 'track', 'font'])

/**
 * @param {{ backend: string, siteRoot: string }} options - the backend's origin (`readPreview`)
 * @returns {import('vite').Plugin}
 */
export function previewMediaPlugin({ backend, siteRoot }) {
  return {
    name: 'uniweb:preview-media',
    apply: 'serve',
    configureServer(server) {
      // Registered before Vite's own middlewares, whose SPA fallback would answer first.
      server.middlewares.use(async (req, res, next) => {
        const pathname = mediaPath(req)
        if (!pathname) return next()
        const base = server.config.base || '/'
        const local = [pathname]
        if (base !== '/' && pathname.startsWith(base)) local.push('/' + pathname.slice(base.length))
        const roots = [server.config.publicDir, siteRoot].filter(Boolean)
        if (local.some((p) => roots.some((root) => holds(root, p)))) return next()

        let upstream
        try {
          upstream = await fetch(new URL(req.url, backend), { method: req.method, redirect: 'follow' })
        } catch (err) {
          res.statusCode = 502
          return res.end(`The site's backend (${backend}) did not answer: ${err.message}`)
        }
        // Its answer, whatever it is — a 404 here is the backend not having it either, which
        // is the truth; falling through would answer `index.html`.
        res.statusCode = upstream.status
        for (const header of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
          const value = upstream.headers.get(header)
          if (value) res.setHeader(header, value)
        }
        if (req.method === 'HEAD' || !upstream.body) return res.end()
        Readable.fromWeb(upstream.body).pipe(res)
      })
    }
  }
}

/** The root-relative path a media request names, or null for any other request. */
export function mediaPath(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const dest = req.headers['sec-fetch-dest']
  const accept = String(req.headers.accept || '')
  const media = dest ? MEDIA_DESTINATIONS.has(dest) : /^(image|video|audio)\//.test(accept)
  if (!media) return null
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://preview.invalid').pathname)
  } catch {
    return null
  }
  // Vite's own paths are never the backend's.
  if (/^\/(@|node_modules\/|__)/.test(pathname)) return null
  return pathname
}

/** Whether a file lies at `pathname` under `root`, and inside it. */
function holds(root, pathname) {
  const file = normalize(join(root, pathname))
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) return false
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch {
    return false
  }
}
