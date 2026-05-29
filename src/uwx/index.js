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
export { emitEntitySyncPackage } from './entity-document.js'
export {
  FOUNDATION_SCHEMA_TYPE_UUID,
  SITE_CONTENT_TYPE_UUID,
  DATA_SCHEMA_TYPE_UUID,
} from './entity-types.js'
export { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
export {
  mintResolver,
  sidecarResolver,
  SIDECAR_RELPATH,
} from './identity.js'
export {
  foundationSchemaToEntity,
  emitFoundationSchemaPackage,
} from './foundation-schema.js'
export { siteProjectToEntity, emitSitePackage } from './site.js'
export {
  collectionRecordsToEntities,
  emitCollectionSyncPackage,
} from './collections.js'

// Registry-publish (names-only) — the document `uniweb register` submits, and the
// schema → @uniweb/data-schema declaration lowering it bundles. `buildRegistryPackage`
// is the foundation publish (foundation + the schemas it renders); `buildSchemaOnlyPackage`
// is the foundation-less variant (only data-schema entities) for a schemas-only package.
export { buildRegistryPackage, buildSchemaOnlyPackage } from './registry-package.js'
export { toDataSchemaDeclaration } from './data-schema.js'
