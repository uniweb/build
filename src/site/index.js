/**
 * Site Build Tools
 *
 * Vite plugins and utilities for building Uniweb sites.
 *
 * @module @uniweb/build/site
 */

export { siteContentPlugin } from './plugin.js'
export { defineSiteConfig, readSiteConfig, default } from './config.js'
// What `uniweb dev` hands the dev server of a site a backend holds (`./preview.js`).
export { PREVIEW_ENV, encodePreview, readPreview } from './preview.js'
// Where a site's dev server listens, as it states it, for `uniweb dev` (`./dev-server.js`).
export { DEV_PORT_ENV, DEV_RECORD_ENV, runningDevServer, stopDevServer } from './dev-server.js'
// Where a statically built site lives, as its deploy target or author states it (`./site-address.js`).
export { ORIGIN_ENV, refuseUnreadableAddress } from './site-address.js'
export { collectSiteContent, mountEntriesOf } from './content-collector.js'
// The favicon a build links when site.yml names none, for `uniweb doctor` (`./favicon.js`).
export { findPublicFavicon } from './favicon.js'
// The `agents:` vocabulary lives in @uniweb/projections (which owns the block);
// re-exported so the CLI can validate an author's spelling, and read an
// `expectedOrigins` entry by its rule, without taking a direct dependency on it.
// Same shape as the search re-exports.
export { AGENTS_KEYS, originOf } from '@uniweb/projections'
export { buildSiteData } from './build-site-data.js'
export { shouldSplitContent } from './split-content.js'
export {
  resolveAssetPath,
  walkContentAssets,
  collectSectionAssets,
  mergeAssetCollections
} from './assets.js'
export {
  processAsset,
  processAssets,
  rewriteContentPaths,
  rewriteParamPaths,
  rewriteSiteContentPaths
} from './asset-processor.js'
export {
  extractVideoPoster,
  generatePdfThumbnail,
  processAdvancedAsset,
  processAdvancedAssets,
  checkFfmpeg,
  isVideoFile,
  isPdfFile
} from './advanced-processors.js'
export {
  processQueries,
  writeQueryFiles
} from './query-processor.js'
export { collectSchemalessData, collectSchemalessDataAssets, rewriteSchemalessDataAssets } from './schemaless-data.js'
export {
  parseFetchConfig,
  executeFetch,
  applySort,
  applyPostProcessing,
  mergeDataIntoContent
} from './data-fetcher.js'
export { loadDeployYml, resolveTarget, resolvePublishTarget } from './deploy-config.js'
export { recordLastDeploy, recordTarget, forgetDeploys, forgetDeployYml, retireDeployYmlKeys } from './deploy-config-writer.js'
