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
 * `config.assets.url` template is the whole address, and only the host owns the
 * second half.
 *
 * ⛔ **No mime or size.** The store validates those and they are its to change;
 * a second copy here is a second thing to disagree.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
    if (!was) added.push(ref)
    else if (was.id !== v.id) changed.push(ref)
    else continue
    prior[ref] = { id: v.id, ext: v.ext || '' }
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
    if (typeof node.assetId === 'string' && node.assetId) {
      const ref = byId.get(node.assetId)
      if (ref) {
        if (typeof node.src === 'string') node.src = ref
        else if (typeof node.url === 'string') node.url = ref
        else node.src = ref
        stats.restored++
      } else {
        stats.unknown++
      }
    }
    for (const v of Object.values(node)) visit(v)
  }
  visit(document)
  return stats
}
