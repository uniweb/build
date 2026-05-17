// @uniweb/build/uwx — zero-dependency .uwx (uwx/1) entity-package toolkit.
//
// `.uwx` is the Uniweb exchange format: a ZIP of a JSON manifest plus one
// JSON file per entity. This module packages a site project or a built
// foundation's schema as a `subtype: entity` .uwx, with stable ids for a
// syncable round trip.
//
//   - the writer        — emitEntityPackage + uuid/zip/manifest primitives
//   - foundation mapper  — schema.json -> @uniweb/foundation entity
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
export {
  FOUNDATION_MODEL_UUID,
  SITE_CONTENT_MODEL_UUID,
} from './models.js'
export { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
export {
  mintResolver,
  sidecarResolver,
  SIDECAR_RELPATH,
} from './identity.js'
export {
  foundationSchemaToEntity,
  emitFoundationPackage,
} from './foundation.js'
export { siteProjectToEntity, emitSitePackage } from './site.js'
