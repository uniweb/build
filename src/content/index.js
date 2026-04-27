/**
 * Clean Content Entry Point
 *
 * Exposes content-collection helpers and their clean dependency chain
 * (Node builtins, js-yaml, @uniweb/theming, @uniweb/core). No Vite,
 * sharp, or React. Used by Studio's sidecar (Bun-compiled binary) and
 * by @uniweb/unipress (CLI compile path) where those heavy peer/native
 * dependencies aren't available.
 *
 * @module @uniweb/build/content
 */

export { collectSiteContent } from '../site/content-collector.js'

// Collections + fetch resolution. Pure functions on the clean dep
// chain — re-exported here so headless callers (unipress, sidecars)
// can resolve `collections:` declarations without importing
// `@uniweb/build/site` (which pulls Vite via its plugin index).
export {
  processCollections,
  writeCollectionFiles,
  getCollectionLastModified,
} from '../site/collection-processor.js'
export {
  parseFetchConfig,
  executeFetch,
  applyFilter,
  applySort,
  applyPostProcessing,
  mergeDataIntoContent,
  singularize,
} from '../site/data-fetcher.js'

// Cross-reference registry moved out of build into kit
// (@uniweb/kit/xref). Foundations that need cross-references import
// `buildXrefRegistry` from there and re-export it via
// `foundation.xref.build`; the runtime calls it during initialization
// (setup.js / ssr-renderer.js). See framework/kit/src/xref/registry.js
// for the implementation.
