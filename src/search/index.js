/**
 * Search Index Generation Module
 *
 * Re-export of `@uniweb/projections/search`. The implementation moved there so
 * one copy serves every publisher of a site — the CLI and the app both import
 * it, and the backend stores the result rather than generating its own. This
 * shim keeps `@uniweb/build/search` and every existing call site working.
 *
 * @module @uniweb/build/search
 */

export {
  extractSearchContent,
  extractSearchContent as default,
  generateSearchIndex,
  isSearchEnabled,
  getSearchConfig,
  getSearchIndexFilename,
  generateCollectionIndex
} from '@uniweb/projections/search'
