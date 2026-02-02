/**
 * Collection i18n support
 *
 * Extract translatable strings from collection items and merge translations.
 * Collections are separate from page content (stored in public/data/*.json).
 *
 * Supports three extraction modes:
 * 1. Schema-guided — companion .schema.js or standard @uniweb/schemas
 * 2. Heuristic — recursive walk, extract all strings, skip structural patterns
 * 3. Legacy — flat field list (fallback within heuristic)
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { computeHash } from './hash.js'
import { loadFreeformCollectionItem } from './freeform.js'

export const COLLECTIONS_DIR = 'collections'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Types that are never translatable regardless of schema */
const NON_TRANSLATABLE_TYPES = new Set([
  'number', 'boolean', 'date', 'datetime', 'url', 'email', 'image'
])

/** Field names skipped by the heuristic extractor (structural, not human-readable) */
const HEURISTIC_SKIP_FIELDS = new Set([
  'slug', 'id', 'type', 'status', 'href', 'url', 'src', 'icon',
  'target', 'email', 'phone', 'orcid', 'doi', 'arxiv', 'isbn',
  'pmid', 'bibtex', 'pdf', 'code', 'data', 'slides', 'video',
  'repository', 'caseStudy', 'website', 'avatar', 'image',
  'thumbnail', 'currency', 'order', 'hidden', 'current',
  'featured', 'published', 'allDay', 'remote', 'hybrid',
  'noindex', 'corresponding', 'required', 'virtual',
  'lastModified', 'date', 'updated', 'posted', 'submitted',
  'accepted', 'startDate', 'endDate', 'deadline',
  'readTime', 'citations', 'capacity', 'volume', 'issue', 'pages',
  'time', 'timezone',
])

/** String patterns that indicate non-translatable values */
const HEURISTIC_SKIP_PATTERNS = [
  /^https?:\/\//,                  // URLs
  /^mailto:/,                      // mailto links
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,   // email addresses
  /^\d{4}-\d{2}-\d{2}/,           // ISO dates
  /^#[0-9a-fA-F]{3,8}$/,          // hex colors
  /^[\w./\\-]+\.\w{2,4}$/,        // file paths (e.g., ./logo.svg, /img/hero.jpg)
  /^[A-Z]{3}$/,                   // currency codes (USD, EUR)
  /^\d+(\.\d+)?$/,                // plain numbers as strings
  /^\d{1,2}:\d{2}(:\d{2})?$/,    // times (09:00, 14:30:00)
]

/** Max recursion depth for heuristic extraction */
const MAX_HEURISTIC_DEPTH = 5

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

/** Cache for resolved schemas (collection name → schema or null) */
const schemaCache = new Map()

/**
 * Resolve schema for a collection.
 *
 * Discovery order:
 * 1. Companion file: public/data/<name>.schema.js (ESM default export)
 * 2. Standard schema: @uniweb/schemas by collection name (with naive singularization)
 * 3. null (no schema found → heuristic fallback)
 *
 * @param {string} collectionName
 * @param {string} siteRoot
 * @returns {Promise<Object|null>}
 */
async function resolveSchema(collectionName, siteRoot) {
  if (schemaCache.has(collectionName)) {
    return schemaCache.get(collectionName)
  }

  let schema = null

  // 1. Companion schema file
  const companionPath = join(siteRoot, 'public', 'data', `${collectionName}.schema.js`)
  if (existsSync(companionPath)) {
    try {
      const mod = await import(pathToFileURL(companionPath).href)
      schema = mod.default || mod
      schemaCache.set(collectionName, schema)
      return schema
    } catch (err) {
      console.warn(`[i18n] Failed to load companion schema ${companionPath}: ${err.message}`)
    }
  }

  // 2. Standard schema from @uniweb/schemas (try exact name + singularized)
  try {
    const schemasModule = await import('@uniweb/schemas')
    const names = [collectionName, singularize(collectionName)]

    for (const name of names) {
      if (schemasModule.schemas?.[name]) {
        schema = schemasModule.schemas[name]
        break
      }
    }
  } catch {
    // @uniweb/schemas not installed — that's fine
  }

  schemaCache.set(collectionName, schema)
  return schema
}

/**
 * Naive singularization for schema lookup.
 * Handles common plural suffixes: articles→article, opportunities→opportunity
 */
function singularize(name) {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y'
  if (name.endsWith('ses') || name.endsWith('xes') || name.endsWith('zes')) return name.slice(0, -2)
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1)
  return name
}

// ---------------------------------------------------------------------------
// Field translatability
// ---------------------------------------------------------------------------

/**
 * Determine if a schema field should be extracted for translation.
 *
 * @param {Object} fieldDef - Schema field definition
 * @returns {'yes'|'no'|'recurse'} Whether the field is translatable
 */
function isFieldTranslatable(fieldDef) {
  // Explicit override always wins
  if (fieldDef.translatable === true) return 'yes'
  if (fieldDef.translatable === false) return 'no'

  const type = fieldDef.type

  // Types that are never translatable
  if (NON_TRANSLATABLE_TYPES.has(type)) return 'no'

  // Markdown is always translatable
  if (type === 'markdown') return 'yes'

  // Strings with enum default to NOT translatable (status codes, types)
  if (type === 'string' && fieldDef.enum) return 'no'

  // Plain strings default to translatable
  if (type === 'string') return 'yes'

  // Objects and arrays: recurse into their nested definitions
  if (type === 'object' || type === 'array') return 'recurse'

  // Unknown types: skip
  return 'no'
}

// ---------------------------------------------------------------------------
// Schema-guided extraction
// ---------------------------------------------------------------------------

/**
 * Extract translatable fields from an item using a schema.
 *
 * @param {Object} item - Data item
 * @param {Object} schema - Schema with `fields`
 * @param {string} collectionName
 * @param {Object} units - Accumulator
 */
function extractWithSchema(item, schema, collectionName, units) {
  const slug = item.slug || item.id || item.name || 'unknown'
  const context = { collection: collectionName, item: slug }

  extractFromItemWithSchema(item, schema.fields, '', context, units)

  // Also extract ProseMirror content body (not covered by schema fields)
  if (item.content?.type === 'doc') {
    extractFromProseMirrorDoc(item.content, context, units)
  }
}

/**
 * Recursively extract translatable fields guided by schema.
 */
function extractFromItemWithSchema(data, fields, pathPrefix, context, units) {
  if (!data || typeof data !== 'object') return

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const value = data[fieldName]
    if (value === undefined || value === null) continue

    const fieldPath = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName
    const translatable = isFieldTranslatable(fieldDef)

    if (translatable === 'yes') {
      if (typeof value === 'string' && value.trim()) {
        addUnit(units, value, fieldPath, context)
      }
    } else if (translatable === 'recurse') {
      if (fieldDef.type === 'object' && fieldDef.fields && typeof value === 'object' && !Array.isArray(value)) {
        extractFromItemWithSchema(value, fieldDef.fields, fieldPath, context, units)
      } else if (fieldDef.type === 'array' && Array.isArray(value)) {
        const itemDef = fieldDef.items
        if (itemDef) {
          value.forEach((elem, i) => {
            const elemPath = `${fieldPath}[${i}]`
            if (itemDef.type === 'object' && itemDef.fields && typeof elem === 'object') {
              extractFromItemWithSchema(elem, itemDef.fields, elemPath, context, units)
            } else if (itemDef.type === 'string') {
              // Array of strings — check item-level translatable
              const itemTranslatable = isFieldTranslatable(itemDef)
              if (itemTranslatable === 'yes' && typeof elem === 'string' && elem.trim()) {
                addUnit(units, elem, elemPath, context)
              }
            }
          })
        }
      }
    }
    // translatable === 'no' → skip
  }
}

// ---------------------------------------------------------------------------
// Heuristic extraction (no schema)
// ---------------------------------------------------------------------------

/**
 * Extract translatable fields from an item using heuristics.
 * Recursively walks the data, extracting strings that look like human-readable text.
 */
function extractHeuristic(item, collectionName, units) {
  const slug = item.slug || item.id || item.name || 'unknown'
  const context = { collection: collectionName, item: slug }

  extractFromItemHeuristic(item, '', context, units, 0)

  // Also extract ProseMirror content body
  if (item.content?.type === 'doc') {
    extractFromProseMirrorDoc(item.content, context, units)
  }
}

/**
 * Recursively extract strings that look translatable.
 */
function extractFromItemHeuristic(data, pathPrefix, context, units, depth) {
  if (!data || typeof data !== 'object' || depth > MAX_HEURISTIC_DEPTH) return

  const entries = Array.isArray(data)
    ? data.map((v, i) => [`[${i}]`, v])
    : Object.entries(data)

  for (const [key, value] of entries) {
    // Build the field path
    const fieldPath = Array.isArray(data)
      ? `${pathPrefix}${key}`
      : (pathPrefix ? `${pathPrefix}.${key}` : key)

    if (value === undefined || value === null) continue

    // Skip ProseMirror content (handled separately)
    if (key === 'content' && typeof value === 'object' && value?.type === 'doc') continue

    if (typeof value === 'string') {
      // Skip known structural field names
      if (!Array.isArray(data) && HEURISTIC_SKIP_FIELDS.has(key)) continue

      // Skip strings matching structural patterns
      if (isStructuralString(value)) continue

      // Must have non-empty trimmed content
      if (!value.trim()) continue

      addUnit(units, value, fieldPath, context)
    } else if (typeof value === 'object') {
      // Recurse into objects and arrays
      extractFromItemHeuristic(value, fieldPath, context, units, depth + 1)
    }
    // Skip numbers, booleans
  }
}

/**
 * Check if a string value looks structural (not human-readable).
 */
function isStructuralString(value) {
  return HEURISTIC_SKIP_PATTERNS.some(pattern => pattern.test(value))
}

// ---------------------------------------------------------------------------
// Schema-guided translation
// ---------------------------------------------------------------------------

/**
 * Translate item fields using schema guidance.
 */
function translateWithSchema(item, schema, context, translations, includeContent = true) {
  const translated = { ...item }
  translateItemWithSchema(translated, schema.fields, context, translations)

  // Translate ProseMirror content
  if (includeContent && translated.content?.type === 'doc') {
    translated.content = translateProseMirrorDoc(translated.content, context, translations)
  }

  return translated
}

/**
 * Recursively translate fields guided by schema.
 */
function translateItemWithSchema(data, fields, context, translations) {
  if (!data || typeof data !== 'object') return

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const value = data[fieldName]
    if (value === undefined || value === null) continue

    const translatable = isFieldTranslatable(fieldDef)

    if (translatable === 'yes') {
      if (typeof value === 'string') {
        data[fieldName] = lookupTranslation(value, context, translations)
      }
    } else if (translatable === 'recurse') {
      if (fieldDef.type === 'object' && fieldDef.fields && typeof value === 'object' && !Array.isArray(value)) {
        translateItemWithSchema(value, fieldDef.fields, context, translations)
      } else if (fieldDef.type === 'array' && Array.isArray(value)) {
        const itemDef = fieldDef.items
        if (itemDef) {
          value.forEach((elem, i) => {
            if (itemDef.type === 'object' && itemDef.fields && typeof elem === 'object') {
              translateItemWithSchema(elem, itemDef.fields, context, translations)
            } else if (itemDef.type === 'string') {
              const itemTranslatable = isFieldTranslatable(itemDef)
              if (itemTranslatable === 'yes' && typeof elem === 'string') {
                value[i] = lookupTranslation(elem, context, translations)
              }
            }
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Heuristic translation (no schema)
// ---------------------------------------------------------------------------

/**
 * Translate item fields using heuristics.
 */
function translateHeuristic(item, context, translations, includeContent = true) {
  const translated = { ...item }
  translateItemHeuristic(translated, context, translations, 0)

  if (includeContent && translated.content?.type === 'doc') {
    translated.content = translateProseMirrorDoc(translated.content, context, translations)
  }

  return translated
}

/**
 * Recursively translate strings that look translatable.
 */
function translateItemHeuristic(data, context, translations, depth) {
  if (!data || typeof data !== 'object' || depth > MAX_HEURISTIC_DEPTH) return

  const keys = Array.isArray(data)
    ? data.map((_, i) => i)
    : Object.keys(data)

  for (const key of keys) {
    const value = data[key]
    if (value === undefined || value === null) continue

    // Skip ProseMirror content (handled separately)
    if (key === 'content' && typeof value === 'object' && value?.type === 'doc') continue

    if (typeof value === 'string') {
      if (!Array.isArray(data) && HEURISTIC_SKIP_FIELDS.has(key)) continue
      if (isStructuralString(value)) continue
      if (!value.trim()) continue

      data[key] = lookupTranslation(value, context, translations)
    } else if (typeof value === 'object') {
      translateItemHeuristic(value, context, translations, depth + 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

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

      // Resolve schema once per collection
      const schema = await resolveSchema(collectionName, siteRoot)

      for (const item of items) {
        if (schema?.fields) {
          extractWithSchema(item, schema, collectionName, units)
        } else {
          extractHeuristic(item, collectionName, units)
        }
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

// ---------------------------------------------------------------------------
// ProseMirror extraction helpers (unchanged)
// ---------------------------------------------------------------------------

/**
 * Extract from ProseMirror document
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

// ---------------------------------------------------------------------------
// Unit accumulator
// ---------------------------------------------------------------------------

/**
 * Add a translation unit to the accumulator
 */
function addUnit(units, source, field, context) {
  if (!source || source.length === 0) return

  const hash = computeHash(source)

  if (units[hash]) {
    const existingContexts = units[hash].contexts || []
    units[hash].contexts = existingContexts
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

// ---------------------------------------------------------------------------
// Translation entry points
// ---------------------------------------------------------------------------

/**
 * Merge translations into collection data and write locale-specific files
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @param {boolean} [options.freeformEnabled=true] - Enable free-form translation support
 * @returns {Promise<Object>} Map of locale to output paths
 */
export async function buildLocalizedCollections(siteRoot, options = {}) {
  const {
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    collectionsLocalesDir = join(siteRoot, 'locales', COLLECTIONS_DIR),
    localesDir = join(siteRoot, 'locales'),
    freeformEnabled = true
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

    // Check if free-form translations exist for this locale
    const freeformDir = join(localesDir, 'freeform', locale)
    const hasFreeform = freeformEnabled && existsSync(freeformDir)

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

        // Resolve schema once per collection
        const schema = await resolveSchema(collectionName, siteRoot)

        // Translate each item (with free-form support)
        const translatedItems = await Promise.all(
          items.map(item =>
            translateItemAsync(item, collectionName, translations, schema, {
              locale,
              localesDir,
              freeformEnabled: hasFreeform
            })
          )
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
 * Apply translations to a collection item (async, with free-form support)
 *
 * Resolution order:
 * 1. Check for free-form translation (complete or partial replacement)
 * 2. Fall back to hash-based translation (schema-guided or heuristic)
 */
async function translateItemAsync(item, collectionName, translations, schema, options = {}) {
  const { locale, localesDir, freeformEnabled } = options
  const translated = { ...item }
  const slug = item.slug || item.id || item.name || 'unknown'
  const context = { collection: collectionName, item: slug }

  // Check for free-form translation first
  if (freeformEnabled && locale && localesDir) {
    const freeform = await loadFreeformCollectionItem(item, collectionName, locale, localesDir)

    if (freeform) {
      // Merge free-form data (supports partial: frontmatter only, body only, or both)
      if (freeform.frontmatter) {
        Object.assign(translated, freeform.frontmatter)
      }
      if (freeform.content) {
        translated.content = freeform.content
        // Skip hash-based content translation since we have free-form
        // Still translate frontmatter fields via schema/heuristic
        if (schema?.fields) {
          return translateWithSchema(translated, schema, context, translations, false)
        }
        return translateHeuristic(translated, context, translations, false)
      }
    }
  }

  // Fall back to hash-based translation
  return translateItemSync(translated, collectionName, translations, schema)
}

/**
 * Apply translations to a collection item (sync, hash-based only)
 */
function translateItemSync(item, collectionName, translations, schema) {
  const translated = { ...item }
  const slug = item.slug || item.id || item.name || 'unknown'
  const context = { collection: collectionName, item: slug }

  if (schema?.fields) {
    return translateWithSchema(translated, schema, context, translations)
  }
  return translateHeuristic(translated, context, translations)
}

// ---------------------------------------------------------------------------
// ProseMirror translation helpers (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

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
