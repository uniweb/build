/**
 * Data-conformance checker (build time)
 *
 * Checks a project's file-based data inputs against the data schemas the
 * foundation declared for the sections that consume them. Answers one
 * question: *is my data correct according to the schemas I said it should
 * comply with?*
 *
 * Two layers:
 *   - `validateItem(schema, item)` — pure, facet-driven: walks a normalized
 *     schema's declared facets (required / type / enum / format / nested
 *     object+array) and emits one finding per failed facet. No I/O.
 *   - `validateDataInputs({ siteRoot, foundationPath })` — the join: pairs each
 *     section's data input with the schema its `meta.js` binds to that key,
 *     validates each unique (file, schema) pair once, and attributes findings
 *     back to the sections that use it.
 *
 * This is a pre-live dev/CI gate, not a render-time guard. The runtime stays
 * tolerant (apply defaults, ignore the rest); a wrong value is best caught
 * here, before a site is live — so the engine returns findings and the caller
 * decides whether they should fail a build (CI treats them as errors).
 *
 * The type vocabulary (`SCALAR_KINDS` / `FORMAT_TYPES`) is shared with the
 * schema normalizer, so what *normalizes* and what *conforms* speak one
 * definition of each kind.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import yaml from 'js-yaml'
import { collectionNameFromUrl } from '@uniweb/core'

import { SCALAR_KINDS, FORMAT_TYPES, validateAndNormalizeSchema } from './resolve-data-schema.js'
import { buildSchema } from './schema.js'
import { resolveFoundationSrcPath } from './utils/foundation-source-root.js'
import { collectSiteContent } from './site/content-collector.js'
import { processCollections } from './site/collection-processor.js'

// --- the pure validator -----------------------------------------------------

/**
 * Validate one data item against a normalized data schema.
 *
 * Operates on the *normalized* schema (canonical kinds + `required` / `enum` /
 * `format` / nested `fields` / `items`) — the shape `dataSchemas[ref]` carries.
 * Facet-driven: each declared facet contributes its own check, so a new facet
 * in the schema model is covered without restructuring this function.
 *
 * Scope: a `fields`-form schema (the locally-testable case). A `sections`-form
 * (rich) schema describes the backend's section/item graph, which a flat file
 * can't reproduce — callers defer those rather than pass them here; given one,
 * this returns `[]`.
 *
 * @param {Object} schema - a normalized data schema (`{ fields }` or `{ sections }`)
 * @param {*} item - the data item to check
 * @returns {Array<{ field: string, rule: string, message: string }>}
 */
export function validateItem(schema, item) {
  if (!schema || typeof schema !== 'object') return []
  if (schema.fields) return validateFields(schema.fields, item, '')
  // `sections`-form schemas are deferred upstream (rich model — not reproducible
  // from a flat file); this is a no-op safety net.
  return []
}

/**
 * Whether a normalized schema can be checked statically against a flat file.
 * `fields`-form yes; `sections`-form no (the rich, backend-graph case).
 */
export function isStaticallyCheckable(schema) {
  return !!(schema && typeof schema === 'object' && schema.fields)
}

function validateFields(fields, obj, prefix) {
  const out = []
  const record = isPlainObject(obj) ? obj : {}
  for (const [name, rawDef] of Object.entries(fields)) {
    const def = asFieldDef(rawDef)
    const path = prefix ? `${prefix}.${name}` : name
    const has = Object.prototype.hasOwnProperty.call(record, name) && record[name] != null

    // required — a promised field with no value. Don't flag a merely-absent
    // optional field: the runtime fills it from `default` (or leaves it unset).
    if (def.required === true && !has) {
      out.push(violation(path, 'required', `missing required field '${path}'`))
      continue
    }
    if (!has) continue

    out.push(...validateValue(def, record[name], path))
  }
  return out
}

function validateValue(def, value, path) {
  const out = []
  const kind = def.type

  // ref / options — a reference into the entity graph (entity_ref / item_ref).
  // Its target isn't resolvable without the backend, so the value can't be
  // checked statically. `required` already ran in validateFields; presence is
  // all we can assert here.
  if (kind === 'ref' || def.options !== undefined) return out

  // enum (inline picklist) — the value must be one of the allowed set. Mirrors
  // the runtime, which checks enum membership regardless of the base type, so a
  // wrong-type-and-wrong-value lands as one clear enum finding (not two).
  if (Array.isArray(def.enum)) {
    if (!def.enum.includes(value)) {
      out.push(violation(path, 'enum', `${fmt(value)} is not one of [${def.enum.map(fmt).join(', ')}]`))
    }
    return out
  }

  if (kind === 'object') {
    if (!isPlainObject(value)) {
      out.push(violation(path, 'type', `expected object, got ${typeName(value)}`))
    } else if (def.fields) {
      out.push(...validateFields(def.fields, value, path))
    }
    return out
  }

  if (kind === 'array') {
    if (!Array.isArray(value)) {
      out.push(violation(path, 'type', `expected array, got ${typeName(value)}`))
    } else if (def.items !== undefined) {
      const itemDef = asFieldDef(def.items)
      value.forEach((el, i) => out.push(...validateValue(itemDef, el, `${path}[${i}]`)))
    }
    return out
  }

  // scalar kind
  if (!isKind(kind, value)) {
    out.push(violation(path, 'type', `expected ${kind}, got ${typeName(value)}`))
    return out
  }

  // format (url / email) — only on present string scalars
  if (typeof value === 'string' && FORMAT_TYPES.has(def.format)) {
    if (def.format === 'email' && !isEmailish(value)) {
      out.push(violation(path, 'format', `${fmt(value)} is not a valid email`))
    } else if (def.format === 'url' && !isUrlish(value)) {
      out.push(violation(path, 'format', `${fmt(value)} is not a valid url`))
    }
  }

  return out
}

// Scalar kinds this checker knows how to verify. Kept in lockstep with the
// normalizer's SCALAR_KINDS by the coverage guard at the bottom of this file —
// adding a kind to the shared vocabulary without teaching the checker throws at
// module load, rather than silently passing everything via the default branch.
const KNOWN_SCALAR_KINDS = new Set([
  'string', 'text', 'file',
  'int', 'decimal', 'bool', 'date', 'datetime', 'json',
])

/**
 * Does a value match a canonical scalar kind?
 */
function isKind(kind, value) {
  switch (kind) {
    case 'string':
    case 'text':
    case 'file':
      return typeof value === 'string'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'decimal':
      return typeof value === 'number' && Number.isFinite(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'date':
    case 'datetime':
      // YAML parses bare dates to Date objects; JSON carries them as strings.
      return typeof value === 'string' || value instanceof Date
    case 'json':
      return true // structured / untyped — no scalar constraint
    default:
      return true // unknown kind → forward-compatible, not a violation
  }
}

// Lenient format checks — strict enough to catch garbage, loose enough not to
// flag the shapes authors legitimately write (bare domains, root-relative
// paths). The north star is no false positives.
function isEmailish(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())
}
function isUrlish(v) {
  const s = v.trim()
  if (!s || /\s/.test(s)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true // scheme://
  if (s.startsWith('//') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return true // bare domain (example.com, sub.site.io/x)
  return false
}

function violation(field, rule, message) {
  return { field, rule, message }
}

function asFieldDef(def) {
  // Normalized schemas always carry objects, but tolerate a bare type string
  // (the authoring shorthand) so callers can validate against either form.
  if (typeof def === 'string') return { type: def }
  return def && typeof def === 'object' ? def : { type: undefined }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

function typeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  return typeof v
}

function fmt(v) {
  if (typeof v === 'string') return `"${v}"`
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

// --- the join: sections ↔ schemas -------------------------------------------

/**
 * Walk a site's sections, pair each governed data input with its schema, and
 * validate. The section is the join point: it has a *type* (→ `meta.js` → a
 * schema per input key) and *data inputs* (→ files). Keying off the section is
 * the only well-defined granularity — one collection bound under two schemas in
 * two sections has no single "collection schema"; each section input does. It's
 * also the same join the runtime uses to apply defaults, so check and fill
 * agree on which schema governs what by construction.
 *
 * Inputs are consumed from what the canonical build parsers already compute —
 * `section.fetch` (the binding resolved from `data:` / `fetch:`) and
 * `schema.json[type].data` (the key→ref bindings). Re-deriving either would let
 * this command and the build disagree about what feeds what.
 *
 * Data is acquired without a full build: the foundation schema via schema
 * discovery, the site sections via the content collector, the collections via
 * the collection processor (in-memory, full records — so `deferred:`
 * field-stripping never causes a false "missing required").
 *
 * @param {Object} params
 * @param {string} params.siteRoot - Absolute path to the site directory.
 * @param {string} params.foundationPath - Absolute path to the local foundation.
 * @returns {Promise<Report>}
 *
 * @typedef {Object} Report
 * @property {Array<Object>} violations - Each: { file, schema, item, field, rule, message, users }.
 * @property {Array<Object>} deferred - Inputs not statically checkable: { route, section, key, reason, ref?, url? }.
 * @property {Array<Object>} setupErrors - Read failures: { file, message, users }.
 * @property {{ records: number, schemas: number, violations: number, deferred: number }} summary
 */
export async function validateDataInputs({ siteRoot, foundationPath }) {
  if (!siteRoot) throw new Error('validateDataInputs: siteRoot is required')
  if (!foundationPath) throw new Error('validateDataInputs: foundationPath is required')

  const srcDir = resolveFoundationSrcPath(foundationPath)
  const foundation = await buildSchema(srcDir)
  const dataSchemas = foundation.dataSchemas || {}

  const site = await collectSiteContent(siteRoot, { foundationPath })
  const config = site.config || {}
  const basePath = typeof config.base === 'string' ? config.base : '/'

  // Compile file-based collections in-memory (the same step the data-only
  // pipeline runs). Full records — `writeCollectionFiles` is the stage that
  // strips `deferred:` fields, and we skip it.
  let collections = {}
  if (config.collections && typeof config.collections === 'object') {
    const collectionsBase = config.paths?.collections
      ? resolve(siteRoot, config.paths.collections)
      : null
    collections = await processCollections(siteRoot, config.collections, collectionsBase, basePath)
  }

  // Pass 1 — discover unique (file, schema-ref) pairs and who uses each.
  const work = new Map() // pairKey -> { path, ref, schema, users: [{ route, section, key }] }
  const deferred = []

  for (const page of site.pages || []) {
    walkSections(page.sections || [], (section) => {
      const type = section.type
      if (!type) return
      const bindings = foundation[type]?.data
      for (const input of collectInputs(section, page.fetch, config.fetch)) {
        const key = input.schema // the content.data KEY (the `fetch.schema` field is mis-named)

        if (input.url) {
          deferred.push({ route: page.route, section: type, key, reason: 'remote url: source', url: input.url })
          continue
        }
        if (!input.path) continue

        const binding = bindings?.[key]
        const ref = typeof binding === 'string' ? binding : binding?.schema
        if (!ref) continue // ungoverned input — no schema bound to this key

        const schema = dataSchemas[ref]
        if (!schema) continue // build guarantees refs resolve; defensive skip

        if (!isStaticallyCheckable(schema)) {
          deferred.push({ route: page.route, section: type, key, reason: 'rich sections-form schema', ref })
          continue
        }

        const pairKey = `${input.path} ${ref}`
        let entry = work.get(pairKey)
        if (!entry) {
          entry = { path: input.path, ref, schema, users: [] }
          work.set(pairKey, entry)
        }
        entry.users.push({ route: page.route, section: type, key })
      }
    })
  }

  // Pass 2 — validate each unique pair ONCE, attribute findings to its users.
  const violations = []
  const setupErrors = []
  const schemasSeen = new Set()
  let recordCount = 0

  for (const entry of work.values()) {
    const { records, error } = await resolveRecords(entry.path, { collections, siteRoot })
    if (error) {
      setupErrors.push({ file: entry.path, message: error, users: entry.users })
      continue
    }

    schemasSeen.add(entry.ref)
    const items = Array.isArray(records) ? records : [records]
    items.forEach((item, idx) => {
      recordCount++
      for (const finding of validateItem(entry.schema, item)) {
        violations.push({
          file: entry.path,
          schema: entry.ref,
          item: itemLabel(item, idx),
          users: entry.users,
          ...finding,
        })
      }
    })
  }

  // Pass 3 — concept blocks, which join to a schema by CONVENTION rather than
  // by a foundation binding. Additive and silent unless a schema resolves.
  const concepts = await validateConceptBlocks(site)
  violations.push(...concepts.violations)
  for (const ref of concepts.schemas) schemasSeen.add(ref)
  recordCount += concepts.checked

  return {
    violations,
    deferred,
    setupErrors,
    summary: {
      records: recordCount,
      schemas: schemasSeen.size,
      violations: violations.length,
      deferred: deferred.length,
    },
  }
}

/**
 * Check each ```md:<tag> concept block against `@std/<tag>`, when that schema
 * exists.
 *
 * THREE PROPERTIES MAKE THIS SAFE, and all three have to hold:
 *
 * 1. It adds NO REGISTRY. The resolution is mechanical — `md:faq` → `@std/faq`,
 *    the same `@std` → `@uniweb/schemas` mapping every other ref uses. What the
 *    framework gains is a naming convention; no code branches on the value of a
 *    tag, and nothing here knows which concepts exist. A hardcoded list of
 *    concept names is the thing this whole design exists to avoid, and it would
 *    arrive through this door if the check needed to know what `faq` means.
 *
 * 2. It never touches SHAPE. A concept block's shape comes from its fence,
 *    unconditionally. This runs after the parse and changes nothing: a block
 *    with no resolvable schema still parses, still delivers items, still
 *    renders. The schema is a check, never a gate.
 *
 * 3. It never fails at RENDER. Findings only — this whole module is a pre-live
 *    dev/CI gate and the runtime stays tolerant.
 *
 * ⛔ A standard schema for a concept MUST be authored in the ITEM vocabulary —
 * `title`, `paragraphs`, and the rest of the parsed shape — because that is what
 * a concept block always produces. An `@std/faq` written as `{ question, answer }`
 * could only be checked with a per-concept field mapping, which is the forbidden
 * registry arriving by the back door. Author the schema to match the parse, or
 * do not ship the schema.
 *
 * ⚠️ And `required` is INERT here, which is the first thing a schema author will
 * reach for. The item vocabulary is TOTAL — the semantic parser's `flattenGroup`
 * fills every field it declares, so `title` on a titleless item is `''` rather
 * than absent, and `required` fires only on an absent or null value. "The author
 * actually wrote a question" is not expressible that way. The facets that bite
 * against a parsed item are the ones about a value's SHAPE (`type`, `enum`,
 * `format`, nested `fields`/`items`). Which is also a fair argument that
 * validation here is thin, and a reason not to ship a standard schema for a
 * concept until one earns its place.
 *
 * Note on resolution: this deliberately does NOT go through `resolveSchemaRef`,
 * which resolves a package from a FOUNDATION's node_modules and throws when a
 * ref is unknown. Neither fits — a concept block needs no foundation (so this
 * works on a link-mode site whose foundation is a registry ref with nothing
 * local), and an unresolved tag must be silent rather than an error. So the
 * package is resolved from this build's own graph, where it is an
 * optionalDependency, exactly as `i18n/collections.js` resolves it.
 *
 * @param {Object} site - collected site content (`{ pages }`)
 * @returns {Promise<{ violations: Array, schemas: Set<string>, checked: number }>}
 */
export async function validateConceptBlocks(site) {
  const empty = { violations: [], schemas: new Set(), checked: 0 }

  const parse = await loadSemanticParser()
  if (!parse) return empty // no parser available — nothing to derive items from

  const standards = await loadStandardSchemas()
  if (!standards) return empty // @uniweb/schemas absent — nothing to check against

  const violations = []
  const schemasSeen = new Set()
  let checked = 0

  for (const page of site.pages || []) {
    walkSections(page.sections || [], (section) => {
      const doc = section.content
      if (doc?.type !== 'doc') return

      for (const node of conceptBlockNodes(doc)) {
        const tag = node.attrs?.tag
        if (!tag) continue

        const raw = standards(tag)
        if (!raw) continue // no `@std/<tag>` — say nothing, by design

        let schema
        try {
          schema = validateAndNormalizeSchema(raw, `@std/${tag}`)
        } catch {
          continue // a malformed standard schema is that package's problem
        }
        if (!isStaticallyCheckable(schema)) continue

        schemasSeen.add(`@std/${tag}`)
        const { items } = parse({ type: 'doc', content: node.content || [] }, { alwaysItems: true })

        items.forEach((item, idx) => {
          checked++
          for (const finding of validateItem(schema, item)) {
            violations.push({
              file: `${page.route || '/'} › ${section.type || 'section'} › md:${tag}`,
              schema: `@std/${tag}`,
              item: `item ${idx + 1}`,
              users: [{ route: page.route, section: section.type, key: tag }],
              ...finding,
            })
          }
        })
      }
    })
  }

  return { violations, schemas: schemasSeen, checked }
}

/** Every concept block in a doc, including any nested inside a container. */
function conceptBlockNodes(doc) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue
      if (node.type === 'concept_block') out.push(node)
      else if (Array.isArray(node.content)) walk(node.content)
    }
  }
  walk(doc?.content)
  return out
}

/** `parseContent`, or null when the parser is not installed. */
async function loadSemanticParser() {
  try {
    const mod = await import('@uniweb/semantic-parser')
    return typeof mod.parseContent === 'function' ? mod.parseContent : null
  } catch {
    return null
  }
}

/** A `(name) => schema | undefined` lookup over `@std`, or null when absent. */
async function loadStandardSchemas() {
  try {
    const mod = await import('@uniweb/schemas')
    if (typeof mod.getSchema === 'function') return (name) => mod.getSchema(name)
    const table = mod.schemas ?? mod.default
    return table ? (name) => table[name] : null
  } catch {
    return null
  }
}

/**
 * The data inputs available to a section, deduped by key. A section receives
 * its own fetch plus any inherited page-level and site-level fetch (default-on
 * cascade); when two levels share a key, the nearer one wins (section > page >
 * site) — the same precedence the runtime delivers.
 */
function collectInputs(section, pageFetch, siteFetch) {
  const byKey = new Map()
  for (const f of [siteFetch, pageFetch, section.fetch]) {
    if (f && (f.path || f.url) && typeof f.schema === 'string') {
      byKey.set(f.schema, f)
    }
  }
  return [...byKey.values()]
}

/**
 * Visit every section on a page, descending into nested child sections
 * (`subsections`). A nested section is still a section with a type and a fetch,
 * so it joins to a schema the same way a top-level one does.
 */
function walkSections(sections, visit) {
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    visit(section)
    if (Array.isArray(section.subsections) && section.subsections.length > 0) {
      walkSections(section.subsections, visit)
    }
  }
}

/**
 * Resolve a fetch `path` to its records. Declared collections come from the
 * in-memory compile (full records, current); a bare file under `public/`
 * (hand-authored data) is read from disk. Either way no prior build is needed.
 */
async function resolveRecords(path, { collections, siteRoot }) {
  // A compiled-collection URL → a declared collection? Use the compiled
  // records. Anything else falls through to the file read below.
  const name = collectionNameFromUrl(path)
  let records
  if (Object.prototype.hasOwnProperty.call(collections, name)) {
    records = collections[name]
  } else {
    // Otherwise read the file from public/ (the data-fetcher's resolution root).
    const filePath = join(siteRoot, 'public', path)
    if (!existsSync(filePath)) {
      return { error: `file not found: public${path}` }
    }
    try {
      const text = await readFile(filePath, 'utf8')
      if (path.endsWith('.json')) records = JSON.parse(text)
      else if (path.endsWith('.yml') || path.endsWith('.yaml')) records = yaml.load(text)
      else {
        // Unknown extension — try JSON, then YAML.
        try {
          records = JSON.parse(text)
        } catch {
          records = yaml.load(text)
        }
      }
    } catch (err) {
      return { error: err.message }
    }
  }

  // Validate the shape that actually SHIPS. `/data/*.json` is JSON, so a YAML
  // date (parsed to a Date object in memory) serializes to an ISO string, while
  // booleans / numbers / nesting are unchanged. Checking the JSON-round-tripped
  // form makes the checker agree with the serialized payload the runtime and
  // backend receive — and with the prerendered HTML oracle — so a string-typed
  // date field isn't a false "expected string, got date".
  return { records: toShippedShape(records) }
}

/** The JSON-serialized shape a record takes once written to `/data/*.json`. */
function toShippedShape(value) {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

function itemLabel(item, idx) {
  if (item && typeof item === 'object') {
    if (typeof item.slug === 'string' && item.slug) return item.slug
    if (typeof item.id === 'string' && item.id) return item.id
  }
  return String(idx)
}

// Coverage guard — see KNOWN_SCALAR_KINDS. Every scalar kind the normalizer can
// emit must be one this checker handles, so the two never drift apart silently.
for (const kind of SCALAR_KINDS) {
  if (!KNOWN_SCALAR_KINDS.has(kind)) {
    throw new Error(
      `validate-data: scalar kind '${kind}' is in the schema vocabulary but has ` +
        'no conformance predicate. Add a case to isKind() and KNOWN_SCALAR_KINDS.'
    )
  }
}
