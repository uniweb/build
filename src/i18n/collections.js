/**
 * Collection i18n support
 *
 * Extract translatable strings from collection items and merge translations.
 * Collections are separate from page content (stored in public/data/*.json).
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { computeHash } from './hash.js'

export const COLLECTIONS_DIR = 'collections'

/**
 * Extract translatable content from all collections
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Promise<Object>} Manifest with translation units
 */
export async function extractCollectionContent(siteRoot, options = {}) {
  const dataDir = join(siteRoot, 'public', 'data')

  if (!existsSync(dataDir)) {
    return { version: '1.0', units: {} }
  }

  const units = {}

  let files
  try {
    files = await readdir(dataDir)
  } catch {
    return { version: '1.0', units: {} }
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'))

  for (const file of jsonFiles) {
    const collectionName = file.replace('.json', '')
    const filePath = join(dataDir, file)

    try {
      const raw = await readFile(filePath, 'utf-8')
      const items = JSON.parse(raw)

      if (!Array.isArray(items)) continue

      for (const item of items) {
        extractFromItem(item, collectionName, units)
      }
    } catch (err) {
      // Skip files that can't be parsed
      console.warn(`[i18n] Skipping collection ${file}: ${err.message}`)
    }
  }

  return {
    version: '1.0',
    extracted: new Date().toISOString(),
    units
  }
}

/**
 * Extract translatable strings from a collection item
 * @param {Object} item - Collection item
 * @param {string} collectionName - Name of the collection
 * @param {Object} units - Units accumulator
 */
function extractFromItem(item, collectionName, units) {
  const slug = item.slug || 'unknown'
  const context = { collection: collectionName, item: slug }

  // Extract string fields from frontmatter
  // Common translatable fields
  const translatableFields = ['title', 'description', 'excerpt', 'summary', 'subtitle']

  for (const field of translatableFields) {
    if (item[field] && typeof item[field] === 'string' && item[field].trim()) {
      addUnit(units, item[field], field, context)
    }
  }

  // Extract from tags/categories if they're strings
  if (Array.isArray(item.tags)) {
    item.tags.forEach((tag, i) => {
      if (typeof tag === 'string' && tag.trim()) {
        addUnit(units, tag, `tag.${i}`, context)
      }
    })
  }

  if (Array.isArray(item.categories)) {
    item.categories.forEach((cat, i) => {
      if (typeof cat === 'string' && cat.trim()) {
        addUnit(units, cat, `category.${i}`, context)
      }
    })
  }

  // Extract from ProseMirror content body
  if (item.content?.type === 'doc') {
    extractFromProseMirrorDoc(item.content, context, units)
  }
}

/**
 * Extract from ProseMirror document
 * @param {Object} doc - ProseMirror document
 * @param {Object} context - Context for the item
 * @param {Object} units - Units accumulator
 */
function extractFromProseMirrorDoc(doc, context, units) {
  if (!doc.content) return

  let headingIndex = 0
  let paragraphIndex = 0

  for (const node of doc.content) {
    if (node.type === 'heading') {
      const text = extractTextFromNode(node)
      if (text) {
        addUnit(units, text, `content.heading.${headingIndex}`, context)
        headingIndex++
      }
    } else if (node.type === 'paragraph') {
      const text = extractTextFromNode(node)
      if (text) {
        addUnit(units, text, `content.paragraph.${paragraphIndex}`, context)
        paragraphIndex++
      }
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      extractFromList(node, context, units)
    }
  }
}

/**
 * Extract from list nodes
 */
function extractFromList(listNode, context, units) {
  if (!listNode.content) return

  listNode.content.forEach((listItem, index) => {
    if (listItem.type === 'listItem' && listItem.content) {
      for (const child of listItem.content) {
        if (child.type === 'paragraph') {
          const text = extractTextFromNode(child)
          if (text) {
            addUnit(units, text, `content.list.${index}`, context)
          }
        }
      }
    }
  })
}

/**
 * Extract text content from a node
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
    const existingContexts = units[hash].contexts
    const contextKey = `${context.collection}:${context.item}`
    const exists = existingContexts.some(
      c => `${c.collection}:${c.item}` === contextKey
    )
    if (!exists) {
      existingContexts.push({ ...context })
    }
  } else {
    units[hash] = {
      source,
      field,
      contexts: [{ ...context }]
    }
  }
}

/**
 * Merge translations into collection data and write locale-specific files
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Promise<Object>} Map of locale to output paths
 */
export async function buildLocalizedCollections(siteRoot, options = {}) {
  const {
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    collectionsLocalesDir = join(siteRoot, 'locales', COLLECTIONS_DIR)
  } = options

  const dataDir = join(siteRoot, 'public', 'data')

  if (!existsSync(dataDir)) {
    return {}
  }

  let files
  try {
    files = await readdir(dataDir)
  } catch {
    return {}
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'))

  if (jsonFiles.length === 0) {
    return {}
  }

  const outputs = {}

  for (const locale of locales) {
    // Load translations for this locale
    const localePath = join(collectionsLocalesDir, `${locale}.json`)
    let translations = {}
    if (existsSync(localePath)) {
      try {
        translations = JSON.parse(await readFile(localePath, 'utf-8'))
      } catch {
        // Use empty translations if file can't be parsed
      }
    }

    // Create locale data directory
    const localeDataDir = join(outputDir, locale, 'data')
    await mkdir(localeDataDir, { recursive: true })

    outputs[locale] = {}

    for (const file of jsonFiles) {
      const collectionName = file.replace('.json', '')
      const sourcePath = join(dataDir, file)

      try {
        const raw = await readFile(sourcePath, 'utf-8')
        const items = JSON.parse(raw)

        if (!Array.isArray(items)) {
          // Copy as-is if not an array
          const destPath = join(localeDataDir, file)
          await writeFile(destPath, raw)
          outputs[locale][collectionName] = destPath
          continue
        }

        // Translate each item
        const translatedItems = items.map(item =>
          translateItem(item, collectionName, translations)
        )

        const destPath = join(localeDataDir, file)
        await writeFile(destPath, JSON.stringify(translatedItems, null, 2))
        outputs[locale][collectionName] = destPath
      } catch (err) {
        console.warn(`[i18n] Failed to translate collection ${file}: ${err.message}`)
      }
    }
  }

  return outputs
}

/**
 * Apply translations to a collection item
 */
function translateItem(item, collectionName, translations) {
  const translated = { ...item }
  const slug = item.slug || 'unknown'
  const context = { collection: collectionName, item: slug }

  // Translate frontmatter fields
  const translatableFields = ['title', 'description', 'excerpt', 'summary', 'subtitle']

  for (const field of translatableFields) {
    if (translated[field] && typeof translated[field] === 'string') {
      translated[field] = lookupTranslation(
        translated[field],
        context,
        translations
      )
    }
  }

  // Translate tags
  if (Array.isArray(translated.tags)) {
    translated.tags = translated.tags.map(tag => {
      if (typeof tag === 'string') {
        return lookupTranslation(tag, context, translations)
      }
      return tag
    })
  }

  // Translate categories
  if (Array.isArray(translated.categories)) {
    translated.categories = translated.categories.map(cat => {
      if (typeof cat === 'string') {
        return lookupTranslation(cat, context, translations)
      }
      return cat
    })
  }

  // Translate ProseMirror content
  if (translated.content?.type === 'doc') {
    translated.content = translateProseMirrorDoc(
      translated.content,
      context,
      translations
    )
  }

  return translated
}

/**
 * Translate a ProseMirror document
 */
function translateProseMirrorDoc(doc, context, translations) {
  if (!doc.content) return doc

  const translated = { ...doc, content: [] }

  for (const node of doc.content) {
    translated.content.push(translateNode(node, context, translations))
  }

  return translated
}

/**
 * Recursively translate a node
 */
function translateNode(node, context, translations) {
  if (!node.content) return node

  const translated = { ...node, content: [] }

  for (const child of node.content) {
    if (child.type === 'text' && child.text) {
      const translatedText = lookupTranslation(child.text, context, translations)
      translated.content.push({ ...child, text: translatedText })
    } else {
      translated.content.push(translateNode(child, context, translations))
    }
  }

  return translated
}

/**
 * Look up translation for a piece of text
 */
function lookupTranslation(source, context, translations) {
  const trimmed = source.trim()
  if (!trimmed) return source

  const hash = computeHash(trimmed)
  const translation = translations[hash]

  if (!translation) return source

  if (typeof translation === 'string') {
    // Preserve leading/trailing whitespace from original
    const leadingSpace = source.match(/^\s*/)[0]
    const trailingSpace = source.match(/\s*$/)[0]
    return leadingSpace + translation + trailingSpace
  }

  if (typeof translation === 'object' && translation !== null) {
    const contextKey = `${context.collection}:${context.item}`
    if (translation.overrides?.[contextKey]) {
      return translation.overrides[contextKey]
    }
    if (translation.default) {
      return translation.default
    }
  }

  return source
}

/**
 * Get available collection locales
 * @param {string} localesPath - Path to locales directory
 * @returns {Promise<string[]>} Array of locale codes
 */
export async function getCollectionLocales(localesPath) {
  const collectionsDir = join(localesPath, COLLECTIONS_DIR)
  if (!existsSync(collectionsDir)) return []

  try {
    const files = await readdir(collectionsDir)
    return files
      .filter(f => f.endsWith('.json') && f !== 'manifest.json')
      .map(f => f.replace('.json', ''))
      .sort()
  } catch {
    return []
  }
}
