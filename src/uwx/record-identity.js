// ⭐ WHICH STORED RECORD EACH OF A COPY'S RECORDS IS — recovered from what the backend holds.
//
// A push sends a record with the uuid THIS backend minted for it: `sync.json`'s `records` map,
// the record's own id (its file's `$uuid`) → theirs. A copy bound to the site whose map lost an
// entry sends that record with none, and the backend mints a second entity for it — silently,
// since a new record is never refused. The folder that places it is refused instead, because its
// placements then carry no identity while the stored ones do (`identity_required`, measured
// 2026-09-25 on a blog site whose binding held neither map).
//
// ⭐ MATCHED THE WAY A PULL PLACES THEM: a record whose own id IS a stored uuid is that record —
// the first backend a record reaches mints the id its file keeps. Otherwise it is the stored
// record the folder places under the same Model and slug. ⛔ A Model and slug two stored records
// share names neither, and a stored record already mapped to another is not taken again: a wrong
// match would overwrite a record the author did not edit, where no match only re-creates one.

import { indexFolder } from './records-project.js'

/**
 * The stored uuid of each record the map does not name, where the backend's folder says which.
 *
 * @param {object} params
 * @param {Array<{ ownId?: string|null, model?: string, slug?: string }>} params.index - the
 *        records a push is about to send (`emitSyncPackages().records.index`)
 * @param {Object<string,string>} [params.recordMap] - this backend's map: own id → its uuid
 * @param {object} params.folderDoc - the backend's `@uniweb/folder` document for the site
 * @returns {Object<string,string>} own id → the stored uuid, for the records recovered
 */
export function matchStoredRecords({ index, recordMap = {}, folderDoc }) {
  const placed = indexFolder(folderDoc)
  const byName = new Map()
  for (const [theirs, { slug, schema }] of placed) {
    if (!slug || !schema) continue
    const key = `${schema} ${slug}`
    byName.set(key, byName.has(key) ? null : theirs)
  }
  const taken = new Set(Object.values(recordMap))
  const learned = {}
  for (const e of index || []) {
    if (!e?.ownId || recordMap[e.ownId] || learned[e.ownId]) continue
    const theirs = placed.has(e.ownId) ? e.ownId : byName.get(`${e.model} ${e.slug}`)
    if (!theirs || taken.has(theirs)) continue
    taken.add(theirs)
    learned[e.ownId] = theirs
  }
  return learned
}
