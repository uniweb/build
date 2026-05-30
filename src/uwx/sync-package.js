// emitSyncPackage — ONE sync package for a whole site: its static content
// (`@uniweb/site-content`, the nested `$`-document), its `schema:`-mapped collection
// records, AND the one `@uniweb/folder` entity that organizes those records —
// submitted together in a single `.uwx` to /api/sites/sync.
//
// It composes three builders:
//   - buildCollectionEntities (collections.js) → record entities + file-backfill index
//   - buildFolderEntity       (folder.js)      → the one @uniweb/folder (references)
//   - siteProjectToDocument   (site.js)        → the one site-content entity
// then shares the "send only changed" filter and one emitEntitySyncPackage call.
//
// Submission order: collection records, then @uniweb/folder, then site-content
// (`report.finalized[]` correlates by `index` = position). Identity back-fill differs
// by facet, and the per-entity `index` says which:
//   - record entities → write `$uuid` into the source FILE (backfill.js).
//   - the folder       → write the minted `$uuid` into collections.yml (verb).
//   - the site entity  → write the minted `$uuid` into site.yml + record the local
//                        move-tracking ledger (verb). No per-item uuids on the wire.

import { buildCollectionEntities, filterChanged } from './collections.js'
import { buildFolderEntity } from './folder.js'
import { siteProjectToDocument } from './site.js'
import { emitEntitySyncPackage } from './entity-document.js'

const SITE_MODEL_NAME = '@uniweb/site-content'
const SITE_ENTITY_KEY = 'site-content'

/**
 * Build the combined site-content + folder + collections sync package.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.foundationDir]   - local foundation root (collection Models)
 * @param {Function} [opts.resolveModel]  - async non-local Model resolver
 * @param {string} [opts.sourceLocale]    - localized-field wrap locale
 * @param {Object<string,string>} [opts.priorHashes] - sync-cache (send-only-changed)
 * @param {boolean} [opts.sendAll]        - bypass the prior-hash filter
 * @param {boolean} [opts.includeSite]    - include the site-content entity (default true)
 * @param {object} [opts.exporter] @param {string} [opts.exportedAt]
 * @returns {Promise<{ buffer: Buffer|null, models: string[], entityCount: number,
 *   siteIncluded: boolean, warnings: string[], index: object[],
 *   hashes: Object<string,string>, skipped: number }>} `buffer` is null +
 *   `entityCount` 0 when nothing changed; `hashes` is the full current map.
 */
export async function emitSyncPackage(siteRoot, opts = {}) {
  const includeSite = opts.includeSite !== false
  const sourceLocale = opts.sourceLocale

  // Collections are OPTIONAL here (unlike the collection-only verb): a site with
  // no syncable collections still syncs its content. A declared-but-unresolvable
  // EXPLICIT Model still throws (inside buildCollectionEntities) — a real error.
  const col = await buildCollectionEntities(siteRoot, {
    ...(opts.foundationDir ? { foundationDir: opts.foundationDir } : {}),
    ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
    ...(sourceLocale ? { sourceLocale } : {}),
  })

  const entities = [...col.entities]
  const index = [...col.index]
  const warnings = [...col.warnings]

  // The folder rides over the FULL record set (before send-only-changed filtering)
  // so its references are complete — new records by `$ref`, already-minted ones by
  // `entry: <uuid>`. Built only when the site has collection records.
  const folder = buildFolderEntity({
    recordEntities: col.entities,
    folders: col.colConfig?.folders ?? null,
    folderUuid: col.colConfig?.folderUuid,
  })
  if (folder) {
    entities.push(folder)
    index.push({ kind: 'folder' })
  }

  if (includeSite) {
    // The entity `$uuid` comes from site.yml (read inside siteProjectToDocument);
    // the document carries no per-item uuids. The verb back-fills the minted entity
    // uuid into site.yml and records the local move-tracking ledger.
    const document = await siteProjectToDocument(siteRoot, { sourceLocale })
    entities.push({
      id: SITE_ENTITY_KEY,
      model: SITE_MODEL_NAME,
      file: 'entities/site-content.json',
      document,
    })
    index.push({ kind: 'site', document })
  }

  if (entities.length === 0) {
    return {
      buffer: null, models: [], entityCount: 0, siteIncluded: false,
      warnings, index: [], hashes: {}, skipped: 0,
    }
  }

  const { sendEntities, sendIndex, hashes, skipped } = filterChanged(entities, index, {
    priorHashes: opts.priorHashes,
    sendAll: opts.sendAll,
  })

  const models = [...new Set(sendEntities.map((e) => e.model))]
  const siteIncluded = sendEntities.some((e) => e.model === SITE_MODEL_NAME)
  if (sendEntities.length === 0) {
    return { buffer: null, models, entityCount: 0, siteIncluded, warnings, index: [], hashes, skipped }
  }

  const buffer = emitEntitySyncPackage({
    entities: sendEntities,
    modelsRequired: models.map((name) => ({ name_at_export: name })),
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })

  return { buffer, models, entityCount: sendEntities.length, siteIncluded, warnings, index: sendIndex, hashes, skipped }
}
