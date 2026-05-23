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
    schema: () => mintUuidV7(),
    flush() {},
  }
}

/**
 * Stable resolver backed by `<sidecarPath>` (JSON:
 * `{ entities: { key: uuid }, items: { key: uuid }, schemas: { key: uuid } }`).
 *
 * `schemas` is the data-schema-identity bag: a data schema's stable identity
 * (the value carried in the `@uniweb/data-schema` entity's wire `meta.model_uuid`),
 * keyed by its ref (e.g. `@/article`) so it's REUSED ACROSS FOUNDATION VERSIONS
 * — commit the sidecar and every republish references the same data schema.
 * (See kb/framework/plans/uniweb-register-contract.md §6.)
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
  let store = { entities: {}, items: {}, schemas: {} }
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    store = {
      entities: parsed?.entities ?? {},
      items: parsed?.items ?? {},
      schemas: parsed?.schemas ?? {},
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
    schema: (key) => get('schemas', key),
    flush() {
      if (!dirty) return
      const sortObj = (o) =>
        Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
      const out = {
        entities: sortObj(store.entities),
        items: sortObj(store.items),
        schemas: sortObj(store.schemas),
      }
      mkdirSync(dirname(sidecarPath), { recursive: true })
      writeFileSync(sidecarPath, JSON.stringify(out, null, 2) + '\n')
      dirty = false
    },
  }
}

// Where a site / foundation project keeps its CLI-owned id sidecar.
export const SIDECAR_RELPATH = '.uniweb/uwx-ids.json'
