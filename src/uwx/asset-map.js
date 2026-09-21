/**
 * Asset reference helpers — two pure functions, no file.
 *
 * ⚠️ **The MAP moved to `sync.json` on 2026-09-20** (`sync-store.js`,
 * `backends.<origin>.assets`). It lived here as `assets.json`, a single flat
 * `local path → id` file that assumed ONE backend — which is exactly what it
 * could not represent once a project syncs with several: an id is minted by a
 * backend and means nothing to any other one. `readAssetMap` / `updateAssetMap` /
 * `refForAssetId` / `ASSET_MAP_FILE` went with it.
 *
 * What stays here is what never touched the filesystem:
 *
 * - **`servedFingerprint`** — hashes a serve URL. It exists for references that are
 *   a BARE STRING (`info.preview`, `seo.image`, a section param), where there is no
 *   object to stamp an id beside, so the stored value is the address alone. ⛔ A
 *   fingerprint rather than the URL because a hash can RECOGNIZE an address and
 *   cannot COMPOSE one — route layout is the host's and never ours to rebuild.
 * - **`restoreAssetRefs`** — puts an author's own paths back into a document pulled
 *   from a backend. Without it a push/pull cycle rewrites every image in a
 *   developer's source to a backend route: a mangling of files they own, by a round
 *   trip that changed nothing.
 *
 * ⭐ **`restoreAssetRefs` no-ops on an empty map**, which is what makes the store's
 * `backend` parameter honest: a projection not tied to a backend has no known
 * assets, so it restores nothing rather than guessing.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { ASSET_SLOTS } from '@uniweb/semantic-parser'

/**
 * The fingerprint the asset map in `sync.json` keeps of the URL a host serves an
 * asset at.
 *
 * A hash, never the URL: it can recognize an address a pull brings back and it
 * cannot be used to compose one — see the header. Prefixed so a reader of the
 * committed file cannot mistake it for something to fetch.
 *
 * ⛔ Why not carry identity on the wire instead, as content images do? A bare string
 * has no object to put `assetId` beside, and folding it into the value (a URL
 * fragment was tried, 2026-09-10) changes what every consumer receives — a
 * foundation that tells video from image by `src.endsWith('.mp4')` would break on
 * a hosted site. This way the wire value is exactly the host's URL.
 *
 * @param {string} url - the serve URL the upload plan returned, verbatim
 * @returns {string} `sha256:<16 hex>`
 */
export function servedFingerprint(url) {
  return `sha256:${createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}`
}

/**
 * Restore authored asset paths on a document being projected back to files.
 *
 * The inverse of the push-side stamp in `sync-package.js`: push replaces a local
 * ref with the host's serve URL and stamps `assetId` beside it; this reads the
 * id back and puts the author's own path where the URL is.
 *
 * ⭐ **This is the reason the map is committed.** Stored content carries an id
 * and a URL, and neither says the author called it `/images/hero.png`. Without
 * this, a dev who pulls a site they pushed yesterday finds every image rewritten
 * to a backend route — their source mangled by a round trip that touched
 * nothing. With it, a push/pull cycle is a fixed point on the paths they wrote.
 *
 * ⛔ An id the map does not know is LEFT ALONE, deliberately. That is an asset
 * this project has never held — authored in the app, or pushed from another
 * machine whose map entry has not arrived — and the honest projection is the URL
 * that works, not a local path to a file that is not there. Filling those in is
 * the download's job, not this one.
 *
 * `assetId` itself is not removed: it is not a markdown attribute, so the
 * serializer drops it on the way to disk, and leaving it lets a caller project
 * the same document twice without the second pass losing identity.
 *
 * @param {object} document - the site-content document (mutated in place)
 * @param {Record<string, { id: string, ext: string }>} map - readAssetMap()
 * @returns {{ restored: number, unknown: number }}
 */
export function restoreAssetRefs(document, map) {
  const byId = new Map()
  for (const [ref, v] of Object.entries(map || {})) {
    if (v?.id && !byId.has(v.id)) byId.set(v.id, ref)
  }
  const stats = { restored: 0, unknown: 0 }
  if (!byId.size) return stats

  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    // Every slot: a poster is the one asset a round trip would still mangle if
    // only the primary reference were restored.
    for (const slot of ASSET_SLOTS) {
      const id = node[slot.id]
      if (typeof id !== 'string' || !id) continue
      const ref = byId.get(id)
      if (!ref) { stats.unknown++; continue }
      const urlAttr = slot.urls.find((k) => typeof node[k] === 'string') || slot.urls[0]
      node[urlAttr] = ref
      stats.restored++
    }
    for (const v of Object.values(node)) visit(v)
  }
  visit(document)

  // ⭐ BARE STRINGS — a reference with no object to carry identity beside it
  // (`info.preview`, `info.favicon`, `seo.image`, a section param). The stored value
  // is the serve URL alone, so it is recognized by the fingerprint the push recorded
  // for it (`servedFingerprint`). A string the map has no fingerprint for stays as
  // the URL that works — the same rule as an unknown id above.
  const byServed = new Map()
  for (const [ref, v] of Object.entries(map || {})) {
    if (v?.served && !byServed.has(v.served)) byServed.set(v.served, ref)
  }
  if (byServed.size) {
    const restore = (v) => {
      if (typeof v !== 'string' || !looksLikeAddress(v)) return v
      const ref = byServed.get(servedFingerprint(v))
      if (!ref) return v
      stats.restored++
      return ref
    }
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (typeof node[i] === 'string') node[i] = restore(node[i])
          else walk(node[i])
        }
      } else if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
          if (typeof node[key] === 'string') node[key] = restore(node[key])
          else walk(node[key])
        }
      }
    }
    walk(document)
  }
  return stats
}

// Only a string that could be a served address is worth hashing.
const looksLikeAddress = (v) => v.startsWith('/') || /^https?:\/\//i.test(v)
