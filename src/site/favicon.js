/**
 * A static build's icons (`plugin.js` links them). The favicon: `site.yml`'s `favicon:`, else the
 * first of these in the site's public folder. A site sent to a Uniweb host has no such fallback —
 * its pages link only the favicon `favicon:` names, and only that file is uploaded — so
 * `uniweb doctor` reads this same list to say when a site has an icon on one lane and none on the
 * other. The touch icon — the PNG iOS puts on a home screen — is `site.yml`'s `touchIcon:`, and
 * only that: nothing is looked for.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FAVICON_FILES = ['favicon.svg', 'favicon.ico', 'favicon.png']

/**
 * @param {string|null|undefined} publicDir
 * @returns {string|null} the file name the build would link (`favicon.svg`), or null
 */
export function findPublicFavicon(publicDir) {
  if (!publicDir) return null
  return FAVICON_FILES.find((name) => existsSync(resolve(publicDir, name))) || null
}

/**
 * The href a static build links its favicon at. A named site path (`/favicon.ico`) and a found file
 * are both the site's own, served under its base like every other file of its own
 * (`asset-processor-base.test.js`); an address of its own is linked as written. ⛔ Until 2026-10-27
 * a named favicon was linked as written, so under a base (a GitHub Pages project site's `/repo/`)
 * a site that named its favicon linked one directory too high, while one the build found did not.
 *
 * @param {unknown} named - `site.yml`'s `favicon:`
 * @param {string|null|undefined} publicDir
 * @param {string} [basePath] - the deployment base (`/`, `/repo/`)
 * @returns {string|null}
 */
export function faviconHref(named, publicDir, basePath) {
  const href = siteHref(named, basePath)
  if (href) return href
  const found = findPublicFavicon(publicDir)
  return found ? siteHref(`/${found}`, basePath) : null
}

/**
 * The href a static build links its touch icon at — `site.yml`'s `touchIcon:`, under the base as
 * the favicon is.
 *
 * @param {unknown} named
 * @param {string} [basePath]
 * @returns {string|null}
 */
export function touchIconHref(named, basePath) {
  return siteHref(named, basePath)
}

/** A site path under the deployment base; an address of its own as written; null for none. */
function siteHref(named, basePath) {
  const href = typeof named === 'string' ? named.trim() : ''
  if (!href) return null
  const base = (basePath || '/').replace(/\/$/, '')
  return href.startsWith('/') && !href.startsWith('//') ? `${base}${href}` : href
}
