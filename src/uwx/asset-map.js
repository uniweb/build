/**
 * `assets.json` — the site's committed map from a local asset path to the
 * backend's content-addressed id.
 *
 * ## Why it is COMMITTED, and why that is the whole point
 *
 * The same map used to be built on every push and thrown away
 * (`assetsByLocalUrl`, in memory, consumed by the content rewrite and dropped).
 * Rebuilt per push it is a private detail; committed it is a **log every machine
 * collaborating on this site can read**:
 *
 *   - a teammate who clones knows which bytes the project expects to exist and
 *     can fetch the ones they lack, instead of discovering a missing image at
 *     render;
 *   - `pull` can put an asset back at **the path its author wrote**, rather than
 *     inventing one — without this, a push turns `/images/hero.png` into an
 *     opaque id and nothing remembers it was ever called that;
 *   - a re-push of unchanged media is visibly a no-op rather than a silent one.
 *
 * ⇒ It is project state, not cache. `.uniweb/` is gitignored in both scaffolded
 * templates, which is why this does not live there.
 *
 * ## ⛔ Diff stability is a hard requirement, not tidiness
 *
 * A committed file that reorders itself produces a spurious diff on every push
 * and trains people to stop reading it — at which point a real change to what a
 * site ships passes unnoticed. Keys are therefore **sorted**, the shape is flat,
 * and the writer is a no-op when nothing changed (it does not rewrite an
 * identical file, so `git status` stays clean on a push that moved no assets).
 *
 * ## What it deliberately does NOT hold
 *
 * ⛔ **No serve URL.** A URL is a host's route layout, and storing one here would
 * re-create — in a committed file, on every machine — exactly the coupling that
 * deleting `buildAssetUrl` removed from this CLI. The id plus the host's
 * `config.assets.url` pattern is the whole address, and only the host owns the
 * second half.
 *
 * ⚖️ **What it holds instead is a FINGERPRINT of the served URL** (`served`), and the
 * difference is the point: a hash can recognize an address and cannot compose one.
 * It exists for references that are a BARE STRING — `info.preview`, `info.favicon`,
 * `seo.image`, a section param — where there is no object to stamp `assetId` beside,
 * so the stored value is the serve URL alone. `pull` hashes such a string and, when
 * it matches, puts back the path the author wrote. Should the host ever serve an
 * asset at a new address, the fingerprint simply stops matching and the pull leaves
 * the URL — the honest projection — until the next push records the new one.
 *
 * ⛔ **No mime or size.** The store validates those and they are its to change;
 * a second copy here is a second thing to disagree.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ASSET_SLOTS } from '@uniweb/semantic-parser'
import { join } from 'node:path'

export const ASSET_MAP_FILE = 'assets.json'

/** Current on-disk shape. Bumped only for a breaking layout change. */
const VERSION = 1

const mapPath = (siteDir) => join(siteDir, ASSET_MAP_FILE)

/**
 * Read the site's asset map. A missing, unreadable or malformed file reads as
 * empty rather than throwing: the map is an accelerator and a record, and a
 * corrupt one must never be the reason a push fails. The next write repairs it.
 *
 * @param {string} siteDir
 * @returns {Record<string, { id: string, ext: string }>} local ref → identity
 */
export function readAssetMap(siteDir) {
  const p = mapPath(siteDir)
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    const assets = parsed?.assets
    if (!assets || typeof assets !== 'object') return {}
    const out = {}
    for (const [ref, v] of Object.entries(assets)) {
      if (v && typeof v.id === 'string' && v.id) {
        out[ref] = { id: v.id, ext: typeof v.ext === 'string' ? v.ext : '' }
        if (typeof v.served === 'string' && v.served) out[ref].served = v.served
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Merge `entries` into the site's map and write it if anything changed.
 *
 * MERGE, not replace: a push carries only the refs that page's content touched,
 * so replacing would drop every asset this run happened not to mention — which
 * is most of them on a partial push. An entry whose id changed is overwritten
 * (the bytes at that path changed); an identical entry is left alone.
 *
 * @param {string} siteDir
 * @param {Record<string, { id: string, ext: string }>} entries
 * @returns {{ added: string[], changed: string[], written: boolean }}
 */
export function updateAssetMap(siteDir, entries) {
  const prior = readAssetMap(siteDir)
  const added = []
  const changed = []

  for (const [ref, v] of Object.entries(entries || {})) {
    if (!v?.id) continue
    const was = prior[ref]
    // A new `served` fingerprint is a change too: the host serves these bytes at
    // another address now, and the old fingerprint would stop recognizing it. An
    // entry that carries none — a download learns identity, not an upload's URL —
    // keeps the one already recorded for the same bytes.
    const served = v.served || (was && was.id === v.id ? was.served : undefined)
    if (!was) added.push(ref)
    else if (was.id !== v.id || (served || '') !== (was.served || '')) changed.push(ref)
    else continue
    prior[ref] = { id: v.id, ext: v.ext || '', ...(served ? { served } : {}) }
  }

  if (!added.length && !changed.length) return { added, changed, written: false }

  // Sorted keys + a trailing newline: a committed file that reorders itself
  // produces a diff on every push and teaches people to skip reading it.
  const assets = {}
  for (const ref of Object.keys(prior).sort()) assets[ref] = prior[ref]
  writeFileSync(
    mapPath(siteDir),
    JSON.stringify({ version: VERSION, assets }, null, 2) + '\n'
  )
  return { added, changed, written: true }
}

/**
 * The local ref a given asset id is known at, or null.
 *
 * This is the direction `pull` needs and the reason the map is worth
 * committing: stored content carries an id, and only this can say the author
 * called it `/images/hero.png`. Without it a pull must invent a path.
 *
 * @param {Record<string, { id: string, ext: string }>} map
 * @param {string} id
 * @returns {string|null}
 */
export function refForAssetId(map, id) {
  if (!id) return null
  for (const [ref, v] of Object.entries(map || {})) {
    if (v.id === id) return ref
  }
  return null
}

/**
 * The fingerprint `assets.json` keeps of the URL a host serves an asset at.
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
