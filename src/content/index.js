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

// Cross-reference registry. Walks the document tree, finds every
// block-level element with a {#id} attribute, registers the id with
// its inferred kind + counter. Consumed by the framework's <Ref>
// component to render `[#id]` cross-references.
export { buildXrefRegistry } from '../site/xref-registry.js'
