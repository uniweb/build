/**
 * Merge translations into site content
 *
 * Takes site-content.json and locale translations,
 * produces translated site-content for each locale.
 *
 * Supports two translation modes:
 * 1. Hash-based (granular): Translate individual strings by hash lookup
 * 2. Free-form: Complete content replacement from markdown files
 *
 * Free-form translations are checked first, falling back to hash-based
 * when no free-form translation exists.
 */

import { computeHash } from './hash.js'
import { loadFreeformTranslation } from './freeform.js'

/**
 * Merge translations into site content for a specific locale
 *
 * @param {Object} siteContent - Original site-content.json
 * @param {Object} translations - Locale translations (hash -> translation)
 * @param {Object} options - Merge options
 * @param {boolean} [options.fallbackToSource=true] - Return source if no translation
 * @param {string} [options.locale] - Locale code for free-form lookups
 * @param {string} [options.localesDir] - Path to locales directory
 * @param {boolean} [options.freeformEnabled=false] - Enable free-form translation lookup
 * @returns {Object|Promise<Object>} Translated site content (async if freeformEnabled)
 */
export function mergeTranslations(siteContent, translations, options = {}) {
  const {
    fallbackToSource = true,
    locale = null,
    localesDir = null,
    freeformEnabled = false
  } = options

  // If free-form is enabled, use async version
  if (freeformEnabled && locale && localesDir) {
    return mergeTranslationsAsync(siteContent, translations, {
      fallbackToSource,
      locale,
      localesDir
    })
  }

  // Sync version (original behavior)
  return mergeTranslationsSync(siteContent, translations, fallbackToSource)
}

/**
 * Synchronous merge (original behavior, no free-form)
 */
function mergeTranslationsSync(siteContent, translations, fallbackToSource) {
  // Deep clone to avoid mutating original
  const translated = JSON.parse(JSON.stringify(siteContent))

  for (const page of translated.pages || []) {
    const pageRoute = page.route || '/'

    // Translate page metadata
    translatePageMeta(page, pageRoute, translations, fallbackToSource)

    // Translate section content
    for (const section of page.sections || []) {
      translateSectionSync(section, pageRoute, translations, fallbackToSource)
    }
  }

  // Translate 404 page (stored as top-level notFound)
  if (translated.notFound) {
    const pageRoute = translated.notFound.route || '/404'
    translatePageMeta(translated.notFound, pageRoute, translations, fallbackToSource)
    for (const section of translated.notFound.sections || []) {
      translateSectionSync(section, pageRoute, translations, fallbackToSource)
    }
  }

  return translated
}

/**
 * Asynchronous merge with free-form support
 */
async function mergeTranslationsAsync(siteContent, translations, options) {
  const { fallbackToSource, locale, localesDir } = options

  // Deep clone to avoid mutating original
  const translated = JSON.parse(JSON.stringify(siteContent))

  for (const page of translated.pages || []) {
    const pageRoute = page.route || '/'

    // Translate page metadata (always hash-based)
    translatePageMeta(page, pageRoute, translations, fallbackToSource)

    // Translate section content (with free-form check)
    for (const section of page.sections || []) {
      await translateSectionAsync(section, page, translations, {
        fallbackToSource,
        locale,
        localesDir
      })
    }
  }

  // Translate 404 page (stored as top-level notFound)
  if (translated.notFound) {
    const pageRoute = translated.notFound.route || '/404'
    translatePageMeta(translated.notFound, pageRoute, translations, fallbackToSource)
    for (const section of translated.notFound.sections || []) {
      await translateSectionAsync(section, translated.notFound, translations, {
        fallbackToSource,
        locale,
        localesDir
      })
    }
  }

  return translated
}

/**
 * Translate page metadata (title, description, keywords, etc.)
 */
function translatePageMeta(page, pageRoute, translations, fallbackToSource) {
  const context = { page: pageRoute, section: '_meta' }

  // Translate title
  if (page.title && typeof page.title === 'string') {
    page.title = lookupTranslation(page.title, context, translations, fallbackToSource)
  }

  // Translate label (short navigation label)
  if (page.label && typeof page.label === 'string') {
    page.label = lookupTranslation(page.label, context, translations, fallbackToSource)
  }

  // Translate description
  if (page.description && typeof page.description === 'string') {
    page.description = lookupTranslation(page.description, context, translations, fallbackToSource)
  }

  // Translate SEO fields
  if (page.seo) {
    if (page.seo.ogTitle && typeof page.seo.ogTitle === 'string') {
      page.seo.ogTitle = lookupTranslation(page.seo.ogTitle, context, translations, fallbackToSource)
    }
    if (page.seo.ogDescription && typeof page.seo.ogDescription === 'string') {
      page.seo.ogDescription = lookupTranslation(page.seo.ogDescription, context, translations, fallbackToSource)
    }
  }

  // Translate keywords
  if (page.keywords) {
    if (Array.isArray(page.keywords)) {
      page.keywords = page.keywords.map(keyword => {
        if (keyword && typeof keyword === 'string') {
          return lookupTranslation(keyword, context, translations, fallbackToSource)
        }
        return keyword
      })
    } else if (typeof page.keywords === 'string') {
      page.keywords = lookupTranslation(page.keywords, context, translations, fallbackToSource)
    }
  }
}

/**
 * Translate a section's content (synchronous, hash-based only)
 */
function translateSectionSync(section, pageRoute, translations, fallbackToSource) {
  const sectionId = section.id || 'unknown'
  const context = { page: pageRoute, section: sectionId }

  if (section.content?.type === 'doc') {
    translateProseMirrorDoc(section.content, context, translations, fallbackToSource)
  }

  // Recursively translate subsections
  for (const subsection of section.subsections || []) {
    translateSectionSync(subsection, pageRoute, translations, fallbackToSource)
  }
}

/**
 * Translate a section's content (async, with free-form check)
 *
 * Resolution order:
 * 1. Check for free-form translation (complete replacement)
 * 2. Fall back to hash-based translation (element-by-element)
 */
async function translateSectionAsync(section, page, translations, options) {
  const { fallbackToSource, locale, localesDir } = options
  const pageRoute = page.route || '/'
  const sectionId = section.id || 'unknown'
  const context = { page: pageRoute, section: sectionId }

  // Check for free-form translation first
  const freeform = await loadFreeformTranslation(section, page, locale, localesDir)

  if (freeform) {
    // Complete content replacement
    section.content = freeform.content
    // Note: We could also merge frontmatter into params here if needed
  } else {
    // Fall back to hash-based translation
    if (section.content?.type === 'doc') {
      translateProseMirrorDoc(section.content, context, translations, fallbackToSource)
    }
  }

  // Recursively translate subsections
  for (const subsection of section.subsections || []) {
    await translateSectionAsync(subsection, page, translations, options)
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
