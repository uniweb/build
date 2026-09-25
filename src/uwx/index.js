// @uniweb/build/uwx — zero-dependency .uwx (uwx/1) entity-package toolkit.
//
// `.uwx` is the Uniweb exchange format: a ZIP of a JSON manifest plus one
// JSON file per entity. This module packages a site project or a built
// foundation's schema as a `subtype: entity` .uwx, with stable ids for a
// syncable round trip.
//
//   - the writer        — emitEntityPackage + uuid/zip/manifest primitives
//   - foundation-schema mapper — schema.json -> @uniweb/foundation-schema entity
//   - site mapper        — file site project -> @uniweb/site-content entity
//   - identity           — stable uuids for the syncable round trip

export { mintUuidV7 } from './uuid.js'
export { createZip, readZip } from './zip.js'
export {
  sha256Hex,
  toJsonBuffer,
  serializeEntityFile,
  buildManifest,
  computePackageSha256,
  PACKAGE_SHA256_ASSUMPTIONS,
} from './manifest.js'
export { emitEntityPackage } from './package.js'
export { emitEntitySyncPackage, documentSchema } from './entity-document.js'
export {
  FOUNDATION_SCHEMA_TYPE_UUID,
  SITE_CONTENT_TYPE_UUID,
  DATA_SCHEMA_TYPE_UUID,
} from './entity-types.js'
export { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
export {
  mintResolver,
  sidecarResolver,
  sidecarLookup,
  writeSidecarStore,
  SIDECAR_RELPATH,
} from './identity.js'
export {
  foundationSchemaToEntity,
  emitFoundationSchemaPackage,
} from './foundation-schema.js'
export {
  siteProjectToDocument,
  emitSiteSyncPackage,
  writeSiteEntityUuid,
  extensionDeclaration,
  isExtensionUrl,
  isSiteRelativeExtensionUrl,
} from './site.js'
export {
  resolveQueriesConfig,
  queriesYmlPath,
  QUERIES_YML_RELPATH,
} from './queries-config.js'
export { upsertYamlScalar, removeYamlScalar } from './yaml-upsert.js'
export { buildFolderEntity,
  collectFolderItemUuids,
  stampFolderItemUuids
} from './folder.js'
// The identity of a record's list items — banked per record from what a push sent and
// what came back, stamped on the next send.
export {
  recordItemLists,
  harvestRecordItems,
  storedRecordItems,
  stampRecordItems,
  reprintRecordItems
} from './record-items.js'
export {
  recordsToProject,
  declarationsToQueriesYml,
  folderToFolderYml,
  findRecordFileByUuid,
  indexFolder,
} from './records-project.js'
// Which stored record each of a copy's records is, when its map lost the answer.
export { matchStoredRecords } from './record-identity.js'
// The scope a site's `@/x` refs resolve into — its foundation's. A pull resolves it
// up front and hands it to the synchronous projections above.
export { siteSelfScope } from './self-scope.js'
export {
  siteInfoToConfig,
  sectionRecordToFile,
  pageSectionsToFiles,
  siteContentDocumentToProject,
} from './site-project.js'
export {
  createTranslationCollector,
  writeLocaleTranslations,
  localeFilePath,
} from './locale-sync.js'
export { emitSyncPackages } from './sync-package.js'
// ⚠️ The asset MAP is `sync.json::backends.<origin>.assets` (sync-store.js, below).
// `readAssetMap` / `updateAssetMap` / `refForAssetId` / `ASSET_MAP_FILE` were removed
// on 2026-09-20: a single flat file cannot hold ids minted by more than one backend.
export { restoreAssetRefs, servedFingerprint } from './asset-map.js'
// `sync.json` — what each backend minted, keyed by origin. Absorbs `assets.json`
// above, `site.yml`'s identity keys and three maps out of the sync cache.
// Spec: kb/framework/reference/sync-json.md
export {
  SYNC_STORE_FILE,
  readSyncStore,
  readBackendState,
  listSyncedBackends,
  updateBackendState,
  updateBackendMap,
  carryServed,
  clearBackend,
  clearBackendSections,
  forgetSyncStore,
  refForAssetId,
  normalizeOrigin as normalizeBackendOrigin,
} from './sync-store.js'
export {
  diffSiteUnits,
  describeSiteDiff,
  computeUnitHashes,
  collectSiteUnits,
  walkSiteUnits,
  collectUnitUuids,
  collectQueryUuids,
  stampUnitUuids,
} from './site-diff.js'
export {
  recordsToEntities,
  buildRecordEntities,
  filterChanged,
  emitRecordSyncPackage,
  entityContentHash,
} from './records.js'
export { readEntityFile, parseFrontmatter } from './entity-source.js'

// Where a site's records live, and the grammar of that directory — a schema ref to
// its folder and back. ⛔ Allowlist: an export added to `site/entity-pool.js` does
// not reach a caller until it is here.
export {
  poolDirsForSchema,
  schemaForPoolDirs,
  readEntityPool,
  resolveRecordsDir,
  RECORDS_DIR,
} from '../site/entity-pool.js'

// How the folder is organized, so a verb can ask what `records/folder.yml` SAYS without
// re-reading or re-parsing it. ⛔ Note the allowlist: an export added to
// `site/records-config.js` does not reach a caller until it is named here.
export {
  readRecordsConfig,
  FOLDER_YML,
  folderYmlPath,
} from '../site/records-config.js'
export {
  findRecordFile,
  backfillUuid,
  backfillArrayFile,
  backfillBibFile,
  renderEntityDocument,
  backfillEntityUuids,
} from './backfill.js'

// Project writer — the pull-side file-projection primitives (shared with the
// app's site-writer; framework-owned so the public package never depends on the
// private app). See pull-projection.md §3/§10 (P0).
export {
  DEFAULT_RESERVED_FRONTMATTER,
  writeIfChanged,
  resolveSectionFile,
  resolveSectionDir,
  resolveSectionPath,
  writeSectionFile,
  writeSiteConfig,
  writeThemeFile,
  writeRecordFile,
} from './project-writer.js'

// Registry-publish (names-only) — the document `uniweb register` submits, and the
// schema → @uniweb/data-schema declaration lowering it bundles. `buildRegistryPackage`
// is the foundation publish (foundation + the schemas it renders); `buildSchemaOnlyPackage`
// is the foundation-less variant (only data-schema entities) for a schemas-only package.
export { buildRegistryPackage, buildSchemaOnlyPackage } from './registry-package.js'
export { toDataSchemaDeclaration } from './data-schema.js'
