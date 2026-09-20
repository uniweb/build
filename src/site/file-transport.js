/**
 * A `fetch`-shaped transport over the files this build has already produced.
 *
 * ⭐ **Why a transport rather than a reader.** The render's data step
 * (`@uniweb/runtime/ssr::loadPageData`) asks for what a page's render will read, by the rule the
 * render itself uses, and dispatches every request through one function the caller supplies. A host
 * gives it the network; this lane gives it `dist/` and `public/`. So the build asks the same
 * question as every other lane and only the answering differs — which is the whole point of
 * `kb/framework/plans/what-a-page-needs.md`.
 *
 * ⛔ **A remote `url:` is still the browser's lane by default.** Nothing here decides that: the
 * author's `prerender:` does, and the step is run with `prerender: 'author'` so a deferred request
 * is never dispatched. One that IS asked for at build time is fetched the way a browser would.
 *
 * ⚖️ **`dist/` first, then `public/`** — a non-default locale's data is written under
 * `dist/{locale}/data/…` and the resolver localizes the path, so the localized address is found
 * where it was written; everything else sits in `public/`, which is where the query processor
 * compiles a query's file.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The site-relative path an address names, with the site's base removed. */
function pathOf(target, base) {
  const clean = String(target).split('#')[0]
  if (!base || base === '/') return clean
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base
  return clean.startsWith(prefix) ? clean.slice(prefix.length) || '/' : clean
}

const response = (body, contentType) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
  json: async () => JSON.parse(body),
  text: async () => body,
})

const missing = (path) => ({
  ok: false,
  status: 404,
  statusText: `no file for ${path}`,
  headers: { get: () => 'text/plain' },
  json: async () => null,
  text: async () => '',
})

/**
 * @param {Object} where
 * @param {string} where.siteRoot - the site directory
 * @param {string|null} [where.distDir] - its build output, searched first
 * @param {string} [where.publicDir] - the static directory under `siteRoot`
 * @param {string} [where.base] - the site's base path, which addresses carry and files do not
 * @returns {(input: *, init?: Object) => Promise<Object>} a `fetch`
 */
export function createFileTransport({ siteRoot, distDir = null, publicDir = 'public', base = '' }) {
  const roots = [distDir, join(siteRoot, publicDir)].filter(Boolean)

  return async function fileTransport(input, init) {
    const target = String(input?.url ?? input)
    // Absolute: a remote address, fetched as the browser would.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return globalThis.fetch(target, init)

    const path = pathOf(target, base)
    for (const root of roots) {
      const file = join(root, path)
      if (!existsSync(file)) continue
      const body = await readFile(file, 'utf8')
      return response(body, path.endsWith('.json') ? 'application/json' : 'text/plain')
    }
    // ⚖️ Not an error here. A page can ask for a per-record file a `deferred:` query never wrote,
    // and the step reports the outcome so the caller can see it rather than crash a build.
    return missing(path)
  }
}
