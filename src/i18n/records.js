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
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { proseMirrorToMarkdown } from '@uniweb/content-writer'
import { computeHash } from './hash.js'
import { loadFreeformRecord } from './freeform.js'
import { resolveQueriesConfig, resolveRecordSchemas, foundationSchemaJson } from '../site/queries-config.js'
import { dataKeyTypes, keyOfDefaultRef } from '../uwx/data-key-types.js'
import { toDataSchemaDeclaration, isProseMirrorField } from '../uwx/data-schema.js'
import { toDeliveredRecord, contentBodyField, misplacedFields } from '@uniweb/schemas/conform'
import { resolveDocForLocale } from './merge.js'
import { extractUnitsFromDoc } from './extract.js'
import { flatFormRefusal, extractExcerpt } from '../site/query-processor.js'
import { poolDirsForSchema, schemaForPoolDirs, resolveRecordsDir } from '../site/entity-pool.js'
// The heuristic judgement about which strings inside structured data are prose.
// It lives in its own module because the page lane needs exactly the same
// answer for a tagged data block's payload — a `label` is prose and an `href`
// is not, wherever the value came from. Moved rather than copied: two tuned
// denylists would drift, and drift here is silent.
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

// ---------------------------------------------------------------------------
// A record's model — what a push sends it as
// ---------------------------------------------------------------------------

/**
 * ⭐ A RECORD WITH A DATA SCHEMA IS TRANSLATED BY THE MODEL A PUSH SENDS IT AS — its schema
 * lowered by the push's own rule (`uwx/data-schema.js::toDataSchemaDeclaration`), which marks
 * `localized` exactly the fields that travel per locale: text and rich content — never an enum,
 * a value format (a URL, an email), a `translatable: false` field, a number, a date, a file or a
 * reference. So what the static build extracts and translates is what a push carries, field for
 * field, and what a clone of the site, or the site as a backend serves it, renders.
 *
 * ⛔ Until 2026-09-26 the build guessed: a walk over every string, vetoed by the fields of the
 * schema's single sections — so a `multi` section's enum, and the brief of a record a reference
 * names, were extracted and translated while a push sent neither.
 *
 * @param {Object|null} schema - a normalized data schema
 * @param {string} ref - the ref it was resolved from
 * @returns {Object|null} the lowered declaration, or null when there is none
 */
function modelOf(schema, ref) {
  if (!schema) return null
  try {
    return toDataSchemaDeclaration(schema, { name: ref || '@/record', resolveName: (r) => r })
  } catch {
    return null // a schema a push refuses is refused there, and the build keeps its heuristic
  }
}

/** The refs of the models a model's references name. */
function referencedModels(model) {
  const out = new Set()
  const walk = (fields) => {
    for (const field of Object.values(fields || {})) {
      if (field?.type === 'entity_ref' && typeof field.model === 'string') out.add(field.model)
      else if (field?.type === 'section') walk(field.fields)
    }
  }
  for (const section of Object.values(model?.sections || {})) walk(section?.fields)
  return out
}

/**
 * Each field of a model that a record holds a value for, in the shape the record is DELIVERED in
 * (`toDeliveredRecord`): the brief's fields at the top — every field, for a model of one single
 * section — and each other section under its name, a list of them for a `multiple` one, a nested
 * section the same way. Calls `visit(holder, name, field, path)` for each.
 */
function eachModelField(record, model, visit) {
  const sections = Object.entries(model?.sections || {})
  const flat = sections.length === 1 && !sections[0][1]?.multiple
  for (const [name, section] of sections) {
    if (flat || section?.brief) eachSectionField(record, section?.fields, '', visit)
    else eachSectionValue(record?.[name], section, name, visit)
  }
}

function eachSectionValue(value, section, path, visit) {
  if (!section?.multiple) return eachSectionField(value, section?.fields, path, visit)
  if (Array.isArray(value)) value.forEach((item, i) => eachSectionField(item, section.fields, `${path}[${i}]`, visit))
}

function eachSectionField(holder, fields, path, visit) {
  if (!isPlainObject(holder)) return
  for (const [name, field] of Object.entries(fields || {})) {
    if (holder[name] == null || isRecordSystemField(name, !path)) continue
    const at = path ? `${path}.${name}` : name
    if (field?.type === 'section') eachSectionValue(holder[name], field, at, visit)
    else visit(holder, name, field || {}, at)
  }
}

/** The fields of a model's brief — what a reference to one of its records is delivered as. */
function briefFields(model) {
  const sections = Object.values(model?.sections || {})
  const brief = sections.find((s) => s?.brief) ?? (sections.length === 1 && !sections[0]?.multiple ? sections[0] : null)
  return brief?.fields ?? null
}

/** A markdown string as a ProseMirror document, or null. */
function parseMarkdown(markdown) {
  try {
    const doc = markdownToProseMirror(markdown)
    return isProseMirrorDoc(doc) ? doc : null
  } catch {
    return null
  }
}

/**
 * A record's units by its model: each localized field's value, a rich one element by element as
 * a push sends it — and none from a reference, whose record makes its own.
 *
 * @param {Set<string>|null} skip - fields of the record's own level to leave out (`EXCERPT`)
 */
function extractByModel(item, model, context, units, skip = null) {
  eachModelField(item, model, (holder, name, field, path) => {
    if (!field.localized || (holder === item && skip?.has(name))) return
    const value = holder[name]
    if (isProseMirrorField(field)) {
      const doc = typeof value === 'string' ? parseMarkdown(value) : value
      if (isProseMirrorDoc(doc)) extractFromProseMirrorDoc(doc, context, units, path)
    } else if (typeof value === 'string') {
      if (value.trim()) addUnit(units, value, path, context)
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'string' && v.trim()) addUnit(units, v, `${path}[${i}]`, context)
      })
    }
  })
}

// A reference inside a reference's brief is delivered as its handle, not hydrated — this only bounds the walk.
const MAX_REFERENCE_DEPTH = 4

/**
 * A record translated by its model (`extractByModel`'s rule) — and each reference's brief by the
 * model it names, as the record it names is translated, and served, on its own.
 */
function translateByModel(item, model, context, translations, targets, skip = null) {
  const out = structuredClone(item)
  eachModelField(out, model, (holder, name, field) => {
    if (holder === out && skip?.has(name)) return
    holder[name] = translateFieldValue(holder[name], field, context, translations, targets, 0)
  })
  return out
}

function translateFieldValue(value, field, context, translations, targets, depth) {
  if (field.type === 'entity_ref') {
    const fields = briefFields(targets?.get(field.model))
    if (!fields || depth >= MAX_REFERENCE_DEPTH) return value
    const one = (ref) => {
      if (!isPlainObject(ref) || !isPlainObject(ref.brief)) return ref
      const brief = { ...ref.brief }
      eachSectionField(brief, fields, '', (holder, name, f) => {
        holder[name] = translateFieldValue(holder[name], f, context, translations, targets, depth + 1)
      })
      return { ...ref, brief }
    }
    return Array.isArray(value) ? value.map(one) : one(value)
  }
  if (!field.localized) return value
  if (isProseMirrorField(field)) {
    if (isProseMirrorDoc(value)) return translateProseMirrorDoc(value, context, translations)
    // Written as markdown: translated as a push sends it, element by element, and kept markdown.
    const doc = typeof value === 'string' ? parseMarkdown(value) : null
    if (!doc) return value
    const translated = translateProseMirrorDoc(doc, context, translations)
    return JSON.stringify(translated) === JSON.stringify(doc) ? value : proseMirrorToMarkdown(translated)
  }
  if (typeof value === 'string') return lookupTranslation(value, context, translations)
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? lookupTranslation(v, context, translations) : v))
  return value
}

// ---------------------------------------------------------------------------
// A derived excerpt
// ---------------------------------------------------------------------------

/**
 * ⭐ AN EXCERPT THE BUILD DERIVES IS DERIVED IN EVERY LANGUAGE. A record whose author wrote no
 * excerpt gets one from its body on the static lane (`site/query-processor.js::extractExcerpt`),
 * and a push sends none — it is not the author's. So it is no unit to translate: each locale's is
 * derived again, by the same rule, from that locale's body. ⛔ Until 2026-09-26 it was offered for
 * translation like authored text — a translation no push carries, so a clone showed it in the
 * source language — and left untranslated, it summarized a translated body in the source language.
 */
const EXCERPT = new Set(['excerpt'])

/** A record's body as a document — where its schema's content body field is, else `content`. */
function bodyDocOf(record, dataSchema) {
  const target = dataSchema ? contentBodyField(dataSchema) : null
  const holder = target?.section ? record?.[target.section] : record
  const value = target ? holder?.[target.key] : record?.content
  if (isProseMirrorDoc(value)) return value
  return typeof value === 'string' && value.trim() ? parseMarkdown(value) : null
}

/** The excerpt the build derives for a record — from `whole`, the record with its body. */
function derivedExcerptOf(whole, dataSchema, config) {
  return extractExcerpt({ ...whole, excerpt: undefined }, bodyDocOf(whole, dataSchema), config)
}

/** Whether a record's excerpt is the one the build derives, not one its author wrote. */
function derivesExcerpt(record, whole, dataSchema, config) {
  if (typeof record?.excerpt !== 'string' || !record.excerpt || !config) return false
  return derivedExcerptOf(whole ?? record, dataSchema, config) === record.excerpt
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
 * Extract translatable fields from an item using heuristics — a record with no data schema, which
 * says nothing of its fields. Recursively walks the data, extracting strings that look like
 * human-readable text.
 *
 * @param {Set<string>|null} skip - fields of the record's own level to leave out (`EXCERPT`)
 */
function extractHeuristic(item, recordDir, units, skip = null) {
  const context = { record: `${recordDir}/${recordHandle(item)}` }

  extractFromItemHeuristic(item, '', context, units, 0, skip)

  // Also extract the record's ProseMirror documents, wherever it holds them
  for (const { path, doc } of proseMirrorDocs(item)) extractFromProseMirrorDoc(doc, context, units, path)
}

/**
 * Recursively extract strings that look translatable.
 */
function extractFromItemHeuristic(data, pathPrefix, context, units, depth, skip = null) {
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
    if (depth === 0 && skip?.has(key)) continue

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
      extractFromItemHeuristic(value, fieldPath, context, units, depth + 1)
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
function translateHeuristic(item, context, translations, skip = null) {
  const translated = translateDocs(item, context, translations)
  translateItemHeuristic(translated, context, translations, 0, skip)
  return translated
}

/**
 * Recursively translate strings that look translatable.
 */
function translateItemHeuristic(data, context, translations, depth, skip = null) {
  if (!data || typeof data !== 'object' || depth > MAX_HEURISTIC_DEPTH) return

  const keys = Array.isArray(data)
    ? data.map((_, i) => i)
    : Object.keys(data)

  for (const key of keys) {
    const value = data[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(data) && isRecordSystemField(key, depth === 0)) continue
    if (depth === 0 && skip?.has(key)) continue

    // Skip a ProseMirror document (translated separately)
    if (isProseMirrorDoc(value)) continue

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
 * What the localized build needs to know of each query:
 *
 * - `poolDirs` — its pool directory (`poolDirsByQuery`), which a record's translations are keyed by;
 * - `schemas` — the data schema its records are DELIVERED in (`resolveRecordSchemas`, null for
 *   none), which says where a free-form body and frontmatter go, and where the body is;
 * - `models` — the model its records are pushed as (`modelOf`), which says which of their fields
 *   are translated; `targets` — the model each reference names, by its ref, transitively;
 * - `excerpts` — its excerpt settings, which derive an excerpt (`EXCERPT`).
 *
 * ⭐ THE MODEL IS THE TYPE THE RECORDS ARE OF, which is not always the schema they are delivered
 * in. A query whose name-defaulted schema (`@/team`) no data schema answers, for a data key the
 * foundation types (`data: { team: '@/member' }`), holds records of that type — a push sends them
 * as its entities (`uwx/data-key-types.js`) — while the build delivers them as they are written.
 * The type is read from the foundation's built `schema.json`, the input a push reads it from.
 *
 * @returns {Promise<{ poolDirs: Map<string, string>, schemas: Map<string, Object|null>, models: Map<string, Object|null>, targets: Map<string, Object|null>, excerpts: Map<string, Object> }>}
 */
async function recordQueries(siteRoot) {
  const poolDirs = new Map()
  const schemas = new Map()
  const models = new Map()
  const targets = new Map()
  const excerpts = new Map()
  try {
    const siteYml = await readSiteYml(siteRoot)
    const { declarations } = await resolveQueriesConfig(siteRoot, { siteYml })
    const entries = Object.entries(declarations || {})
    for (const [name, decl] of entries) {
      const dirs = decl.schema ? poolDirsForSchema(decl.schema) : null
      poolDirs.set(name, dirs ? dirs.join('/') : name)
      // As `site/query-processor.js` parses a query's `excerpt:`.
      excerpts.set(name, { maxLength: decl.excerpt?.maxLength || 160, field: decl.excerpt?.field || null })
    }
    const local = entries.filter(([, d]) => d.url === undefined && d.schema)
    const resolved = (await resolveRecordSchemas(siteRoot, local.map(([, d]) => d.schema), { siteYml })).schemas
    for (const [name, decl] of entries) schemas.set(name, (decl.schema && resolved[decl.schema]) || null)

    const keyTyped = new Map() // query name → the type of the data key it is named for
    const untyped = local.filter(([, d]) => !d.schemaExplicit && !resolved[d.schema])
    if (untyped.length) {
      const keyTypes = dataKeyTypes(foundationSchemaJson(siteRoot, siteYml))
      for (const [name, d] of untyped) {
        const type = keyTypes.get(keyOfDefaultRef(d.schema))
        if (type) keyTyped.set(name, type)
      }
    }
    const types = keyTyped.size ? (await resolveRecordSchemas(siteRoot, keyTyped.values(), { siteYml })).schemas : {}
    for (const [name, decl] of entries) {
      const type = keyTyped.get(name)
      models.set(name, schemas.get(name) ? modelOf(schemas.get(name), decl.schema) : type ? modelOf(types[type], type) : null)
    }

    // The models the records' references name, and the ones theirs name.
    let pending = [...new Set([...models.values()].flatMap((m) => [...referencedModels(m)]))]
    while (pending.length) {
      const got = (await resolveRecordSchemas(siteRoot, pending, { siteYml })).schemas
      const next = new Set()
      for (const ref of pending) {
        const model = modelOf(got[ref], ref)
        targets.set(ref, model)
        for (const r of referencedModels(model)) if (!targets.has(r) && !pending.includes(r)) next.add(r)
      }
      pending = [...next]
    }
  } catch {
    // No resolvable config — every record keys by its query name, which is what
    // the extractor did before records existed.
  }
  return { poolDirs, schemas, models, targets, excerpts }
}

/** A site's `site.yml`, or `{}`. */
async function readSiteYml(siteRoot) {
  const path = join(siteRoot, 'site.yml')
  if (!existsSync(path)) return {}
  try {
    return yaml.load(await readFile(path, 'utf-8'), YAML_OPTIONS) || {}
  } catch {
    return {}
  }
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
  const { poolDirs, schemas: dataSchemas, models, excerpts } = await recordQueries(siteRoot)

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
      const model = models.get(queryName) ?? null
      // ⭐ AND THE QUERY'S PER-RECORD FILES. A query with `deferred:` fields writes each
      // record whole beside its lean list, and a deferred field is exactly what the list
      // does not hold. ⛔ Until 2026-09-14 only the list was read, so a deferred body —
      // one derived from a schema's brief included — never reached the manifest.
      const wholes = await wholeRecords(dataDir, queryName)
      const extract = (item) => {
        const whole = wholes.get(recordHandle(item))
        const skip = derivesExcerpt(item, whole, dataSchemas.get(queryName), excerpts.get(queryName)) ? EXCERPT : null
        if (model) {
          extractByModel(item, model, { record: `${recordDir}/${recordHandle(item)}` }, units, skip)
        } else if (schema?.fields) {
          extractWithSchema(item, schema, recordDir, units)
        } else {
          extractHeuristic(item, recordDir, units, skip)
        }
      }

      for (const item of items) extract(item)
      for (const item of wholes.values()) extract(item)
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

/**
 * A query's per-record files (`recordFileNames`), each record whole, by its handle.
 *
 * @returns {Promise<Map<string, Object>>}
 */
async function wholeRecords(dataDir, queryName) {
  const out = new Map()
  for (const name of await recordFileNames(dataDir, queryName)) {
    try {
      const record = JSON.parse(await readFile(join(dataDir, queryName, name), 'utf-8'))
      if (isPlainObject(record)) out.set(recordHandle(record), record)
    } catch (err) {
      console.warn(`[i18n] Skipping ${queryName}/${name}: ${err.message}`)
    }
  }
  return out
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
  const { poolDirs, schemas: dataSchemas, models, targets, excerpts } = await recordQueries(siteRoot)

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
        const recordOptions = {
          locale,
          localesDir,
          freeformEnabled: hasFreeform,
          dataSchema: dataSchemas.get(queryName) ?? null,
          model: models.get(queryName) ?? null,
          targets,
          excerpt: excerpts.get(queryName),
        }

        // ⭐ AND THE QUERY'S PER-RECORD FILES, beside the translated list and with the
        // same translations — `/<locale>/data/<query>/<slug>.json`. A query with
        // `deferred:` fields writes each record whole there, and a parametric page reads
        // its record from that file. ⛔ Until 2026-09-14 they were not written for any
        // locale, so a localized site's records showed their deferred fields — an
        // article's body — in the source language under a translated list.
        // They are translated first: a lean list's derived excerpt is derived from its record's
        // translated body (`EXCERPT`).
        const localeRecordsDir = join(localeDataDir, queryName)
        const recordNames = await recordFileNames(dataDir, queryName)
        const wholes = new Map() // handle → { source, translated }
        for (const name of recordNames) {
          try {
            const record = JSON.parse(await readFile(join(dataDir, queryName, name), 'utf-8'))
            const translatedRecord = isPlainObject(record)
              ? await translateItemAsync(record, recordDir, translations, schema, recordOptions)
              : record
            if (isPlainObject(record)) wholes.set(recordHandle(record), { source: record, translated: translatedRecord })
            await mkdir(localeRecordsDir, { recursive: true })
            await writeFile(join(localeRecordsDir, name), JSON.stringify(translatedRecord, null, 2))
          } catch (err) {
            console.error(`[i18n] Failed to translate ${queryName}/${name} for ${locale}: ${err.message}`)
            failures.push({ locale, file: `${queryName}/${name}`, message: err.message })
          }
        }
        // A record file the source no longer has is not left behind, translated, in the locale.
        await pruneRecordFiles(localeRecordsDir, localeDataDir, new Set(recordNames))

        // Translate each item (with free-form support)
        const translatedItems = await Promise.all(
          items.map((item) =>
            translateItemAsync(item, recordDir, translations, schema, { ...recordOptions, whole: wholes.get(recordHandle(item)) })
          )
        )

        const destPath = join(localeDataDir, file)
        await writeFile(destPath, JSON.stringify(translatedItems, null, 2))
        outputs[locale][queryName] = destPath
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
 * the record's model says is translated (`translateItemSync`) — and a free-form translation
 * then replaces what it states (`applyFreeform`): its frontmatter, its body, or both. A
 * derived excerpt is then derived from the translated body (`EXCERPT`).
 *
 * @param {Object} [options.dataSchema] - the data schema the record is delivered in
 *   (`recordQueries`), which says where a free-form body and frontmatter go
 * @param {Object} [options.model] - the model the record is pushed as, and `targets`, the models
 *   its references name (`recordQueries`) — which fields are translated
 * @param {Object} [options.excerpt] - the query's excerpt settings (`EXCERPT`)
 * @param {{ source: Object, translated: Object }} [options.whole] - for an item of a lean list, its
 *   record whole and translated, whose body a derived excerpt is derived from
 */
async function translateItemAsync(item, recordDir, translations, schema, options = {}) {
  const { locale, localesDir, freeformEnabled, dataSchema = null, model = null, targets = null, excerpt = null, whole = null } = options
  const derived = derivesExcerpt(item, whole?.source, dataSchema, excerpt)
  let translated = translateItemSync(item, recordDir, translations, schema, { model, targets, skip: derived ? EXCERPT : null })
  if (freeformEnabled && locale && localesDir) translated = await applyFreeformFile(translated, item, recordDir, locale, localesDir, dataSchema)
  if (!derived) return translated
  return { ...translated, excerpt: derivedExcerptOf(whole ? whole.translated : translated, dataSchema, excerpt) }
}

/** The record with its free-form translation for `locale` applied, if it has one. */
async function applyFreeformFile(translated, item, recordDir, locale, localesDir, dataSchema) {
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
 * Apply translations to a collection item (sync, hash-based only) — by the model it is pushed as
 * when it has one (`translateByModel`), else a companion schema's fields, else the heuristic.
 */
function translateItemSync(item, recordDir, translations, schema, { model = null, targets = null, skip = null } = {}) {
  const context = { record: `${recordDir}/${recordHandle(item)}` }

  if (model) return translateByModel(item, model, context, translations, targets, skip)
  const translated = { ...item }
  if (schema?.fields) {
    return translateWithSchema(translated, schema, context, translations)
  }
  return translateHeuristic(translated, context, translations, skip)
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
  const { poolDirs, schemas: dataSchemas, models, targets, excerpts } = await recordQueries(siteRoot)
  const recordDir = poolDirs.get(queryName) ?? queryName
  const recordOptions = {
    locale,
    localesDir,
    freeformEnabled,
    dataSchema: dataSchemas.get(queryName) ?? null,
    model: models.get(queryName) ?? null,
    targets,
    excerpt: excerpts.get(queryName),
  }

  // A lean list's derived excerpt is derived from its record's translated body (`EXCERPT`).
  const wholes = new Map()
  if (!one) {
    for (const [handle, record] of await wholeRecords(join(siteRoot, 'public', DATA_DIR), queryName)) {
      wholes.set(handle, { source: record, translated: await translateItemAsync(record, recordDir, translations, schema, recordOptions) })
    }
  }
  const translated = await Promise.all(
    records.map((item) => translateItemAsync(item, recordDir, translations, schema, { ...recordOptions, whole: wholes.get(recordHandle(item)) }))
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
