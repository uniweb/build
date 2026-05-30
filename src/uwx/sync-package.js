// emitSyncPackage — ONE sync package for a whole site: its static content
// (`@uniweb/site-content`, the nested `$`-document) PLUS its `model:`-mapped
// collection records, submitted together in a single `.uwx` on the restore lane.
//
// `uniweb sync` was collections-only at first (content export was the site PoC);
// the intent is that one `uniweb sync` pushes BOTH facets. Site-content is just
// another entity on the same lane — so this composes the two builders:
//   - buildCollectionEntities (collections.js) → record entities + file-backfill index
//   - siteProjectToDocument   (site.js)        → the one site-content entity
// then shares the "send only changed" filter and one emitEntitySyncPackage call.
//
// Identity back-fill differs by facet, and the per-entity `index` says which:
//   - record entities  → `{ id, model, sourceFile, … }`  → write `$uuid` into the
//                        source FILE (backfill.js), as before.
//   - the site entity  → `{ kind: 'site', sidecarPath, document }` → write the
//                        minted uuids into the committed SIDECAR (writeSiteSidecar),
//                        keeping uuids out of authored files (plan §4).

import { join } from 'node:path'
import { buildCollectionEntities, filterChanged } from './collections.js'
import { siteProjectToDocument } from './site.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { SIDECAR_RELPATH } from './identity.js'

const SITE_MODEL_NAME = '@uniweb/site-content'
const SITE_ENTITY_KEY = 'site-content'

/**
 * Build the combined site-content + collections sync package.
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
  // no `model:` collections still syncs its content. A declared-but-unresolvable
  // Model still throws (inside buildCollectionEntities) — that's a real error.
  const col = await buildCollectionEntities(siteRoot, {
    ...(opts.foundationDir ? { foundationDir: opts.foundationDir } : {}),
    ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
    ...(sourceLocale ? { sourceLocale } : {}),
  })

  const entities = [...col.entities]
  const index = [...col.index]
  const warnings = [...col.warnings]

  if (includeSite) {
    const sidecarPath = join(siteRoot, SIDECAR_RELPATH)
    // Read the committed sidecar so a re-sync carries known `$uuid`s; the backend
    // mints any that are missing and the back-fill records them.
    const document = await siteProjectToDocument(siteRoot, { sidecar: sidecarPath, sourceLocale })
    entities.push({
      id: SITE_ENTITY_KEY,
      model: SITE_MODEL_NAME,
      file: 'entities/site-content.json',
      document,
    })
    index.push({ kind: 'site', sidecarPath, document })
  }

  if (entities.length === 0) {
    // No collections declared and site explicitly excluded — nothing to do.
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
