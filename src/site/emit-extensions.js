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
 *
 * ⛔ The emitted copy is the BROWSER's, and only the browser's. Prerender imports
 * the extension from its own build (`resolveExtensionPath`), because the copy
 * sits under the site package, where the extension's bare imports
 * (`@uniweb/core`, `react`) do not resolve.
 *
 * ── Which folder is the extension ──
 *
 * Not decided here: `./workspace-extension.js` holds the rule, and the dev
 * server, prerender and the CLI ask it too.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { extensionNameOf, findExtensionPackage } from './workspace-extension.js'
import { stripBasePath } from './extension-urls.js'

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

/** Is this file part of what a browser fetches? The dev server serves the same set. */
export function isBrowserAsset(rel) {
  if (rel.endsWith('.map')) return false
  if (rel === 'runtime-pin.json') return false
  if (rel.startsWith('meta/') || rel.startsWith(`meta\\`)) return false
  if (/(^|[/\\])entry-ssr\.js$/.test(rel)) return false
  return true
}

/**
 * Locate the workspace extension behind a site-relative extension URL —
 * `/effects/entry.js` → the folder `./workspace-extension.js` finds for
 * `effects` — with `distDir` its build and `rest` the path inside it.
 *
 * One lookup for both lanes that need the extension's build: this emitter, which
 * copies it into the site's output, and prerender, which imports it from where it
 * was built (`resolveExtensionPath`). Neither can find an extension the other
 * cannot, by construction rather than by two lists kept in step by hand.
 *
 * @param {string} url - a site-relative URL, with any deployment base removed
 * @param {string} projectRoot - the folder the site is in; the search starts
 *   there and climbs to the workspace root
 * @returns {{ distDir: string, urlBase: string, rest: string, packageDir: string, built: boolean }|null}
 *   null when no workspace extension has that name; `built: false` when one does
 *   and has no `dist/` yet
 */
export function resolveExtensionDist(url, projectRoot) {
  const named = extensionNameOf(url)
  if (!named) return null
  const packageDir = findExtensionPackage(named.name, projectRoot)
  if (!packageDir) return null
  const distDir = join(packageDir, 'dist')
  return { distDir, urlBase: named.name, rest: named.rest, packageDir, built: existsSync(distDir) }
}

/**
 * Files to emit for a site's declared extensions.
 *
 * Returns `{ fileName, source }` pairs for Rollup's `emitFile`, plus what could
 * not be emitted, for the caller to warn about rather than fail on: an
 * absolute-URL extension is legitimately not ours to emit, and a missing or
 * unbuilt workspace extension is something the developer can act on.
 *
 * @param {Array} extensions - the payload's `config.extensions`.
 * @param {string} siteDir - the site package directory.
 * @param {{ base?: string }} [options] - `base`: the deployment base the payload's
 *   URLs carry. `dist/` has no base segment, so it is removed before the URL names
 *   a folder — with `/docs/` left on, `/docs/effects/entry.js` named an extension
 *   `docs`, and a site deployed under a subpath emitted none.
 * @returns {{ emit: Array<{ fileName: string, source: Buffer }>, unresolved: string[],
 *   unbuilt: Array<{ url: string, dir: string }> }}
 */
export function collectExtensionAssets(extensions, siteDir, { base } = {}) {
  const emit = []
  const unresolved = []
  const unbuilt = []
  if (!Array.isArray(extensions)) return { emit, unresolved, unbuilt }
  const projectRoot = resolve(siteDir, '..')

  for (const decl of extensions) {
    if (!isSiteRelative(decl)) continue // absolute URL or a ref — someone else serves it
    const url = typeof decl === 'string' ? decl : decl.url
    const found = resolveExtensionDist(stripBasePath(url, base), projectRoot)
    if (!found) {
      unresolved.push(url)
      continue
    }
    if (!found.built) {
      unbuilt.push({ url, dir: found.packageDir })
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
  return { emit, unresolved, unbuilt }
}
