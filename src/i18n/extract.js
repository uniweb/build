/**
 * Extract translatable content from site-content.json
 *
 * Walks through all pages and sections, extracting translatable
 * strings and building a manifest of translation units.
 */

import { resolveDefaultLocale } from '@uniweb/core'
import { computeHash, stripInlineTags } from './hash.js'

/**
 * Extract all translatable units from site content
 * @param {Object} siteContent - Parsed site-content.json
 * @returns {Object} Manifest with translation units
 */
export function extractTranslatableContent(siteContent) {
  const units = {}

  for (const page of siteContent.pages || []) {
    const pageRoute = page.route || '/'

    // Extract page metadata (title, description, keywords from page.yml)
    extractFromPageMeta(page, pageRoute, units)

    // Extract section content
    for (const section of page.sections || []) {
      extractFromSection(section, pageRoute, units)
    }
  }

  // Extract from 404 page (stored as top-level notFound)
  if (siteContent.notFound) {
    const notFoundPage = siteContent.notFound
    const pageRoute = notFoundPage.route || '/404'
    extractFromPageMeta(notFoundPage, pageRoute, units)
    for (const section of notFoundPage.sections || []) {
      extractFromSection(section, pageRoute, units)
    }
  }

  // Extract from layout areas (header, footer, left, right panels)
  // Layouts are nested under siteContent.layouts: { default: { header, footer, ... }, marketing: { ... } }
  if (siteContent.layouts) {
    for (const [layoutName, areas] of Object.entries(siteContent.layouts)) {
      if (!areas || typeof areas !== 'object') continue
      for (const [areaKey, layoutPage] of Object.entries(areas)) {
        if (layoutPage?.sections) {
          const pageRoute = layoutPage.route || `/layout/${layoutName === 'default' ? '' : layoutName + '/'}${areaKey}`
          for (const section of layoutPage.sections) {
            extractFromSection(section, pageRoute, units)
          }
        }
      }
    }
  }

  return {
    version: '1.0',
    defaultLocale: resolveDefaultLocale(siteContent.config),
    extracted: new Date().toISOString(),
    units
  }
}

/**
 * Extract translatable page metadata
 * @param {Object} page - Page data
 * @param {string} pageRoute - Page route
 * @param {Object} units - Units accumulator
 */
function extractFromPageMeta(page, pageRoute, units) {
  // Use special section identifier for page-level metadata
  const context = { page: pageRoute, section: '_meta' }

  // Page title
  if (page.title && typeof page.title === 'string') {
    addUnit(units, page.title, 'page.title', context)
  }

  // Page label (short navigation label, distinct from title)
  if (page.label && typeof page.label === 'string') {
    addUnit(units, page.label, 'page.label', context)
  }

  // Page description
  if (page.description && typeof page.description === 'string') {
    addUnit(units, page.description, 'page.description', context)
  }

  // SEO-specific fields (if present)
  if (page.seo) {
    // og:title, og:description might be different from page title/description
    if (page.seo.ogTitle && typeof page.seo.ogTitle === 'string') {
      addUnit(units, page.seo.ogTitle, 'page.seo.ogTitle', context)
    }
    if (page.seo.ogDescription && typeof page.seo.ogDescription === 'string') {
      addUnit(units, page.seo.ogDescription, 'page.seo.ogDescription', context)
    }
  }

  // Keywords (if array, join for translation context)
  if (page.keywords) {
    if (Array.isArray(page.keywords)) {
      // Each keyword as separate unit for flexibility
      page.keywords.forEach((keyword, index) => {
        if (keyword && typeof keyword === 'string') {
          addUnit(units, keyword, `page.keyword.${index}`, context)
        }
      })
    } else if (typeof page.keywords === 'string') {
      addUnit(units, page.keywords, 'page.keywords', context)
    }
  }
}

/**
 * Extract translatable content from a section
 * @param {Object} section - Section data
 * @param {string} pageRoute - Parent page route
 * @param {Object} units - Units accumulator
 */
function extractFromSection(section, pageRoute, units) {
  const sectionId = section.id || 'unknown'
  const context = { page: pageRoute, section: sectionId }

  // Extract from parsed semantic content if available
  // The section.content is ProseMirror doc, but we need parsed content
  // For now, we'll extract from the raw ProseMirror structure
  // In practice, this should use semantic-parser output

  if (section.content?.type === 'doc') {
    extractFromProseMirrorDoc(section.content, context, units)
  }

  // Recursively process subsections
  for (const subsection of section.subsections || []) {
    extractFromSection(subsection, pageRoute, units)
  }
}

/**
 * Extract translatable strings from ProseMirror document
 * @param {Object} doc - ProseMirror document
 * @param {Object} context - Current context (page, section)
 * @param {Object} units - Units accumulator
 */
/**
 * Extract the translatable units from a SINGLE ProseMirror content doc, keyed by
 * the same 8-char hash the site-wide extractor uses. Reused by the sync producer
 * to build a section's per-locale structural translation map (so there is one
 * extraction implementation, not a second copy).
 *
 * @param {Object} doc - a ProseMirror document (`{ type: 'doc', content: [...] }`)
 * @returns {Object} `{ [hash]: { source, field, contexts } }`
 */
export function extractUnitsFromDoc(doc) {
  const units = {}
  if (doc && doc.content) extractFromProseMirrorDoc(doc, { page: '', section: '' }, units)
  return units
}

function extractFromProseMirrorDoc(doc, context, units) {
  if (!doc.content) return

  let headingIndex = { h1: 0, h2: 0, h3: 0, h4: 0 }
  let paragraphIndex = 0

  for (const node of doc.content) {
    if (node.type === 'heading') {
      const text = elementText(node)
      if (!text) continue

      const level = node.attrs?.level || 1
      const field = getHeadingField(level, headingIndex)
      headingIndex[`h${level}`]++

      addUnit(units, text, field, context)
    } else if (node.type === 'paragraph') {
      // Whole-element keying: ONE unit per paragraph, with link text kept INLINE
      // (not split into a separate link.label unit). The conformance gate is
      // tests/i18n/structural-keying-vectors.json (vectors A–H).
      const text = elementText(node)
      if (text) {
        const field = paragraphIndex === 0 ? 'paragraph' : `paragraph.${paragraphIndex}`
        addUnit(units, text, field, context)
        paragraphIndex++
      }
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      extractFromList(node, context, units)
    }
  }
}

/**
 * Determine field name for heading based on level and index
 */
function getHeadingField(level, index) {
  // First H1 is title, first H2 is subtitle, H3 before H1 could be pretitle
  // This is simplified - semantic-parser does this more intelligently
  if (level === 1) return index.h1 === 0 ? 'title' : `heading.${index.h1}`
  if (level === 2) return index.h2 === 0 ? 'subtitle' : `heading.h2.${index.h2}`
  if (level === 3) return `heading.h3.${index.h3}`
  return `heading.h${level}.${index[`h${level}`]}`
}

/**
 * Extract from list items — one whole-element unit per list item (link text
 * stays inline, same rule as paragraphs; vectors G and H).
 */
function extractFromList(listNode, context, units) {
  if (!listNode.content) return

  listNode.content.forEach((listItem, index) => {
    if (listItem.type === 'listItem' && listItem.content) {
      for (const child of listItem.content) {
        if (child.type === 'paragraph') {
          const text = elementText(child)
          if (text) {
            addUnit(units, text, `list.${index}`, context)
          }
        }
      }
    }
  })
}

/**
 * A block element's cleaned source text — the WHOLE-ELEMENT translation key.
 * ALL inline marks (bold, italic, link, span, …) flatten into the text: link
 * text stays INLINE (not split out), spans contribute their plain text (no
 * `<N>` tags in the key). Inline atom nodes (image/icon/emoji/math/hardBreak)
 * are skipped. Leading/trailing whitespace is trimmed; internal whitespace is
 * preserved (the hash collapses it for matching — see hash.js normalizeText).
 */
export function elementText(node) {
  return collectInlineText(node).trim()
}

function collectInlineText(node) {
  if (!node || !node.content) return ''
  let out = ''
  for (const child of node.content) {
    if (child.type === 'text') {
      out += child.text || ''
    } else if (child.type === 'hardBreak') {
      // A break must contribute a separator or the words either side fuse
      // ("line oneline two"), silently changing the unit key. "\n" is the
      // pinned separator — see vector I. computeHash normalizes whitespace, so
      // it hashes identically to " "; only the raw structural-map key differs.
      out += '\n'
    } else if (child.content) {
      // recurse through inline wrappers into their text
      out += collectInlineText(child)
    }
    // else: other inline atom (image/icon/emoji/math) → contributes no text
  }
  return out
}

/**
 * The translatable block elements of a content doc, in document order, with the
 * SAME coverage as extraction above (headings, paragraphs, and each list item's
 * paragraphs). Shared by the merge resolver (push) and the pull-side
 * structural-map derivation so all paths walk identically and keys never drift.
 * Returns the element nodes themselves — callers read `.type`/`.content` and key
 * them via elementText.
 */
export function blockElements(doc) {
  const out = []
  for (const node of doc?.content || []) {
    if (node.type === 'heading' || node.type === 'paragraph') {
      out.push(node)
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const listItem of node.content || []) {
        if (listItem.type === 'listItem' && listItem.content) {
          for (const child of listItem.content) {
            if (child.type === 'paragraph') out.push(child)
          }
        }
      }
    }
  }
  return out
}

/**
 * Add a translation unit to the accumulator
 */
function addUnit(units, source, field, context) {
  if (!source || source.length === 0) return

  // Hash on plain text (strip inline tags) so keys stay stable
  const hash = computeHash(stripInlineTags(source))

  if (units[hash]) {
    // Unit exists - add context if not already present
    const existingContexts = units[hash].contexts
    const contextKey = `${context.page}:${context.section}`
    const exists = existingContexts.some(
      c => `${c.page}:${c.section}` === contextKey
    )
    if (!exists) {
      existingContexts.push({ ...context })
    }
  } else {
    // New unit
    units[hash] = {
      source,
      field,
      contexts: [{ ...context }]
    }
  }
}
