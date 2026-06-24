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
import { elementText, blockElements } from './extract.js'

// Inline-markdown → ProseMirror inline fragment, for resolving a whole-element
// translation VALUE (which carries marks/links/icons as inline markdown). Same
// lazy-import-with-fallback pattern as freeform.js / collection-processor.js, so
// the synchronous merge path has the converter ready at call time.
let markdownToProseMirror
try {
  const contentReader = await import('@uniweb/content-reader')
  markdownToProseMirror = contentReader.markdownToProseMirror
} catch {
  markdownToProseMirror = (markdown) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown.trim() }] }]
  })
}

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

  // Translate layout sections (header, footer, sidebars)
  // Layouts are nested under translated.layouts: { default: { header, footer, ... }, marketing: { ... } }
  if (translated.layouts) {
    for (const [layoutName, areas] of Object.entries(translated.layouts)) {
      if (!areas || typeof areas !== 'object') continue
      for (const [areaKey, layoutPage] of Object.entries(areas)) {
        if (layoutPage?.sections) {
          const pageRoute = layoutPage.route || `/layout/${layoutName === 'default' ? '' : layoutName + '/'}${areaKey}`
          for (const section of layoutPage.sections) {
            translateSectionSync(section, pageRoute, translations, fallbackToSource)
          }
        }
      }
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

  // Translate layout sections (header, footer, sidebars)
  // Layouts are nested under translated.layouts: { default: { header, footer, ... }, marketing: { ... } }
  if (translated.layouts) {
    for (const [layoutName, areas] of Object.entries(translated.layouts)) {
      if (!areas || typeof areas !== 'object') continue
      for (const [areaKey, layoutPage] of Object.entries(areas)) {
        if (layoutPage?.sections) {
          if (!layoutPage.route) layoutPage.route = `/layout/${layoutName === 'default' ? '' : layoutName + '/'}${areaKey}`
          for (const section of layoutPage.sections) {
            await translateSectionAsync(section, layoutPage, translations, {
              fallbackToSource,
              locale,
              localesDir
            })
          }
        }
      }
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
 * Resolve a ProseMirror content doc for a target locale: replace each block
 * element's inline content with its translation, looked up by the WHOLE-ELEMENT
 * key (shared with extract.js via elementText, so the two never drift). A
 * missing translation leaves the source element untouched (graceful per-element
 * fallback). The translation VALUE is inline markdown — it carries marks, inline
 * links (with their own, possibly re-targeted, href) and inline atoms — so this
 * is lossless for emphasis/links, unlike the former plain-string substitution.
 */
function translateProseMirrorDoc(doc, context, translations, fallbackToSource) {
  let changed = false
  for (const el of blockElements(doc)) {
    if (applyElementTranslation(el, context, translations, fallbackToSource)) changed = true
  }
  return changed
}

// Replace one block element's inline content with the parsed translation
// fragment. `lookupTranslation` with the already-trimmed key adds no surrounding
// whitespace and returns the source on a miss, so `value === key` means
// "no translation" → leave the element as-is. Returns true if it replaced.
function applyElementTranslation(node, context, translations, fallbackToSource) {
  const key = elementText(node)
  if (!key) return false
  const value = lookupTranslation(key, context, translations, fallbackToSource)
  if (value === key) return false
  const fragment = inlineMarkdownToFragment(value)
  if (fragment && fragment.length) {
    node.content = fragment
    return true
  }
  return false
}

/**
 * Resolve ONE ProseMirror content doc for a single target locale: a deep clone of
 * the source doc with each whole-element translated (inline content replaced from
 * the table's inline-markdown value). `table` is `{ hash: value }` for that locale.
 * Returns the resolved doc, or null when the table translated nothing in this doc
 * (so the caller can omit an untranslated locale — it falls back to the source
 * locale). Lets the sync producer emit a self-contained per-locale DOC instead of a
 * source-keyed map (which a consumer would otherwise resolve against the source).
 */
export function resolveDocForLocale(sourceDoc, table, context = { page: '', section: '' }) {
  if (!sourceDoc || sourceDoc.type !== 'doc' || !table) return null
  const doc = JSON.parse(JSON.stringify(sourceDoc))
  const changed = translateProseMirrorDoc(doc, context, table, true)
  return changed ? doc : null
}

// Parse an inline-markdown translation value into a ProseMirror inline fragment.
// A value is expected to be one element's inline content (one paragraph once
// parsed); take that paragraph's inline children. If the converter yields
// several blocks, flatten their inline content rather than drop any.
function inlineMarkdownToFragment(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const doc = markdownToProseMirror(value)
  const inline = []
  for (const block of doc?.content || []) {
    if (Array.isArray(block.content)) inline.push(...block.content)
  }
  return inline.length ? inline : [{ type: 'text', text: value.trim() }]
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
