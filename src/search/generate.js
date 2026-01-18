/**
 * Generate search index from site content
 *
 * Creates a JSON search index file that can be loaded at runtime
 * for client-side search functionality.
 */

import { extractSearchContent } from './extract.js'

/**
 * Generate search index for a site
 * @param {Object} siteContent - Parsed site-content.json
 * @param {Object} options - Generation options
 * @param {string} [options.locale] - Locale code for this index
 * @param {Object} [options.extract] - Options passed to extractSearchContent
 * @param {Object} [options.search] - Search configuration from site.yml
 * @returns {Object} Search index object
 */
export function generateSearchIndex(siteContent, options = {}) {
  const {
    locale = siteContent.config?.activeLocale || siteContent.config?.defaultLanguage || 'en',
    extract: extractOptions = {},
    search: searchConfig = {}
  } = options

  // Merge search config with extract options
  const mergedExtractOptions = {
    ...extractOptions,
    excludeRoutes: searchConfig.exclude?.routes || extractOptions.excludeRoutes || [],
    excludeComponents: searchConfig.exclude?.components || extractOptions.excludeComponents || []
  }

  // Check what to include from config
  if (searchConfig.include) {
    mergedExtractOptions.pages = searchConfig.include.pages !== false
    mergedExtractOptions.sections = searchConfig.include.sections !== false
    mergedExtractOptions.headings = searchConfig.include.headings !== false
    mergedExtractOptions.paragraphs = searchConfig.include.paragraphs !== false
    mergedExtractOptions.links = searchConfig.include.links !== false
    mergedExtractOptions.lists = searchConfig.include.lists !== false
  }

  // Extract searchable content
  const entries = extractSearchContent(siteContent, mergedExtractOptions)

  // Build the index
  const index = {
    version: '1.0',
    locale,
    generated: new Date().toISOString(),
    count: entries.length,
    entries
  }

  return index
}

/**
 * Check if search is enabled for a site
 * @param {Object} siteContent - Parsed site-content.json
 * @returns {boolean}
 */
export function isSearchEnabled(siteContent) {
  // Search is enabled by default unless explicitly disabled
  return siteContent.config?.search?.enabled !== false
}

/**
 * Get search configuration from site content
 * @param {Object} siteContent - Parsed site-content.json
 * @returns {Object} Search configuration
 */
export function getSearchConfig(siteContent) {
  const config = siteContent.config?.search || {}

  return {
    enabled: config.enabled !== false,
    include: {
      pages: config.include?.pages !== false,
      sections: config.include?.sections !== false,
      headings: config.include?.headings !== false,
      paragraphs: config.include?.paragraphs !== false,
      links: config.include?.links !== false,
      lists: config.include?.lists !== false
    },
    exclude: {
      routes: config.exclude?.routes || [],
      components: config.exclude?.components || []
    }
  }
}

/**
 * Get the search index filename for a locale
 * @param {string} locale - Locale code
 * @param {string} defaultLocale - Default locale code
 * @returns {string} Filename
 */
export function getSearchIndexFilename(locale, defaultLocale) {
  // Default locale uses root filename, others use locale prefix path
  if (locale === defaultLocale) {
    return 'search-index.json'
  }
  return `${locale}/search-index.json`
}

export default generateSearchIndex
