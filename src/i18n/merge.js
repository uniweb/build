/**
 * Merge translations into site content
 *
 * Takes site-content.json and locale translations,
 * produces translated site-content for each locale.
 */

import { computeHash } from './hash.js'

/**
 * Merge translations into site content for a specific locale
 * @param {Object} siteContent - Original site-content.json
 * @param {Object} translations - Locale translations (hash -> translation)
 * @param {Object} options - Merge options
 * @returns {Object} Translated site content
 */
export function mergeTranslations(siteContent, translations, options = {}) {
  const { fallbackToSource = true } = options

  // Deep clone to avoid mutating original
  const translated = JSON.parse(JSON.stringify(siteContent))

  for (const page of translated.pages || []) {
    const pageRoute = page.route || '/'

    for (const section of page.sections || []) {
      translateSection(section, pageRoute, translations, fallbackToSource)
    }
  }

  return translated
}

/**
 * Translate a section's content
 */
function translateSection(section, pageRoute, translations, fallbackToSource) {
  const sectionId = section.id || 'unknown'
  const context = { page: pageRoute, section: sectionId }

  if (section.content?.type === 'doc') {
    translateProseMirrorDoc(section.content, context, translations, fallbackToSource)
  }

  // Recursively translate subsections
  for (const subsection of section.subsections || []) {
    translateSection(subsection, pageRoute, translations, fallbackToSource)
  }
}

/**
 * Translate text nodes in a ProseMirror document
 */
function translateProseMirrorDoc(doc, context, translations, fallbackToSource) {
  if (!doc.content) return

  for (const node of doc.content) {
    translateNode(node, context, translations, fallbackToSource)
  }
}

/**
 * Recursively translate a node and its children
 */
function translateNode(node, context, translations, fallbackToSource) {
  // Translate text content
  if (node.content) {
    for (const child of node.content) {
      if (child.type === 'text' && child.text) {
        const translated = lookupTranslation(
          child.text,
          context,
          translations,
          fallbackToSource
        )
        if (translated !== child.text) {
          child.text = translated
        }
      } else {
        // Recurse into child nodes
        translateNode(child, context, translations, fallbackToSource)
      }
    }
  }
}

/**
 * Look up translation for a piece of text
 * @param {string} source - Source text
 * @param {Object} context - Current context (page, section)
 * @param {Object} translations - Translation map
 * @param {boolean} fallbackToSource - Return source if no translation
 * @returns {string} Translated text or source
 */
function lookupTranslation(source, context, translations, fallbackToSource) {
  const trimmed = source.trim()
  if (!trimmed) return source

  const hash = computeHash(trimmed)
  const translation = translations[hash]

  if (!translation) {
    return fallbackToSource ? source : source
  }

  // Handle simple string translation
  if (typeof translation === 'string') {
    // Preserve leading/trailing whitespace from original
    const leadingSpace = source.match(/^\s*/)[0]
    const trailingSpace = source.match(/\s*$/)[0]
    return leadingSpace + translation + trailingSpace
  }

  // Handle translation with overrides
  if (typeof translation === 'object') {
    const contextKey = `${context.page}:${context.section}`

    // Check for context-specific override
    if (translation.overrides?.[contextKey]) {
      return translation.overrides[contextKey]
    }

    // Fall back to default
    if (translation.default) {
      return translation.default
    }
  }

  return fallbackToSource ? source : source
}

/**
 * Generate translated site content for all configured locales
 * @param {Object} siteContent - Original site-content.json
 * @param {Object} localeFiles - Map of locale code to translations
 * @param {Object} options - Merge options
 * @returns {Object} Map of locale code to translated content
 */
export function generateAllLocales(siteContent, localeFiles, options = {}) {
  const results = {}

  for (const [locale, translations] of Object.entries(localeFiles)) {
    results[locale] = mergeTranslations(siteContent, translations, options)
  }

  return results
}
