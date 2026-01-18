/**
 * Extract translatable content from site-content.json
 *
 * Walks through all pages and sections, extracting translatable
 * strings and building a manifest of translation units.
 */

import { computeHash } from './hash.js'

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

  return {
    version: '1.0',
    defaultLocale: siteContent.config?.defaultLanguage || 'en',
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
function extractFromProseMirrorDoc(doc, context, units) {
  if (!doc.content) return

  let headingIndex = { h1: 0, h2: 0, h3: 0, h4: 0 }
  let paragraphIndex = 0
  let linkIndex = 0

  for (const node of doc.content) {
    if (node.type === 'heading') {
      const text = extractTextFromNode(node)
      if (!text) continue

      const level = node.attrs?.level || 1
      const field = getHeadingField(level, headingIndex)
      headingIndex[`h${level}`]++

      addUnit(units, text, field, context)
    } else if (node.type === 'paragraph') {
      const result = extractFromParagraph(node, context, units, linkIndex)
      linkIndex = result.linkIndex

      // Add paragraph text if it's substantial (not just links/buttons)
      const plainText = extractPlainTextFromParagraph(node)
      if (plainText && plainText.length > 0) {
        const field = paragraphIndex === 0 ? 'paragraph' : `paragraph.${paragraphIndex}`
        addUnit(units, plainText, field, context)
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
 * Extract from paragraph node, handling links specially
 */
function extractFromParagraph(node, context, units, linkIndex) {
  if (!node.content) return { linkIndex }

  for (const child of node.content) {
    if (child.type === 'text' && child.marks) {
      const linkMark = child.marks.find(m => m.type === 'link')
      if (linkMark && child.text) {
        const field = linkIndex === 0 ? 'link.label' : `link.${linkIndex}.label`
        addUnit(units, child.text, field, context)
        linkIndex++
      }
    }
  }

  return { linkIndex }
}

/**
 * Extract plain text from paragraph, excluding link text
 */
function extractPlainTextFromParagraph(node) {
  if (!node.content) return ''

  const parts = []
  for (const child of node.content) {
    if (child.type === 'text') {
      // Skip if it's a link
      const isLink = child.marks?.some(m => m.type === 'link')
      if (!isLink && child.text && child.text.trim()) {
        parts.push(child.text)
      }
    }
  }

  return parts.join('').trim()
}

/**
 * Extract from list items
 */
function extractFromList(listNode, context, units) {
  if (!listNode.content) return

  listNode.content.forEach((listItem, index) => {
    if (listItem.type === 'listItem' && listItem.content) {
      for (const child of listItem.content) {
        if (child.type === 'paragraph') {
          const text = extractTextFromNode(child)
          if (text) {
            addUnit(units, text, `list.${index}`, context)
          }
        }
      }
    }
  })
}

/**
 * Extract all text content from a node
 */
function extractTextFromNode(node) {
  if (!node.content) return ''
  return node.content
    .filter(n => n.type === 'text')
    .map(n => n.text || '')
    .join('')
    .trim()
}

/**
 * Add a translation unit to the accumulator
 */
function addUnit(units, source, field, context) {
  if (!source || source.length === 0) return

  const hash = computeHash(source)

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
