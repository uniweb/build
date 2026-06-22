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
export { assembleDataBall } from './data-ball.js'
export {
  parseFetchConfig,
  executeFetch,
  applyFilter,
  applySort,
  applyPostProcessing,
  mergeDataIntoContent,
  singularize
} from './data-fetcher.js'
export { loadDeployYml, resolveTarget } from './deploy-config.js'
export { recordLastDeploy, recordTarget } from './deploy-config-writer.js'
