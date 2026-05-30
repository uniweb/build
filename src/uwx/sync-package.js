// emitSyncPackages — build a whole site's sync as the backend's TWO directional
// lanes, each its own `.uwx`:
//
//   - site-content lane  → one `@uniweb/site-content` entity (the static half).
//   - collections lane   → one `@uniweb/folder` entity + the collection records it
//                          references (the dynamic half; the `$ref` closure rides
//                          together so brand-new records resolve in one call).
//
// The verb POSTs each to its own route (site-content first — the site is born there;
// then collections, binding to that site via `?site=<siteContentUuid>` on the first
// collections push). Returning two separable packages keeps the producer pure of the
// HTTP/ordering concern.
//
// "Send only changed" spans both lanes via one content-hash map (the sync-cache):
//   - site-content lane fires iff the site entity changed.
//   - collections lane fires iff the folder changed OR any record changed — and when
//     it fires it carries the FULL folder (for the `$ref` closure + binding) plus the
//     changed records. An untouched site with collections pushes nothing on either
//     lane (the idempotent no-op).

import { buildCollectionEntities, entityContentHash } from './collections.js'
import { buildFolderEntity } from './folder.js'
import { siteProjectToDocument } from './site.js'
import { emitEntitySyncPackage } from './entity-document.js'

const SITE_MODEL_NAME = '@uniweb/site-content'
const SITE_ENTITY_KEY = 'site-content'

const cacheKey = (entity) => `${entity.model} ${entity.id}`

function emitLane(entities, exporter, exportedAt) {
  const models = [...new Set(entities.map((e) => e.model))]
  const buffer = emitEntitySyncPackage({
    entities,
    modelsRequired: models.map((name) => ({ name_at_export: name })),
    exporter,
    exportedAt,
  })
  return { buffer, entityCount: entities.length, models }
}

/**
 * Build the two sync packages for a site.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.foundationDir]   - local foundation root (collection Models)
 * @param {Function} [opts.resolveModel]  - async non-local Model resolver
 * @param {string} [opts.sourceLocale]    - localized-field wrap locale
 * @param {Object<string,string>} [opts.priorHashes] - sync-cache (send-only-changed)
 * @param {boolean} [opts.sendAll]        - bypass the prior-hash filter
 * @param {boolean} [opts.includeSite]    - include the site-content lane (default true)
 * @param {object} [opts.exporter] @param {string} [opts.exportedAt]
 * @returns {Promise<{
 *   siteContent: { buffer, entityCount, index, models }|null,
 *   collections: { buffer, entityCount, index, models, bind: boolean }|null,
 *   hashes: Object<string,string>, warnings: string[], skipped: number }>}
 *   `bind` is true when the folder has no uuid yet (first collections push → bind to
 *   the site). Each lane is null when it has nothing to push.
 */
export async function emitSyncPackages(siteRoot, opts = {}) {
  const includeSite = opts.includeSite !== false
  const sourceLocale = opts.sourceLocale
  const priorHashes = opts.priorHashes || {}
  const sendAll = !!opts.sendAll
  const exporter = opts.exporter
  const exportedAt = opts.exportedAt

  const col = await buildCollectionEntities(siteRoot, {
    ...(opts.foundationDir ? { foundationDir: opts.foundationDir } : {}),
    ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
    ...(sourceLocale ? { sourceLocale } : {}),
  })
  const warnings = [...col.warnings]

  // The folder rides over the FULL record set (before filtering) so its references
  // are complete — new records by `$ref`, already-minted ones by `entry: <uuid>`.
  const folder = buildFolderEntity({
    recordEntities: col.entities,
    folders: col.colConfig?.folders ?? null,
    folderUuid: col.colConfig?.folderUuid,
  })

  const siteDoc = includeSite ? await siteProjectToDocument(siteRoot, { sourceLocale }) : null
  const siteEntity = siteDoc
    ? { id: siteDoc.$id, model: siteDoc.$model, file: 'entities/site-content.json', document: siteDoc }
    : null

  // One hash map over every entity (both lanes) — the sync-cache the caller persists.
  const hashes = {}
  let skipped = 0
  const changed = (entity) => {
    const key = cacheKey(entity)
    const h = entityContentHash(entity.document)
    hashes[key] = h
    const isChanged = sendAll || priorHashes[key] !== h
    if (!isChanged) skipped++
    return isChanged
  }

  // --- collections lane --------------------------------------------------------
  // changed() has side effects (hashes/skipped), so evaluate every entity exactly
  // once, in a stable order: folder, then each record.
  const folderChanged = folder ? changed(folder) : false
  const recordChanged = col.entities.map((e, i) => ({ entity: e, index: col.index[i], changed: changed(e) }))
  const changedRecords = recordChanged.filter((r) => r.changed)

  let collections = null
  if (folder && (folderChanged || changedRecords.length > 0)) {
    // Folder first (always, for the `$ref` closure + binding), then changed records.
    const entities = [folder, ...changedRecords.map((r) => r.entity)]
    const index = [{ kind: 'folder' }, ...changedRecords.map((r) => r.index)]
    collections = { ...emitLane(entities, exporter, exportedAt), index, bind: !col.colConfig?.folderUuid }
  }

  // --- site-content lane -------------------------------------------------------
  let siteContent = null
  if (siteEntity && changed(siteEntity)) {
    siteContent = { ...emitLane([siteEntity], exporter, exportedAt), index: [{ kind: 'site' }] }
  }

  // The site's current uuid (from site.yml), so the verb can bind a first-push
  // collections folder to it via `?site=` even when site-content didn't change.
  const siteContentUuid = siteDoc?.$uuid

  return { siteContent, collections, siteContentUuid, hashes, warnings, skipped }
}
