/**
 * Emit a workspace extension's built code into the site's own output.
 *
 * ── The gap this closes ──
 *
 * A site declares an extension by URL. The site-relative form —
 * `extensions: ['/effects/entry.js']` — means "served from this site's own
 * origin", and it is what the `extensions` template ships. But nothing ever put
 * the file there.
 *
 * The result was a build that succeeds and a site that is wrong: prerender
 * loads the extension from the workspace (via `resolveExtensionPath`) and
 * renders its sections into the static HTML, then the browser fetches
 * `/effects/entry.js`, gets a 404, `loadExtensions()` drops it, and hydration
 * REPLACES the correct markup with `Component not found`. A visitor watches a
 * working section break. Measured on the `extensions` template, 2026-08-05.
 *
 * ── Why here ──
 *
 * The build is the only party that knows both the declared URL and where the
 * extension's `dist/` actually is, and the site's output is the only place the
 * two can meet. This is the emission half of "site-hosted linked" — the shape
 * the model doc lists as producible only by hand.
 *
 * ── What is emitted, and what is not ──
 *
 * The BROWSER delivery set. A foundation's `dist/` also carries things only
 * other consumers want, and a static host should not serve them:
 *
 *   entry.js, assets/**       → emitted; the browser loads these
 *   entry-ssr.js              → skipped; the single-file SSR twin, for an
 *                               isolate that loads one module. Nothing on a
 *                               static host reads it.
 *   meta/**                   → skipped; the editor schema. Authoring-time, and
 *                               not something to publish to visitors.
 *   runtime-pin.json          → skipped; build provenance, read by no browser.
 *   *.map                     → skipped; dev-only.
 *
 * Same browser/internal split the runtime's distribution channel draws, for the
 * same reason: what a visitor fetches and what a renderer needs are different
 * sets, and only one of them belongs on a public origin.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** True for the `/effects/entry.js` form — the only one this site can serve. */
export function isSiteRelative(decl) {
  const url = typeof decl === 'string' ? decl : decl?.url
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
}

/** Every file under `dir`, relative to it. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)]
  })
}

/** Is this file part of what a browser fetches? */
function isBrowserAsset(rel) {
  if (rel.endsWith('.map')) return false
  if (rel === 'runtime-pin.json') return false
  if (rel.startsWith('meta/') || rel.startsWith(`meta\\`)) return false
  if (/(^|[/\\])entry-ssr\.js$/.test(rel)) return false
  return true
}

/**
 * Locate the built `dist/` behind a site-relative extension URL.
 *
 * The same candidates `resolveExtensionPath` walks for prerender, kept in step
 * deliberately: if prerender can load an extension from the workspace but the
 * build cannot find it to emit, that is exactly the split that produced the
 * bug — one lane resolving it and the other not.
 *
 * @returns {{ distDir: string, urlBase: string }|null}
 */
export function resolveExtensionDist(url, siteDir) {
  const parts = url.replace(/^\//, '').split('/')
  if (parts.length < 2) return null
  const pkgName = parts[0]
  const projectRoot = resolve(siteDir, '..')

  for (const candidate of [
    join(projectRoot, pkgName, 'dist'),
    join(projectRoot, 'extensions', pkgName, 'dist')
  ]) {
    if (existsSync(candidate)) return { distDir: candidate, urlBase: pkgName }
  }
  return null
}

/**
 * Files to emit for a site's declared extensions.
 *
 * Returns `{ fileName, source }` pairs for Rollup's `emitFile`, plus the
 * declarations that could not be resolved — the caller warns about those rather
 * than failing, because an absolute-URL extension is legitimately not ours to
 * emit and a missing workspace build is a warning the developer can act on.
 *
 * @param {Array} extensions - `site.yml::extensions`, as declared.
 * @param {string} siteDir - the site package directory.
 */
export function collectExtensionAssets(extensions, siteDir) {
  const emit = []
  const unresolved = []
  if (!Array.isArray(extensions)) return { emit, unresolved }

  for (const decl of extensions) {
    if (!isSiteRelative(decl)) continue // absolute URL or a ref — someone else serves it
    const url = typeof decl === 'string' ? decl : decl.url
    const found = resolveExtensionDist(url, siteDir)
    if (!found) {
      unresolved.push(url)
      continue
    }
    for (const rel of walk(found.distDir)) {
      if (!isBrowserAsset(rel)) continue
      emit.push({
        fileName: `${found.urlBase}/${rel.split('\\').join('/')}`,
        source: readFileSync(join(found.distDir, rel))
      })
    }
  }
  return { emit, unresolved }
}
