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

import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DATA_DIR } from '@uniweb/core'
import { computeHash } from './hash.js'
import { loadFreeformRecord } from './freeform.js'
// The heuristic judgement about which strings inside structured data are prose.
// It lives in its own module because the page lane needs exactly the same
// answer for a tagged data block's payload — a `label` is prose and an `href`
// is not, wherever the value came from. Moved rather than copied: two tuned
// denylists would drift, and drift here is silent.
import { resolveQueriesConfig, resolveRecordSchemas } from '../site/queries-config.js'
import { toDeliveredRecord, contentBodyField, misplacedFields, flatRecordFields } from '@uniweb/schemas/conform'
import { resolveDocForLocale } from './merge.js'
import { extractUnitsFromDoc } from './extract.js'
import { flatFormRefusal } from '../site/query-processor.js'
import { poolDirsForSchema, schemaForPoolDirs, resolveRecordsDir } from '../site/entity-pool.js'
import {
  NON_TRANSLATABLE_TYPES,
  HEURISTIC_SKIP_FIELDS,
  MAX_HEURISTIC_DEPTH,
  isStructuralString,
} from './data-strings.js'

// ⛔ `records`, NOT `collections`. The manifest holds translations of RECORDS —
// what a site stores — and a record has nothing to do with any query that
// selects it. The old name kept the two conflated, and the conflation was live:
// contexts were keyed by the QUERY, so two queries over one schema produced two
// entries for one record, each invisible from the other, and a renamed query
// orphaned every translation under it.
//
// ⚠️ `RECORD_LOCALES_DIR`, and not `RECORDS_DIR`, since 2026-09-21: that name is the
// site's own `records/` directory now (`site/entity-pool.js`), and this one is
// `locales/records/` — two directories, one word, so the constant says which.
export const RECORD_LOCALES_DIR = 'records'

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

/** Cache for resolved schemas (query name → schema or null) */
const schemaCache = new Map()

/**
 * Resolve schema for a collection.
 *
 * Discovery order:
 * 1. Companion file: public/data/<name>.schema.js (ESM default export)
 * 2. Standard schema: @uniweb/schemas by collection name (with naive singularization)
 * 3. null (no schema found → heuristic fallback)
 *
 * @param {string} queryName
 * @param {string} siteRoot
 * @returns {Promise<Object|null>}
 */
async function resolveSchema(queryName, siteRoot) {
  if (schemaCache.has(queryName)) {
    return schemaCache.get(queryName)
  }

  let schema = null

  // 1. Companion schema file, beside the collection it describes.
  //
  // This used to be looked up in `public/<DATA_DIR>/` — next to the compiled
  // output rather than the source. That directory is the build's, and asking
  // an author to write into it was the one remaining place the framework
  // contradicted its own rule that `collections/` is the only way to provide
  // structured data. The schema describes the source, so it lives with it.
  const companionPath = join(resolveRecordsDir(siteRoot).abs, `${queryName}.schema.js`)
  if (existsSync(companionPath)) {
    try {
      const mod = await import(pathToFileURL(companionPath).href)
      schema = mod.default || mod
      schemaCache.set(queryName, schema)
      return schema
    } catch (err) {
      console.warn(`[i18n] Failed to load companion schema ${companionPath}: ${err.message}`)
    }
  }

  // 2. Standard schema from @uniweb/schemas (try exact name + singularized)
  try {
    const schemasModule = await import('@uniweb/schemas')
    const names = [queryName, singularize(queryName)]

    for (const name of names) {
      if (schemasModule.schemas?.[name]) {
        schema = schemasModule.schemas[name]
        break
      }
    }
  } catch {
    // @uniweb/schemas not installed — that's fine
  }

  schemaCache.set(queryName, schema)
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

// Kinds that are values, not prose — by their normalized names and their authoring aliases.
const VALUE_KINDS = new Set(['int', 'decimal', 'bool', 'date', 'datetime', 'file', 'ref', 'entity_ref', ...NON_TRANSLATABLE_TYPES])

/**
 * The fields a record's data schema says are not prose — `translatable: false`, an enum, a value
 * kind (a date, a number, a file, a reference, a URL), JSON that is not rich text — which neither
 * extraction nor translation touches, wherever the walk below meets them. ⭐ The schema decides; the
 * heuristic fills in only where it says nothing — a list section's items, say.
 *
 * ⛔ Until 2026-09-26 a section-model schema — every standard one, and a foundation's own — was never
 * read here (`resolveSchema` wants `fields`): `@std/article`'s `tags`, `translatable: false` because they
 * are a grouping key, were extracted and translated by the build, while a push, reading the schema,
 * sent none — so a clone of the site, and the site as a backend serves it, showed them untranslated.
 *
 * @param {Object|null} dataSchema - the query's data schema (`recordQueries`)
 * @returns {Set<string>}
 */
function untranslatableFields(dataSchema) {
  const out = new Set()
  for (const [name, def] of Object.entries(flatRecordFields(dataSchema) || {})) {
    if (!def || typeof def !== 'object' || def.translatable === true) continue
    const valueString = def.type === 'string' && (def.format === 'url' || def.format === 'email')
    const plainJson = def.type === 'json' && def.format !== 'prosemirror'
    if (def.translatable === false || def.enum || VALUE_KINDS.has(def.type) || valueString || plainJson) out.add(name)
  }
  return out
}

/**
 * ⛔ A RECORD'S SYSTEM FIELDS ARE NEVER PROSE — never extracted, never translated, by
 * either path. A `$`-prefixed key at any depth is the system's (`$name`, the handle a
 * parametric page's URL names; `$uuid`), and a record's top-level `slug` and `path`
 * are its handle and its placement in `folder.yml`. Until 2026-09-14 they became
 * translation units, and a translation whose source happened to equal one rewrote it,
 * so a record's page stopped matching its URL.
 *
 * @param {string|number} key - a field name (an array index is never one)
 * @param {boolean} topLevel - whether the key sits at the record's own level
 * @returns {boolean}
 */
function isRecordSystemField(key, topLevel) {
  if (typeof key !== 'string') return false
  return key.startsWith('$') || (topLevel && (key === 'slug' || key === 'path'))
}

/**
 * A record's handle — `$name`, which the build sets from the record's file (`slug:` or
 * its name). ⭐ Not `slug` alone: a record of a schema whose brief declares a `slug`
 * FIELD (`@std/article`) is delivered with that field at the top, and it need not be
 * the file's name, which is what the free-form tree and a translation's context use.
 */
function recordHandle(item) {
  return item.$name ?? item.slug ?? item.id ?? item.name ?? 'unknown'
}

/** Is this value a ProseMirror document? */
function isProseMirrorDoc(value) {
  return !!value && typeof value === 'object' && value.type === 'doc' && Array.isArray(value.content)
}

/**
 * Every ProseMirror document a record holds, with its path. ⭐ A markdown body is
 * delivered in its schema's content body field — `article_body.content` for
 * `@std/article` — and at `content` only for a record with no schema; a rich field can
 * sit anywhere else. ⛔ Until 2026-09-24 only `content` at the top was read, which is
 * where a delivered `@std/article` holds no body.
 *
 * @returns {Array<{ path: string, doc: Object }>}
 */
function proseMirrorDocs(value, path = '', out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_HEURISTIC_DEPTH) return out
  if (isProseMirrorDoc(value)) {
    out.push({ path, doc: value })
    return out
  }
  const list = Array.isArray(value)
  for (const [key, v] of list ? value.map((x, i) => [i, x]) : Object.entries(value)) {
    if (!list && isRecordSystemField(key, depth === 0)) continue
    const at = list ? `${path}[${key}]` : path ? `${path}.${key}` : key
    proseMirrorDocs(v, at, out, depth + 1)
  }
  return out
}

/** The record with every ProseMirror document it holds translated — the rest copied as is. */
function translateDocs(value, context, translations, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_HEURISTIC_DEPTH) return value
  if (isProseMirrorDoc(value)) return translateProseMirrorDoc(value, context, translations)
  if (Array.isArray(value)) return value.map((v) => translateDocs(v, context, translations, depth + 1))
  const out = {}
  for (const [key, v] of Object.entries(value)) {
    out[key] = isRecordSystemField(key, depth === 0) ? v : translateDocs(v, context, translations, depth + 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// Schema-guided extraction
// ---------------------------------------------------------------------------

/**
 * Extract translatable fields from an item using a schema.
 *
 * @param {Object} item - Data item
 * @param {Object} schema - Schema with `fields`
 * @param {string} queryName
 * @param {Object} units - Accumulator
 */
function extractWithSchema(item, schema, recordDir, units) {
  const context = { record: `${recordDir}/${recordHandle(item)}` }

  extractFromItemWithSchema(item, schema.fields, '', context, units)

  // Also extract the record's ProseMirror documents (not covered by schema fields)
  for (const { path, doc } of proseMirrorDocs(item)) extractFromProseMirrorDoc(doc, context, units, path)
}

/**
 * Recursively extract translatable fields guided by schema.
 */
function extractFromItemWithSchema(data, fields, pathPrefix, context, units) {
  if (!data || typeof data !== 'object') return

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    if (isRecordSystemField(fieldName, !pathPrefix)) continue
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
function extractHeuristic(item, recordDir, units, veto = null) {
  const context = { record: `${recordDir}/${recordHandle(item)}` }

  extractFromItemHeuristic(item, '', context, units, 0, veto)

  // Also extract the record's ProseMirror documents, wherever it holds them
  for (const { path, doc } of proseMirrorDocs(item)) extractFromProseMirrorDoc(doc, context, units, path)
}

/**
 * Recursively extract strings that look translatable.
 */
function extractFromItemHeuristic(data, pathPrefix, context, units, depth, veto = null) {
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
    if (!Array.isArray(data) && isRecordSystemField(key, depth === 0)) continue
    // A field the schema says is not prose — at any depth, with everything under it.
    if (!Array.isArray(data) && veto?.has(key)) continue

    // Skip a ProseMirror document (handled separately)
    if (isProseMirrorDoc(value)) continue

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
      extractFromItemHeuristic(value, fieldPath, context, units, depth + 1, veto)
    }
    // Skip numbers, booleans
  }
}

// ---------------------------------------------------------------------------
// Schema-guided translation
// ---------------------------------------------------------------------------

/**
 * Translate item fields using schema guidance.
 */
function translateWithSchema(item, schema, context, translations) {
  const translated = translateDocs(item, context, translations)
  translateItemWithSchema(translated, schema.fields, context, translations)
  return translated
}

/**
 * Recursively translate fields guided by schema.
 */
function translateItemWithSchema(data, fields, context, translations, topLevel = true) {
  if (!data || typeof data !== 'object') return

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    if (isRecordSystemField(fieldName, topLevel)) continue
    const value = data[fieldName]
    if (value === undefined || value === null) continue

    const translatable = isFieldTranslatable(fieldDef)

    if (translatable === 'yes') {
      if (typeof value === 'string') {
        data[fieldName] = lookupTranslation(value, context, translations)
      }
    } else if (translatable === 'recurse') {
      if (fieldDef.type === 'object' && fieldDef.fields && typeof value === 'object' && !Array.isArray(value)) {
        translateItemWithSchema(value, fieldDef.fields, context, translations, false)
      } else if (fieldDef.type === 'array' && Array.isArray(value)) {
        const itemDef = fieldDef.items
        if (itemDef) {
          value.forEach((elem, i) => {
            if (itemDef.type === 'object' && itemDef.fields && typeof elem === 'object') {
              translateItemWithSchema(elem, itemDef.fields, context, translations, false)
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
function translateHeuristic(item, context, translations, veto = null) {
  const translated = translateDocs(item, context, translations)
  translateItemHeuristic(translated, context, translations, 0, veto)
  return translated
}

/**
 * Recursively translate strings that look translatable.
 */
function translateItemHeuristic(data, context, translations, depth, veto = null) {
  if (!data || typeof data !== 'object' || depth > MAX_HEURISTIC_DEPTH) return

  const keys = Array.isArray(data)
    ? data.map((_, i) => i)
    : Object.keys(data)

  for (const key of keys) {
    const value = data[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(data) && isRecordSystemField(key, depth === 0)) continue
    // As extraction: a field the schema says is not prose is not translated (`untranslatableFields`).
    if (!Array.isArray(data) && veto?.has(key)) continue

    // Skip a ProseMirror document (translated separately)
    if (isProseMirrorDoc(value)) continue

    if (typeof value === 'string') {
      if (!Array.isArray(data) && HEURISTIC_SKIP_FIELDS.has(key)) continue
      if (isStructuralString(value)) continue
      if (!value.trim()) continue

      data[key] = lookupTranslation(value, context, translations)
    } else if (typeof value === 'object') {
      translateItemHeuristic(value, context, translations, depth + 1, veto)
    }
  }
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

/**
 * Query name → the pool directory its records live in (`article`, `std/person`).
 *
 * ⛔ A TRANSLATION BELONGS TO A RECORD, NOT TO A QUERY. The manifest is keyed by
 * the record's pool identity for exactly the reason the freeform tree is: two
 * queries can cover one schema, so keying by the query would ask an author to
 * translate the same record once per query, find neither from the other, and
 * lose both when a query is renamed. A record's identity is a fact about the
 * site; a query's name is a choice.
 *
 * Falls back to the query name for a source with no local pool (a remote `url:`),
 * where there is no record on disk to be identified.
 */
async function poolDirsByQuery(siteRoot) {
  return (await recordQueries(siteRoot)).poolDirs
}

/**
 * Each query's pool directory (`poolDirsByQuery`) and the data schema its records are
 * delivered in (`resolveRecordSchemas`, null for none) — what a free-form translation
 * needs to put a body and frontmatter where the delivered record holds them.
 *
 * @returns {Promise<{ poolDirs: Map<string, string>, schemas: Map<string, Object|null> }>}
 */
async function recordQueries(siteRoot) {
  const poolDirs = new Map()
  const schemas = new Map()
  try {
    const { declarations } = await resolveQueriesConfig(siteRoot)
    const entries = Object.entries(declarations || {})
    for (const [name, decl] of entries) {
      const dirs = decl.schema ? poolDirsForSchema(decl.schema) : null
      poolDirs.set(name, dirs ? dirs.join('/') : name)
    }
    const refs = entries.filter(([, d]) => d.url === undefined && d.schema).map(([, d]) => d.schema)
    const resolved = (await resolveRecordSchemas(siteRoot, refs)).schemas
    for (const [name, decl] of entries) schemas.set(name, (decl.schema && resolved[decl.schema]) || null)
  } catch {
    // No resolvable config — every record keys by its query name, which is what
    // the extractor did before records existed.
  }
  return { poolDirs, schemas }
}


/**
 * Extract translatable content from all collections
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Options
 * @returns {Promise<Object>} Manifest with translation units
 */
export async function extractRecordContent(siteRoot, options = {}) {
  const dataDir = join(siteRoot, 'public', DATA_DIR)

  if (!existsSync(dataDir)) {
    return { version: '1.0', units: {} }
  }

  const units = {}
  // Each query's pool and data schema — the schema says which fields are not prose (`untranslatableFields`).
  const { poolDirs, schemas: dataSchemas } = await recordQueries(siteRoot)

  let files
  try {
    files = await readdir(dataDir)
  } catch {
    return { version: '1.0', units: {} }
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'))

  for (const file of jsonFiles) {
    const queryName = file.replace('.json', '')
    const filePath = join(dataDir, file)

    try {
      const raw = await readFile(filePath, 'utf-8')
      const items = JSON.parse(raw)

      if (!Array.isArray(items)) continue

      // Resolve schema once per collection
      const schema = await resolveSchema(queryName, siteRoot)
      const recordDir = poolDirs.get(queryName) ?? queryName
      const veto = untranslatableFields(dataSchemas.get(queryName) ?? null)
      const extract = (item) => {
        if (schema?.fields) {
          extractWithSchema(item, schema, recordDir, units)
        } else {
          extractHeuristic(item, recordDir, units, veto)
        }
      }

      for (const item of items) extract(item)

      // ⭐ AND THE QUERY'S PER-RECORD FILES. A query with `deferred:` fields writes each
      // record whole beside its lean list, and a deferred field is exactly what the list
      // does not hold. ⛔ Until 2026-09-14 only the list was read, so a deferred body —
      // one derived from a schema's brief included — never reached the manifest.
      for (const name of await recordFileNames(dataDir, queryName)) {
        try {
          const item = JSON.parse(await readFile(join(dataDir, queryName, name), 'utf-8'))
          if (item && typeof item === 'object' && !Array.isArray(item)) extract(item)
        } catch (err) {
          console.warn(`[i18n] Skipping ${queryName}/${name}: ${err.message}`)
        }
      }
    } catch (err) {
      // Skip files that can't be parsed
      console.warn(`[i18n] Skipping ${file}: ${err.message}`)
    }
  }

  return {
    version: '1.0',
    extracted: new Date().toISOString(),
    units
  }
}

/**
 * The per-record files a query with `deferred:` fields writes beside its list —
 * `public/data/<query>/<slug>.json`, one record whole in each (`writeQueryFiles`).
 *
 * @param {string} dataDir - the directory the query's list is in
 * @param {string} queryName - the list's file name, without `.json`
 * @returns {Promise<string[]>} the file names (`<slug>.json`), sorted; none when the
 *   query writes none
 */
async function recordFileNames(dataDir, queryName) {
  const dir = join(dataDir, queryName)
  if (!isInside(dir, dataDir) || !existsSync(dir)) return []
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Is `path` strictly inside `dir`? A name read off disk must not lead out of it. */
function isInside(path, dir) {
  return resolve(path).startsWith(resolve(dir) + sep)
}

/**
 * Remove what a locale's record directory holds beyond the query's current record files —
 * files whose source is gone. Build output only, and never outside `dataDir`.
 *
 * @param {string} recordsDir - `<locale>/data/<query>/`
 * @param {string} dataDir - `<locale>/data/`
 * @param {Set<string>} keep - the file names the query's source directory holds
 */
async function pruneRecordFiles(recordsDir, dataDir, keep) {
  if (!isInside(recordsDir, dataDir) || !existsSync(recordsDir)) return
  for (const entry of await readdir(recordsDir)) {
    if (!keep.has(entry)) await rm(join(recordsDir, entry), { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// ProseMirror extraction helpers (unchanged)
// ---------------------------------------------------------------------------

/**
 * Extract from a ProseMirror document — `field` is where the record holds it
 * (`content`, `article_body.content`), which each unit's `field` starts with.
 */
function extractFromProseMirrorDoc(doc, context, units, field = 'content') {
  // The units a page section's body makes (`extract.js::extractUnitsFromDoc`) — the keys translation
  // looks up — each under the field the record holds the body in.
  for (const unit of Object.values(extractUnitsFromDoc(doc))) addUnit(units, unit.source, `${field}.${unit.field}`, context)
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
    const contextKey = context.record
    const exists = existingContexts.some((c) => c.record === contextKey)
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
export async function buildLocalizedRecords(siteRoot, options = {}) {
  const {
    locales = [],
    outputDir = join(siteRoot, 'dist'),
    recordLocalesDir = join(siteRoot, 'locales', RECORD_LOCALES_DIR),
    localesDir = join(siteRoot, 'locales'),
    freeformEnabled = true
  } = options

  const dataDir = join(siteRoot, 'public', DATA_DIR)

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

  // ⚠️ The translate side derives the record key the SAME way extraction does.
  // These two agreeing is the whole contract, and a mismatch is SILENT: lookups
  // simply miss and every string falls back to its source. (This was missing for
  // a while and the failure was swallowed by the per-file catch below — the build
  // stayed green while nothing was translated.)
  const { poolDirs, schemas: dataSchemas } = await recordQueries(siteRoot)

  const outputs = {}
  // Reported rather than only logged — see the catch below.
  const failures = []

  for (const locale of locales) {
    // Load translations for this locale
    const localePath = join(recordLocalesDir, `${locale}.json`)
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
    const localeDataDir = join(outputDir, locale, DATA_DIR)
    await mkdir(localeDataDir, { recursive: true })

    outputs[locale] = {}

    for (const file of jsonFiles) {
      const queryName = file.replace('.json', '')
      const sourcePath = join(dataDir, file)

      try {
        const raw = await readFile(sourcePath, 'utf-8')
        const items = JSON.parse(raw)

        if (!Array.isArray(items)) {
          // Copy as-is if not an array
          const destPath = join(localeDataDir, file)
          await writeFile(destPath, raw)
          outputs[locale][queryName] = destPath
          continue
        }

        // Resolve schema once per collection
        const schema = await resolveSchema(queryName, siteRoot)
        const recordDir = poolDirs.get(queryName) ?? queryName
        const dataSchema = dataSchemas.get(queryName) ?? null

        // Translate each item (with free-form support)
        const translatedItems = await Promise.all(
          items.map(item =>
            translateItemAsync(item, recordDir, translations, schema, {
              locale,
              localesDir,
              freeformEnabled: hasFreeform,
              dataSchema
            })
          )
        )

        const destPath = join(localeDataDir, file)
        await writeFile(destPath, JSON.stringify(translatedItems, null, 2))
        outputs[locale][queryName] = destPath

        // ⭐ AND THE QUERY'S PER-RECORD FILES, beside the translated list and with the
        // same translations — `/<locale>/data/<query>/<slug>.json`. A query with
        // `deferred:` fields writes each record whole there, and a parametric page reads
        // its record from that file. ⛔ Until 2026-09-14 they were not written for any
        // locale, so a localized site's records showed their deferred fields — an
        // article's body — in the source language under a translated list.
        const localeRecordsDir = join(localeDataDir, queryName)
        const recordNames = await recordFileNames(dataDir, queryName)
        for (const name of recordNames) {
          try {
            const record = JSON.parse(await readFile(join(dataDir, queryName, name), 'utf-8'))
            const translatedRecord = record && typeof record === 'object' && !Array.isArray(record)
              ? await translateItemAsync(record, recordDir, translations, schema, { locale, localesDir, freeformEnabled: hasFreeform, dataSchema })
              : record
            await mkdir(localeRecordsDir, { recursive: true })
            await writeFile(join(localeRecordsDir, name), JSON.stringify(translatedRecord, null, 2))
          } catch (err) {
            console.error(`[i18n] Failed to translate ${queryName}/${name} for ${locale}: ${err.message}`)
            failures.push({ locale, file: `${queryName}/${name}`, message: err.message })
          }
        }
        // A record file the source no longer has is not left behind, translated, in the locale.
        await pruneRecordFiles(localeRecordsDir, localeDataDir, new Set(recordNames))
      } catch (err) {
        // ⛔ A FAILURE HERE USED TO BE A `console.warn` AND NOTHING ELSE, and it
        // hid a real bug for the length of a session: a `ReferenceError` in this
        // lane — a programming error, not bad data — was caught by a handler
        // meant for an unparseable file, downgraded to a warning, and the
        // locale's output silently omitted. The build stayed green while NOTHING
        // was translated.
        //
        // ⇒ It is an ERROR, and it is reported in the RESULT. A caller cannot act
        // on a line of stderr it did not read; `failures` is the thing a build can
        // count and refuse on. Still not thrown, because one unparseable data file
        // must not take down a whole multi-locale build.
        console.error(`[i18n] Failed to translate ${file} for ${locale}: ${err.message}`)
        failures.push({ locale, file, message: err.message })
      }
    }
  }

  // ⚠️ Attached rather than merged into the locale map, so an existing reader
  // that indexes `outputs[locale][name]` is unaffected while a new one can ask.
  if (failures.length) Object.defineProperty(outputs, 'failures', { value: failures, enumerable: false })
  return outputs
}

/**
 * Apply translations to a collection item (async, with free-form support)
 *
 * The hash-based translations apply first — every field and every ProseMirror document
 * (schema-guided or heuristic) — and a free-form translation then replaces what it
 * states (`applyFreeform`): its frontmatter, its body, or both.
 *
 * @param {Object} [options.dataSchema] - the data schema the record is delivered in
 *   (`recordQueries`), which says where a free-form body and frontmatter go
 */
async function translateItemAsync(item, recordDir, translations, schema, options = {}) {
  const { locale, localesDir, freeformEnabled, dataSchema = null } = options
  const translated = translateItemSync(item, recordDir, translations, schema, untranslatableFields(dataSchema))
  if (!freeformEnabled || !locale || !localesDir) return translated

  // ⛔ The loader takes the record's SCHEMA ref and derives the pool path from it
  // (`buildFreeformRecordPath`); handed the pool directory itself (`article`), it
  // derived nothing and found no file — so until 2026-09-14 no free-form record
  // translation applied on this lane. And it is named by the record's HANDLE
  // (`recordHandle`), never a brief's `slug` field.
  const schemaRef = schemaForPoolDirs(recordDir.split('/'))
  const freeform = await loadFreeformRecord({ slug: item.$name ?? item.slug }, schemaRef, locale, localesDir)
  return freeform ? applyFreeform(translated, freeform, dataSchema, schemaRef) : translated
}

/**
 * A free-form translation over a record, in the shape the record is DELIVERED in (see
 * `site/query-processor.js::deliverRecord`): its frontmatter read the way the record's
 * file is — by section, the brief lifted to the top — and merged section by section; its
 * body put in the schema's content body field — the markdown source for a markup `text`
 * field — or at `content` for a record with no schema or no such field. ⛔ Until
 * 2026-09-24 both went to the top of the record, where a delivered `@std/article` holds
 * neither its body nor anything of `article_body`.
 *
 * ⛔ Frontmatter written in the retired flat form is refused, as the record's own file is.
 */
function applyFreeform(record, freeform, dataSchema, schemaRef) {
  const out = { ...record }
  if (freeform.frontmatter) {
    let fm = freeform.frontmatter
    if (dataSchema) {
      const misplaced = misplacedFields(dataSchema, fm)
      if (misplaced.length) {
        throw new Error(flatFormRefusal(freeform.relativePath ?? freeform.filePath, schemaRef, dataSchema, misplaced))
      }
      fm = toDeliveredRecord(dataSchema, fm)
    }
    const sections = new Set(Object.keys(dataSchema?.sections || {}))
    for (const [key, value] of Object.entries(fm)) {
      out[key] = sections.has(key) && isPlainObject(out[key]) && isPlainObject(value) ? { ...out[key], ...value } : value
    }
  }
  if (freeform.content) {
    const target = dataSchema ? contentBodyField(dataSchema) : null
    const value = target?.field?.type === 'text' ? freeform.markdown : freeform.content
    if (!target) out.content = freeform.content
    else if (!target.section) out[target.key] = value
    else out[target.section] = { ...(isPlainObject(out[target.section]) ? out[target.section] : {}), [target.key]: value }
  }
  return out
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Apply translations to a collection item (sync, hash-based only)
 */
function translateItemSync(item, recordDir, translations, schema, veto = null) {
  const translated = { ...item }
  const context = { record: `${recordDir}/${recordHandle(item)}` }

  if (schema?.fields) {
    return translateWithSchema(translated, schema, context, translations)
  }
  return translateHeuristic(translated, context, translations, veto)
}

// ---------------------------------------------------------------------------
// ProseMirror translation helpers (unchanged)
// ---------------------------------------------------------------------------

/**
 * Translate a ProseMirror document
 */
function translateProseMirrorDoc(doc, context, translations) {
  // ⭐ Element by element, by the rule a page section is translated by (`merge.js`) — keyed by the
  // record's identity for an override. ⛔ Until 2026-09-26 a record's rich text was looked up text node
  // by text node, so a paragraph holding a link or an emphasis — several text nodes — never matched its
  // translation, which is keyed by the whole paragraph, and rendered untranslated.
  return resolveDocForLocale(doc, translations, { key: context.record }) ?? doc
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
    // Same key shape the manifest writes — a record's identity.
    const contextKey = context.record
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
// Public translation entry point (for dev server middleware)
// ---------------------------------------------------------------------------

/**
 * Translate a collection's items array for a given locale.
 * Used by dev server middleware for on-the-fly translation.
 *
 * ⛔ The record key is derived here exactly as extraction and the localized build
 * derive it — the query's pool directory (`poolDirsByQuery`), not its name. Until
 * 2026-09-14 the free-form branch read a `recordDir` that was never defined (a
 * `ReferenceError`, which the dev middleware caught and logged, leaving the request to
 * fall through untranslated),
 * and the other branch keyed by the query's name, so a translation keyed by the record
 * missed.
 *
 * @param {Array|Object} items - Collection items array — or ONE record, the content of a
 *   `deferred:` query's per-record file (`/data/<query>/<slug>.json`)
 * @param {string} queryName - The query the items were compiled for (e.g. 'articles')
 * @param {string} siteRoot - Site root directory
 * @param {Object} options - Translation options
 * @param {string} options.locale - Target locale code
 * @param {string} options.localesDir - Absolute path to locales directory
 * @param {Object} [options.translations={}] - Hash-based translations
 * @param {boolean} [options.freeformEnabled=false] - Enable free-form translations
 * @returns {Promise<Array|Object>} Translated items, or the translated record
 */
export async function translateRecordData(items, queryName, siteRoot, options = {}) {
  const { locale, localesDir, translations = {}, freeformEnabled = false } = options

  const one = !!items && typeof items === 'object' && !Array.isArray(items)
  if (!Array.isArray(items) && !one) return items
  const records = one ? [items] : items

  const schema = await resolveSchema(queryName, siteRoot)
  const { poolDirs, schemas: dataSchemas } = await recordQueries(siteRoot)
  const recordDir = poolDirs.get(queryName) ?? queryName

  const translated = freeformEnabled
    ? await Promise.all(
        records.map(item =>
          translateItemAsync(item, recordDir, translations, schema, {
            locale,
            localesDir,
            freeformEnabled,
            dataSchema: dataSchemas.get(queryName) ?? null
          })
        )
      )
    : records.map(item =>
        translateItemSync(item, recordDir, translations, schema, untranslatableFields(dataSchemas.get(queryName)))
      )

  return one ? translated[0] : translated
}

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

/**
 * Get available collection locales
 * @param {string} localesPath - Path to locales directory
 * @returns {Promise<string[]>} Array of locale codes
 */
export async function getRecordLocales(localesPath) {
  const recordLocalesDir = join(localesPath, RECORD_LOCALES_DIR)
  if (!existsSync(recordLocalesDir)) return []

  try {
    const files = await readdir(recordLocalesDir)
    return files
      .filter(f => f.endsWith('.json') && f !== 'manifest.json')
      .map(f => f.replace('.json', ''))
      .sort()
  } catch {
    return []
  }
}
