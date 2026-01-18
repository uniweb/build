/**
 * Search Index Generation Module
 *
 * Generates search indexes for Uniweb sites at build time.
 * The generated indexes can be loaded at runtime for client-side search.
 *
 * @module @uniweb/build/search
 *
 * @example
 * import { generateSearchIndex, isSearchEnabled } from '@uniweb/build/search'
 *
 * // Check if search is enabled
 * if (isSearchEnabled(siteContent)) {
 *   // Generate index for current locale
 *   const index = generateSearchIndex(siteContent, {
 *     locale: 'en'
 *   })
 *
 *   // Write to file
 *   writeFileSync('dist/search-index.json', JSON.stringify(index))
 * }
 */

export {
  extractSearchContent,
  extractSearchContent as default
} from './extract.js'

export {
  generateSearchIndex,
  isSearchEnabled,
  getSearchConfig,
  getSearchIndexFilename
} from './generate.js'
