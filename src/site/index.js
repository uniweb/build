/**
 * Site Build Tools
 *
 * Vite plugins and utilities for building Uniweb sites.
 *
 * @module @uniweb/build/site
 */

export { siteContentPlugin } from './plugin.js'
export { defineSiteConfig, readSiteConfig, default } from './config.js'
export { collectSiteContent } from './content-collector.js'
// The `agents:` vocabulary lives in @uniweb/projections (which owns the block);
// re-exported so the CLI can validate an author's spelling without taking a
// direct dependency on it. Same shape as the search re-exports.
export { AGENTS_KEYS } from '@uniweb/projections'
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
  processCollections,
  writeCollectionFiles,
  getCollectionLastModified
} from './collection-processor.js'
export { assembleDataBall, collectBallAssets, rewriteBallAssets } from './data-ball.js'
export {
  parseFetchConfig,
  executeFetch,
  applyFilter,
  applySort,
  applyPostProcessing,
  mergeDataIntoContent
} from './data-fetcher.js'
export { loadDeployYml, resolveTarget } from './deploy-config.js'
export { recordLastDeploy, recordTarget } from './deploy-config-writer.js'
