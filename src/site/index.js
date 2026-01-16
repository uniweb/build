/**
 * Site Build Tools
 *
 * Vite plugins and utilities for building Uniweb sites.
 *
 * @module @uniweb/build/site
 */

export { siteContentPlugin, default } from './plugin.js'
export { collectSiteContent } from './content-collector.js'
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
