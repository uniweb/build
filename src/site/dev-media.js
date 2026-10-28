/**
 * WHERE `uniweb dev` SERVES EACH MEDIA FILE A SITE NAMES — so dev shows the file a build ships.
 *
 * A build resolves each local media reference (`resolveAssetPath`, `./assets.js`) and rewrites it
 * to the copy it makes (`processAssets`, `rewriteSiteContentPaths`). Dev runs neither, so a
 * reference stayed as written and only one into `public/` reached its file: `./photo.png` was read
 * against the page's URL, and `/clip.mp4` — `assets/clip.mp4` to a build — named nothing the dev
 * server held. Both were answered with the site's HTML, and a 200 (measured 2026-10-28).
 *
 * So dev rewrites each reference the collector resolved — the same manifest, the same rewrite — to
 * where the dev server serves its file: one in `public/` at the site's base, one under the root by
 * its path from the root, and any other (a mounted folder's) through Vite's `/@fs/`.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {Object} assets - the collector's manifest: each reference as written → `{ resolved }`
 * @param {{ root: string, publicDir?: string|null, base?: string }} server - the dev server's
 *   root and public directory, and the site's base
 * @returns {Object} each reference whose file exists → the address that serves it
 */
export function devMediaPaths(assets, { root, publicDir = null, base = '/' }) {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const mapping = {}
  for (const [ref, entry] of Object.entries(assets || {})) {
    const file = entry?.resolved
    if (typeof file !== 'string' || !existsSync(file)) continue
    const address = addressOf(file, { root, publicDir, prefix })
    if (address !== ref) mapping[ref] = address
  }
  return mapping
}

function addressOf(file, { root, publicDir, prefix }) {
  for (const dir of [publicDir, root]) {
    const below = dir ? pathBelow(dir, file) : null
    if (below) return prefix + below.split(sep).map(encodeURIComponent).join('/')
  }
  return `${prefix}@fs${pathToFileURL(file).pathname}`
}

/** `file`'s path below `dir`, or null when it is not inside it. */
function pathBelow(dir, file) {
  const rel = relative(dir, file)
  return rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..' ? rel : null
}
