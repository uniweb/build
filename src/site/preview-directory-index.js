/**
 * ⭐ `vite preview` SERVES A PAGE'S FOLDER FOR ITS URL WITHOUT THE SLASH — as the hosts a site
 * deploys to do. A build writes each page as `<route>/index.html`, and GitHub Pages, Cloudflare
 * Pages, Netlify and Vercel answer `/fr/a-propos` with `fr/a-propos/index.html` (the S3 + CloudFront
 * adapter ships a function for it, `../hosts/s3-cloudfront.js`).
 *
 * `vite preview` answers it with the site's ROOT document instead: its SPA fallback serves
 * `index.html` for any path with no file of its own. That document carries the default locale's
 * content, so a translated page asked for without the slash rendered the not-found page once the
 * runtime took over — the French URL resolved against English content — and every other page got
 * the home page's prerender under its own URL. ⛔ So until 2026-10-01 the preview of a build showed
 * what no host it deploys to does.
 *
 * Only an existing folder with an `index.html` is answered, and a `<route>.html` beside it wins, as
 * on those hosts. Everything else goes to Vite unchanged.
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * The URL `vite preview` should serve for a request: its folder's `index.html`, or null to leave the
 * request alone.
 *
 * @param {{ method?: string, url?: string }} req
 * @param {string} outDir - the build's output directory, absolute
 * @param {string} [base] - the site's deployment base (`/`, `/docs/`)
 * @returns {string|null}
 */
export function directoryIndexUrl(req, outDir, base = '/') {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const url = req.url || ''
  const queryAt = url.indexOf('?')
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
  const query = queryAt === -1 ? '' : url.slice(queryAt)

  const mount = base.endsWith('/') ? base : `${base}/`
  if (pathname.endsWith('/') || !pathname.startsWith(mount)) return null

  let route
  try {
    route = decodeURIComponent(pathname.slice(mount.length - 1))
  } catch {
    return null
  }

  const dir = join(outDir, route)
  if (dir !== outDir && !dir.startsWith(outDir + sep)) return null
  if (existsSync(`${dir}.html`)) return null
  if (!existsSync(join(dir, 'index.html')) || !statSync(dir).isDirectory()) return null
  return `${pathname}/index.html${query}`
}

/** The plugin: a middleware ahead of Vite's own, in `vite preview` only. */
export function previewDirectoryIndexPlugin() {
  return {
    name: 'uniweb:preview-directory-index',
    configurePreviewServer(server) {
      const { root, base, build } = server.config
      const outDir = resolve(root, build.outDir)
      server.middlewares.use((req, _res, next) => {
        const target = directoryIndexUrl(req, outDir, base)
        if (target) req.url = target
        next()
      })
    },
  }
}
