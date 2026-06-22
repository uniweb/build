// emitSyncPackages — build a whole site's sync as the backend's TWO directional
// lanes, each its own `.uwx`:
//
//   - site-content lane  → one `@uniweb/site-content` entity (the static half).
//   - collections lane   → one `@uniweb/folder` entity + the collection records it
//                          references (the dynamic half; the `$ref` closure rides
//                          together so brand-new records resolve in one call).
//
// The verb POSTs each to its own route (site-content first — the site is born there;
// then the folder, keyed by the site-content uuid). The folder carries no uuid of its
// own: the backend owns the site's `@uniweb/folder` and resolves it from the
// site-content uuid. Returning two separable packages keeps the producer pure of the
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
import { isLocalAssetPath } from '../site/assets.js'

const SITE_MODEL_NAME = '@uniweb/site-content'
const SITE_ENTITY_KEY = 'site-content'

const cacheKey = (entity) => `${entity.model} ${entity.id}`

function emitLane(entities, exporter, exportedAt, extraModels = []) {
  const models = [...new Set([...entities.map((e) => e.model), ...extraModels])]
  const buffer = emitEntitySyncPackage({
    entities,
    modelsRequired: models.map((name) => ({ name_at_export: name })),
    exporter,
    exportedAt,
  })
  return { buffer, entityCount: entities.length, models }
}

// Collect the Models referenced by the folder's `ref` leaves (`entry.model`), walking
// the contents/$children tree. The folder is built from the FULL record set, so it
// references every record's Model — including records the send-only-changed filter
// drops from THIS package (a re-push where the folder changed but the records didn't).
// The backend requires every referenced Model declared in modelsRequired, so these must
// ride even when their record entities don't.
function collectReferencedModels(node, acc) {
  if (!node || typeof node !== 'object') return acc
  if (node.entry && typeof node.entry.model === 'string') acc.add(node.entry.model)
  for (const key of ['$children', 'contents']) {
    if (Array.isArray(node[key])) for (const child of node[key]) collectReferencedModels(child, acc)
  }
  return acc
}

// --- local-media over push (Slice 5) ----------------------------------------
// A site's content references local media by the author's original path
// (`/images/hero.png`, `./hero.png`); the backend stores media content-addressed
// and serves it by URL. The deploy uploads the local files and swaps the refs for
// the backend's serve URLs. Both steps walk the produced entity documents with one
// generic recursion, filtered by `isLocalAssetPath` (a `/`/`./`/`../` prefix PLUS a
// media extension) — so it covers PM image `src`, `background`/`params`, record
// media fields, and localized `{locale: doc}` maps uniformly and safely (non-media
// strings like `/data/x.json` never match). Mirrors the build's `walkDataAssets`.

// Invoke visitor(ref) for every local asset path string anywhere in the document.
function walkEntityAssets(node, visitor) {
  if (typeof node === 'string') {
    if (isLocalAssetPath(node)) visitor(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walkEntityAssets(item, visitor)
    return
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) walkEntityAssets(v, visitor)
  }
}

// In-place: replace every local-asset-path string the map covers with its serve
// URL. A ref the map omits (upload failed/skipped) is left untouched — never a
// broken URL. Returns the (mutated) node.
function rewriteEntityAssets(node, map) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i]
      if (typeof v === 'string') { if (map[v]) node[i] = map[v] }
      else rewriteEntityAssets(v, map)
    }
    return node
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const v = node[key]
      if (typeof v === 'string') { if (map[v]) node[key] = map[v] }
      else rewriteEntityAssets(v, map)
    }
  }
  return node
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
 * @param {object} [opts.injectInfo]      - deploy-derived `info.*` to stamp on the
 *        site-content document (e.g. `{ data_bundle }`, the static-data ball URL);
 *        wire-only — never authored in site.yml, never projected back on pull.
 * @param {Object<string,string>} [opts.assetRewrite] - map of local asset ref →
 *        backend serve URL; rewrites the entities' media refs before push (the
 *        deploy's 2nd emit). Absent → no rewrite (the f225 sync path is unchanged).
 * @param {object} [opts.exporter] @param {string} [opts.exportedAt]
 * @returns {Promise<{
 *   siteContent: { buffer, entityCount, index, models }|null,
 *   collections: { buffer, entityCount, index, models }|null,
 *   hashes: Object<string,string>, warnings: string[], skipped: number,
 *   schemaless: Array<{name: string}>, localAssets: string[] }>}
 *   `schemaless` lists collections that resolved no data schema (soft-skipped from
 *   the sync) — the composite deploy delivers these statically via the data ball.
 *   `localAssets` lists the site-root local media refs (`/images/x.png`) the deploy
 *   must upload + rewrite to serve URLs; co-located refs are warned and skipped.
 *   Each lane is null when it has nothing to push. The collections `index` keeps a
 *   leading `{ kind: 'folder' }` placeholder (submission position 0 → the folder
 *   entity) so record back-fill stays positionally aligned; the folder itself has no
 *   uuid to back-fill.
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
  })

  const siteDoc = includeSite ? await siteProjectToDocument(siteRoot, { sourceLocale }) : null
  // Deploy-derived `info` fields (e.g. `data_bundle`, the static-data ball URL) are
  // stamped here — NOT authored in site.yml, so they ride the wire but never project
  // back on pull (the `info.assets` precedent). They are part of the hashed content,
  // so a changed bundle URL correctly re-fires the site-content lane.
  if (siteDoc && opts.injectInfo && typeof opts.injectInfo === 'object') {
    siteDoc.info = { ...siteDoc.info, ...opts.injectInfo }
  }

  // Local-media over push (Slice 5). `assetRewrite` ({ '/images/x.png': serveUrl })
  // is supplied by the deploy's SECOND emit, after it has uploaded the files the
  // FIRST emit surfaced in `localAssets`. It is absent on the collect emit and on
  // every non-deploy caller, so the f225 sync path is byte-identical without it.
  const assetRewrite =
    opts.assetRewrite && typeof opts.assetRewrite === 'object' ? opts.assetRewrite : null
  if (assetRewrite) {
    if (siteDoc) rewriteEntityAssets(siteDoc, assetRewrite)
    for (const e of col.entities) rewriteEntityAssets(e.document, assetRewrite)
  }
  // Collect the site-root local refs the deploy must upload (`/images/x.png`).
  // Co-located refs (`./x`, `../x`) need the source `.md` location to resolve — the
  // entity doesn't carry it — so warn once each and skip (v1: use a site-root path).
  const localAssetSet = new Set()
  const colocatedSeen = new Set()
  const collectFrom = (doc) =>
    doc &&
    walkEntityAssets(doc, (ref) => {
      if (ref.startsWith('/')) localAssetSet.add(ref)
      else if (!colocatedSeen.has(ref)) {
        colocatedSeen.add(ref)
        warnings.push(
          `local-media: co-located asset "${ref}" is not uploaded on the composite deploy — ` +
            `use a site-root path (e.g. /images/${ref.replace(/^[./]+/, '')})`
        )
      }
    })
  collectFrom(siteDoc)
  for (const e of col.entities) collectFrom(e.document)
  const localAssets = [...localAssetSet]

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
    // Folder first (always, for the `$ref` closure), then changed records. The
    // leading `{ kind: 'folder' }` keeps submission position 0 aligned for record
    // back-fill (backfillEntityUuids skips it — the folder has no uuid to write).
    const entities = [folder, ...changedRecords.map((r) => r.entity)]
    const index = [{ kind: 'folder' }, ...changedRecords.map((r) => r.index)]
    // The folder references every record's Model via `entry.model` — including records
    // filtered out here by send-only-changed. Declare them all (the backend rejects a
    // folder that references an undeclared Model).
    const referencedModels = [...collectReferencedModels(folder.document, new Set())]
    collections = { ...emitLane(entities, exporter, exportedAt, referencedModels), index }
  }

  // --- site-content lane -------------------------------------------------------
  let siteContent = null
  if (siteEntity && changed(siteEntity)) {
    siteContent = { ...emitLane([siteEntity], exporter, exportedAt), index: [{ kind: 'site' }] }
  }

  // The site's current uuid (from site.yml): the verb keys the folder push route on
  // it (`/dev/site/folder/push/{siteContentUuid}`), and decides CREATE vs UPDATE for
  // the content lane by its presence/absence.
  const siteContentUuid = siteDoc?.$uuid

  return { siteContent, collections, siteContentUuid, hashes, warnings, skipped, schemaless: col.schemaless, localAssets }
}
