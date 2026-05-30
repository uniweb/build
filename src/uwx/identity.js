// The syncable-round-trip identity layer.
//
// .uwx import is idempotent BY UUID (an importer reuses an entity/item whose
// uuid already exists). A file site has no uuids — we mint on first export.
// For re-export to UPDATE rather than DUPLICATE, the entity uuid AND every
// item uuid must be stable across exports. That requires persisting them,
// keyed by something that survives edits.
//
// The identity strategy is a pluggable RESOLVER ({ entity(key), item(key),
// flush() }) so it's a seam, not hardcoded mint calls:
//   - mintResolver     : always mint (submit-once; the library default —
//                        side-effect-free).
//   - sidecarResolver  : stable lookup/persist via a project-local,
//                        git-committed `<root>/.uniweb/uwx-ids.json`. Opt-in
//                        at the library layer; the CLI turns it on by
//                        default for the real workflow (mechanism vs policy).
//
// Stable keys are the caller's responsibility (it knows what survives a
// rename — `stable_id`, `url`, collection `name`, `layout/area`, …). The
// resolver only maps key→uuid; it does not invent keys.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { mintUuidV7 } from './uuid.js'

export function mintResolver() {
  return {
    entity: () => mintUuidV7(),
    item: () => mintUuidV7(),
    flush() {},
  }
}

/**
 * Stable resolver backed by `<sidecarPath>` (JSON:
 * `{ entities: { key: uuid }, items: { key: uuid } }`).
 *
 * - Existing key → its stored uuid (idempotent re-export).
 * - New key → mint, record, mark dirty.
 * - `flush()` writes the file back (pretty, key-sorted for clean git diffs)
 *   only if anything changed. Stale keys are kept, not pruned: a temporarily
 *   removed-then-re-added page must not lose its uuid; harmless extra
 *   entries beat lost identity. Pruning is a deliberate later op.
 *
 * @param {string} sidecarPath
 */
export function sidecarResolver(sidecarPath) {
  let store = { entities: {}, items: {} }
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    store = {
      entities: parsed?.entities ?? {},
      items: parsed?.items ?? {},
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err // a corrupt sidecar is a real error
  }
  let dirty = false

  const get = (bag, key) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('uwx/identity: a non-empty string key is required')
    }
    if (!store[bag][key]) {
      store[bag][key] = mintUuidV7()
      dirty = true
    }
    return store[bag][key]
  }

  return {
    entity: (key) => get('entities', key),
    item: (key) => get('items', key),
    flush() {
      if (!dirty) return
      writeSortedSidecar(sidecarPath, store)
      dirty = false
    },
  }
}

// Write `{ entities, items }` key-sorted (clean git diffs), creating the dir.
function writeSortedSidecar(sidecarPath, store) {
  const sortObj = (o) =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  const out = {
    entities: sortObj(store.entities || {}),
    items: sortObj(store.items || {}),
  }
  mkdirSync(dirname(sidecarPath), { recursive: true })
  writeFileSync(sidecarPath, JSON.stringify(out, null, 2) + '\n')
}

/**
 * Merge `additions` ({ entities?, items? }) into the sidecar at `sidecarPath` and
 * write it back, key-sorted. Existing keys are PRESERVED (stale keys are kept, not
 * pruned — a temporarily-removed-then-re-added record must not lose its uuid;
 * matches sidecarResolver). Used by the site-content sync back-fill, where the
 * BACKEND mints uuids and the verb records them here (vs sidecarResolver, which
 * mints locally for the register lane).
 *
 * @param {string} sidecarPath
 * @param {{ entities?: object, items?: object }} additions
 */
export function writeSidecarStore(sidecarPath, additions) {
  let store = { entities: {}, items: {} }
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    store = { entities: parsed?.entities ?? {}, items: parsed?.items ?? {} }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err // a corrupt sidecar is a real error
  }
  Object.assign(store.entities, additions?.entities || {})
  Object.assign(store.items, additions?.items || {})
  writeSortedSidecar(sidecarPath, store)
}

/**
 * Read-only sidecar lookup — `{ entity(key), item(key) }` returning a stored uuid
 * or `undefined`, never minting and never writing.
 *
 * The site-content SYNC lane (unlike the register lane's `sidecarResolver`, which
 * mints locally) follows the collection lane: the BACKEND mints `$uuid` on first
 * sync and the verb records it back into this sidecar. So the producer only READS
 * uuids it already knows — first sync finds none (uuid-less `$`-document, `$id`
 * only), and a later sync injects the `$uuid`s the backend previously returned.
 * A missing file is empty (every lookup → undefined), not an error.
 *
 * @param {string} sidecarPath
 */
export function sidecarLookup(sidecarPath) {
  let store = { entities: {}, items: {} }
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    store = {
      entities: parsed?.entities ?? {},
      items: parsed?.items ?? {},
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err // a corrupt sidecar is a real error
  }
  return {
    entity: (key) => store.entities[key],
    item: (key) => store.items[key],
  }
}

// Where a site / foundation project keeps its CLI-owned id sidecar.
export const SIDECAR_RELPATH = '.uniweb/uwx-ids.json'
