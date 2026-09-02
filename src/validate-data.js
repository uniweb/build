/**
 * Data-conformance checker (build time)
 *
 * Checks a project's file-based data inputs against the data schemas the
 * foundation declared for the sections that consume them. Answers one
 * question: *is my data correct according to the schemas I said it should
 * comply with?*
 *
 * Two layers, and only the second one lives here:
 *   - `validateItem(schema, item)` — pure, facet-driven: walks a normalized
 *     schema's declared facets (required / type / enum / format / nested
 *     object+array / open map) and emits one finding per failed facet. No I/O.
 *     It now lives in `@uniweb/schemas/conform`, beside the vocabulary it must
 *     agree with, and is re-exported below so every caller here is unchanged.
 *   - `validateDataInputs({ siteRoot, foundationPath })` — the join: pairs each
 *     section's data input with the schema its `meta.js` binds to that key,
 *     validates each unique (file, schema) pair once, and attributes findings
 *     back to the sections that use it. This half needs a disk, so it stays.
 *
 * This is a pre-live dev/CI gate, not a render-time guard. The runtime stays
 * tolerant (apply defaults, ignore the rest); a wrong value is best caught
 * here, before a site is live — so the engine returns findings and the caller
 * decides whether they should fail a build (CI treats them as errors).
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import yaml from 'js-yaml'
import { queryNameFromUrl } from '@uniweb/core'

import { validateItem, isStaticallyCheckable, validateBound } from '@uniweb/schemas/conform'
import { validateAndNormalizeSchema } from './resolve-data-schema.js'

// The pure checker, re-exported so `@uniweb/build/validate` stays the one import
// path callers know (`uniweb validate`, the CLI, and the contract tests all
// reach it here) even though the implementation moved next to the vocabulary.
export { validateItem, isStaticallyCheckable } from '@uniweb/schemas/conform'
import { buildSchema } from './schema.js'
import { toFetchList } from './site/data-fetcher.js'
import { resolveFoundationSrcPath } from './utils/foundation-source-root.js'
import { collectSiteContent } from './site/content-collector.js'
import { processQueries } from './site/query-processor.js'

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
 * discovery, the site sections via the content collector, the byQuery via
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

  // Compile file-based byQuery in-memory (the same step the data-only
  // pipeline runs). Full records — `writeQueryFiles` is the stage that
  // strips `deferred:` fields, and we skip it.
  let byQuery = {}
  if (config.queries && typeof config.queries === 'object') {

    byQuery = await processQueries(siteRoot, config.queries, config.paths?.entities, basePath)
  }

  // Declared here rather than beside pass 2's other accumulators because pass 1
  // now writes to it as well — see THE JOIN, RUN THE OTHER WAY below.
  const setupErrors = []

  // Pass 1 — discover unique (file, schema-ref) pairs and who uses each.
  const work = new Map() // pairKey -> { path, ref, schema, users: [{ route, section, key }] }
  const deferred = []

  for (const page of site.pages || []) {
    walkSections(page.sections || [], (section) => {
      const type = section.type
      if (!type) return
      const bindings = foundation[type]?.data
      const inputs = collectInputs(section, page.fetch, config.fetch)

      // ⭐ **THE JOIN, RUN THE OTHER WAY: data arrived, but under no name this
      // section reads.** Everything below asks "for each input, is there a
      // binding?". This asks "for each binding, was anything delivered?" — and
      // the answer was silence until 2026-09-02.
      //
      // A section reads `content.data.<key>` for the keys its `meta.js` `data:`
      // declares. When the page delivers a query under a DIFFERENT name, the
      // section renders its heading and nothing else: no error, no warning, HTTP
      // 200, a clean console. Reported by `flows`, measured in a real browser —
      // two records-backed sections carrying 8 and 6 characters of text beside
      // static ones carrying 182/572/289/529/99.
      //
      // ⚖️ **Narrow on purpose: only when SOMETHING was delivered.** `data:` in
      // `meta.js` is a hint rather than a delivery gate (`docs/reference/
      // data-fetching.md`), so a section declaring keys on a page with no data at
      // all is ordinary and silent. What is not ordinary is a page that fetched
      // something and a section on it that reads none of it — there the author
      // demonstrably intended data to arrive and the names did not meet.
      const declaredKeys = bindings ? Object.keys(bindings) : []
      if (declaredKeys.length > 0 && inputs.length > 0) {
        const delivered = inputs.map((i) => i.as ?? i.schema).filter(Boolean)
        if (delivered.length > 0 && !declaredKeys.some((k) => delivered.includes(k))) {
          setupErrors.push({
            file: `${page.route || '/'} · ${type}`,
            message:
              `section reads ${declaredKeys.map((k) => `content.data.${k}`).join(' or ')}, ` +
              `but this page delivers ${delivered.map((k) => `\`${k}\``).join(', ')}. ` +
              `The section will render with no data and nothing else will say so. ` +
              `Name the query for the key the section reads, or give the section its own ` +
              `\`fetch: { query: <name> }\`.`,
            // One user per declared key, so `uniweb validate` can print
            // `used by /team › Team › data.team` — the key is the thing to rename.
            users: declaredKeys.map((k) => ({ route: page.route, section: type, key: k })),
          })
        }
      }

      for (const input of inputs) {
        const key = input.as ?? input.schema // the content.data KEY; `schema` is its pre-2026-09-02 name

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
  const schemasSeen = new Set()
  let recordCount = 0

  for (const entry of work.values()) {
    const { records, error } = await resolveRecords(entry.path, { byQuery, siteRoot })
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

  // Pass 4 — tagged data blocks, which join by the component's OWN binding.
  const blocks = validateTaggedDataBlocks(site, foundation, dataSchemas)
  violations.push(...blocks.violations)
  deferred.push(...blocks.deferred)
  for (const ref of blocks.schemas) schemasSeen.add(ref)
  recordCount += blocks.checked

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
 * ⛔ AND FOR A PROSE CONCEPT, NO FACET CAN FIRE AT ALL — so do not write an
 * `@std` schema for one. Measured 2026-07-30:
 *
 *   - `required` is inert. The item vocabulary is TOTAL — `flattenGroup` fills
 *     every field it declares, so a titleless item has `title: ''` rather than
 *     no title, and `required` fires only on absent or null. "The author
 *     actually wrote a question" is not expressible.
 *   - `type` cannot fail either. Inside a concept block `title` is always a
 *     string (never an array — `alwaysItems` suppresses the same-level merge
 *     that would make one) and `paragraphs` is always an array of strings.
 *   - which leaves `enum` / `format`, and neither has a natural application to
 *     a question or an answer. The test suite had to invent `format: 'url'` on
 *     a question to make anything fire — that is the tell, not a fixture quirk.
 *
 * The mechanism still earns its place, but it is waiting for a different shape:
 * a concept that carries a tagged DATA BLOCK. Verified that one reaches the item
 * — ```` ```md:steps ```` holding a ```` ```yaml:meta ```` gives
 * `items[0].data.meta` — and there `required` fires when an author omits the
 * block, `enum` constrains a status, `format` constrains a duration. That is the
 * trigger to write a schema. Until then the frontend holds the concept names and
 * their shapes, which is where they belong: its extension encodes the shape
 * executably, and a `standard/faq.js` in `@uniweb/schemas` whose only consumer is
 * that app would be this framework stating which concepts exist — the registry
 * this design forbids, spelled as a filename instead of a switch.
 *
 * Note on resolution: this deliberately does NOT go through `resolveSchemaRef`,
 * which resolves a package from a FOUNDATION's node_modules and throws when a
 * ref is unknown. Neither fits — a concept block needs no foundation (so this
 * works on a link-mode site whose foundation is a registry ref with nothing
 * local), and an unresolved tag must be silent rather than an error. So the
 * package is resolved from this build's own graph, where it is an
 * optionalDependency, exactly as `i18n/records.js` resolves it.
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
  return nodesOfType(doc, 'concept_block')
}

function nodesOfType(doc, type) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue
      if (node.type === type) out.push(node)
      else if (Array.isArray(node.content)) walk(node.content)
    }
  }
  walk(doc?.content)
  return out
}

/**
 * Check each ```` ```yaml:<tag> ```` / ```` ```json:<tag> ```` data block against
 * the schema the section's own component BOUND to that key.
 *
 * This is the pass that closes an odd hole: a component declares
 * `data: { form: '@std/form' }`, an author writes a ```` ```yaml:form ```` block,
 * and until now **nothing checked one against the other**. The join walked
 * `section.fetch` — byQuery and fetches — so a schema bound to a key that a
 * tagged block fills was never applied to anything. `@std/form` existed for
 * exactly this and had never run outside its own contract test.
 *
 * Unlike concept blocks (pass 3), the join here is NOT by convention. A concept
 * block resolves `md:faq` → `@std/faq` mechanically, which is why that pass must
 * stay silent when no such schema exists. This one uses the binding the component
 * actually declared, so there is no naming rule and no registry — a tag nobody
 * bound is simply not governed, and says nothing.
 *
 * The value needs no parsing: a tagged fence lands as a `dataBlock` node with its
 * parsed value already on `attrs.data`, and a body that FAILED to parse never
 * becomes one (it falls back to `codeBlock`), so a malformed block cannot reach
 * here and be misreported as a schema violation.
 *
 * Uses `validateBound` rather than `validateItem` because a block's value may be
 * a record OR a list — ```` ```yaml:nav ```` is a bare array. That dispatch is the
 * reason root-list conformance had to land first.
 *
 * @param {Object} site - collected site content
 * @param {Object} foundation - the built foundation schema (type → { data })
 * @param {Object} dataSchemas - normalized schemas keyed by ref
 * @returns {{ violations: Array, schemas: Set<string>, checked: number, deferred: Array }}
 */
export function validateTaggedDataBlocks(site, foundation, dataSchemas) {
  const violations = []
  const schemas = new Set()
  const deferred = []
  let checked = 0

  for (const page of site?.pages || []) {
    walkSections(page.sections || [], (section) => {
      const type = section.type
      const bindings = type && foundation?.[type]?.data
      if (!bindings || typeof bindings !== 'object') return

      for (const node of nodesOfType(section.content, 'dataBlock')) {
        const tag = node.attrs?.tag
        if (!tag) continue

        const binding = bindings[tag]
        if (binding === undefined) continue // this key is not governed — say nothing

        // A binding is a named ref, or an inline schema. Only a ref resolves to a
        // normalized schema here; an inline one is reported rather than guessed at.
        const ref = typeof binding === 'string' ? binding : binding?.schema
        if (typeof ref !== 'string') {
          deferred.push({ route: page.route, section: type, key: tag, reason: 'inline schema on the binding' })
          continue
        }
        const schema = dataSchemas?.[ref]
        if (!schema) continue // unresolved ref — the build reports that on its own

        schemas.add(ref)
        checked++
        for (const finding of validateBound(schema, node.attrs?.data)) {
          violations.push({
            file: `${page.route || '/'} › ${type} › ${node.attrs?.language || 'yaml'}:${tag}`,
            schema: ref,
            item: `data.${tag}`,
            users: [{ route: page.route, section: type, key: tag }],
            ...finding,
          })
        }
      }
    })
  }

  return { violations, schemas, checked, deferred }
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
  // ⭐ Each level may declare SEVERAL — `data: [team, articles]` — so each is
  // flattened rather than read. Order is least- to most-specific and `set`
  // overwrites, which is what makes a section's declaration win the key.
  for (const source of [siteFetch, pageFetch, section.fetch]) {
    for (const f of toFetchList(source)) {
      // ⛔ The binding key is `as`; `schema` is its pre-2026-09-02 name and still
      // arrives on stored payloads. A gate on the old name alone silently yields
      // NOTHING here — no inputs collected, no violations found, a green run — which
      // is exactly how this was caught: the integration test went from flagging the
      // seeded violations to flagging none.
      const key = f?.as ?? f?.schema
      if (f && (f.path || f.url) && typeof key === 'string') {
        byKey.set(key, f)
      }
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
 * Resolve a fetch `path` to its records. Declared byQuery come from the
 * in-memory compile (full records, current); a bare file under `public/`
 * (hand-authored data) is read from disk. Either way no prior build is needed.
 */
async function resolveRecords(path, { byQuery, siteRoot }) {
  // A compiled-collection URL → a declared collection? Use the compiled
  // records. Anything else falls through to the file read below.
  const name = queryNameFromUrl(path)
  let records
  if (Object.prototype.hasOwnProperty.call(byQuery, name)) {
    records = byQuery[name]
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
