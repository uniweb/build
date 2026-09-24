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
import { YAML_OPTIONS } from './utils/yaml-schema.js'
import { queryNameFromUrl, declaredKeys, fillDeclaredKeys, fetchLevels, pageRouteQuery } from '@uniweb/core'
import { parentRouteOf } from '@uniweb/core/route-match'

import { validateItem, validateBound, flatRecordFields, rootListSection } from '@uniweb/schemas/conform'
import { validateAndNormalizeSchema, buildDataSchemaMap } from './resolve-data-schema.js'

// The pure checker, re-exported so `@uniweb/build/validate` stays the one import
// path callers know (`uniweb validate`, the CLI, and the contract tests all
// reach it here) even though the implementation moved next to the vocabulary.
export { validateItem, isStaticallyCheckable } from '@uniweb/schemas/conform'
import { buildSchema } from './schema.js'
import { resolveRecordsDir, readEntityPool, groupPoolBySchema } from './site/entity-pool.js'
import { readEntityFile } from './uwx/entity-source.js'
import { isContentBodyField } from './uwx/data-schema.js'
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
 * `section.fetch` (the binding resolved from `query:` / `fetch:`) and
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
 * @property {Array<Object>} deferred - Inputs not checked: data not in the project (an external query), or an inline schema on a binding — { route, section, key, reason, ref?, url? }.
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

    // Drafts included: a draft is content the site will deliver, so it is checked now.
    byQuery = await processQueries(siteRoot, config.queries, resolveRecordsDir(siteRoot, config.paths).rel, basePath, { includeDrafts: true })
  }

  // Declared here rather than beside pass 2's other accumulators because pass 1
  // now writes to it as well — see THE JOIN, RUN THE OTHER WAY below.
  const setupErrors = []

  // Pass 1 — discover unique (file, schema-ref) pairs and who uses each.
  const work = new Map() // pairKey -> { path, ref, schema, users: [{ route, section, key }] }
  const deferred = []

  const byRoute = new Map((site.pages || []).map((p) => [p.route, p]))
  // ⭐ The parent by the ONE parent rule, not the declared field alone: a payload may omit
  // `parent`, and reading it raw gives a page no parent here while every other lane infers one —
  // so the site's fetch reached pages it does not reach, and a parent's reached none.
  const parentOf = (page) => {
    if (!page?.route) return null
    const route = parentRouteOf(page.route, { declared: page.parent ?? null, has: (r) => byRoute.has(r) })
    return route ? byRoute.get(route) ?? null : null
  }
  const access = {
    routeOf: (p) => p?.route,
    parentOf,
    fetchOf: (p) => p?.fetch ?? null,
    sectionsOf: (p) => p?.sections,
    site: config.fetch,
  }
  for (const page of site.pages || []) {
    const parent = parentOf(page)
    // Its route query, when it is on a parametric route — a page nested inside one included,
    // which is a level this check did not have.
    const route = pageRouteQuery(page, access)
    walkSections(page.sections || [], (section) => {
      const type = section.type
      if (!type) return
      const bindings = foundation[type]?.data
      // ⭐ THE RUNTIME'S JOIN (2026-09-14): a section receives the keys its component
      // declares, and which fetch fills each is automatic `as` — `fillDeclaredKeys`, the
      // same function the entity store delivers by — so a `post: '@std/article'` key
      // filled by an `articles` fetch is checked against `@std/article`, and a fetch that
      // fills no declared key is not checked at all, since no component receives it. The
      // levels are the rule's, so this check sees what the render sees (`fetchLevels`,
      // `@uniweb/core/page-data`) — ⛔ it wrote its own list until 2026-09-19, which read only
      // the declared parent and had no route binding for a nested page.
      const declared = declaredKeys(bindings)
      const levels = fetchLevels({ own: section.fetch, page: page.fetch, parent, route, site: config.fetch })
      const inputs = collectInputs(levels)
      const held = nodesOfType(section.content, 'dataBlock').map((node) => node.attrs?.tag).filter(Boolean)
      const fills = fillDeclaredKeys(declared, levels, { queries: config.queries, held })

      // ⭐ **THE JOIN, RUN THE OTHER WAY: data arrived, and no key this section reads is
      // filled by it.** Everything below asks "for each filled key, is its data right?".
      // This asks "was anything this section reads filled?" — and the answer was silence
      // until 2026-09-02.
      //
      // A section reads `content.data.<key>` for the keys its `meta.js` `data:` declares.
      // When nothing on the page fills them — no fetch under the key, none of its schema —
      // the section renders its heading and nothing else: no error, no warning, HTTP 200,
      // a clean console. Reported by `flows`, measured in a real browser — two
      // records-backed sections carrying 8 and 6 characters of text beside static ones
      // carrying 182/572/289/529/99.
      //
      // ⚖️ **Narrow on purpose: only when SOMETHING was delivered.** A section declaring
      // keys on a page with no data at all is ordinary and silent. What is not ordinary is
      // a page that fetched something and a section on it that receives none of it —
      // there the author demonstrably intended data to arrive and the names did not meet.
      const declaredNames = declared.map(([key]) => key)
      if (declaredNames.length > 0 && inputs.length > 0 && fills.size === 0 && !declaredNames.some((k) => held.includes(k))) {
        const delivered = inputs.map((i) => i.as).filter(Boolean)
        setupErrors.push({
          file: `${page.route || '/'} · ${type}`,
          message:
            `section reads ${declaredNames.map((k) => `content.data.${k}`).join(' or ')}, ` +
            `but this page delivers ${delivered.map((k) => `\`${k}\``).join(', ')}, and none of it fills them — ` +
            `not by name, and not by schema. The section will render with no data and nothing else will say so. ` +
            `Name the query for the key the section reads, give the fetch that key with \`as:\`, or give the ` +
            `section its own \`query: <name>\`.`,
          // One user per declared key, so `uniweb validate` can print
          // `used by /team › Team › data.team` — the key is the thing to rename.
          users: declaredNames.map((k) => ({ route: page.route, section: type, key: k })),
        })
      }

      for (const [key, { fetch: input }] of fills) {
        // An external query's records are its address's, fetched where the page renders.
        const external = typeof input.query === 'string' ? config.queries?.[input.query]?.url : undefined
        if (input.url || external) {
          deferred.push({ route: page.route, section: type, key, reason: 'external query', url: input.url ?? external })
          continue
        }
        if (!input.path) continue

        const binding = bindings?.[key]
        const ref = typeof binding === 'string' ? binding : binding?.schema
        if (!ref) continue // ungoverned key — no schema declared for it

        const schema = dataSchemas[ref]
        if (!schema) continue // build guarantees refs resolve; defensive skip

        // ⭐ Every schema is checked (2026-09-24): a sections-form one per record, flat or
        // written by section, and one whose ROOT IS A LIST as the list the key receives
        // (pass 2). A list root was deferred here until then, though the query's records
        // are exactly that list.

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
  // (schema, slug) of every record this pass checked, so pass 5 checks the rest.
  const checkedRecords = new Set()

  for (const entry of work.values()) {
    const { records, error } = await resolveRecords(entry.path, { byQuery, siteRoot })
    if (error) {
      setupErrors.push({ file: entry.path, message: error, users: entry.users })
      continue
    }

    schemasSeen.add(entry.ref)
    const items = Array.isArray(records) ? records : [records]

    // A schema whose ROOT IS A LIST describes the whole value the key receives, and the
    // query's records ARE that list — so they are checked once, as the list. Any other
    // schema describes one record, checked per record.
    if (rootListSection(entry.schema)) {
      recordCount += items.length
      const base = { file: entry.path, schema: entry.ref, users: entry.users }
      for (const finding of validateBound(entry.schema, items)) {
        violations.push(listViolation(finding, (idx) => itemLabel(items[idx], idx), base))
      }
      continue
    }

    items.forEach((item, idx) => {
      recordCount++
      if (item && typeof item.slug === 'string') checkedRecords.add(recordKey(entry.ref, item.slug))
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

  // Pass 5 — every record file no section's binding reached, against the data schema
  // its folder names. ⭐ The set a push sends: every file in the records directory is
  // a record and every record is pushed, whether or not a section reads it — and
  // until 2026-09-24 one that no section read was never checked here.
  const files = await validateRecordFiles(siteRoot, { srcDir, dataSchemas, paths: config.paths, checked: checkedRecords })
  violations.push(...files.violations)
  setupErrors.push(...files.setupErrors)
  for (const ref of files.schemas) schemasSeen.add(ref)
  recordCount += files.checked

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

const recordKey = (ref, slug) => `${ref}\u0000${slug}`

// A finding from checking a whole list (`validateBound`) names its element by index —
// `[3].label` — so the element is named the way a per-record finding names its record,
// by `label(3)`, and the path is left relative to it.
function listViolation(finding, label, base) {
  const m = /^\[(\d+)\]\.?/.exec(finding.field || '')
  if (!m) return { ...base, item: 'the list', ...finding }
  const idx = Number(m[1])
  return { ...base, item: label(idx), ...finding, field: finding.field.slice(m[0].length) || finding.field }
}

/**
 * Check the records in the records directory that pass 2 did not, each against the
 * data schema its folder names (`records/member/` → `@/member`).
 *
 * A record is read the way a push reads it (`uwx/entity-source.js`), and a markdown
 * record's body is the value of its schema's content body field unless its
 * frontmatter sets one — which is what a push sends it as (`uwx/records.js`).
 *
 * A folder whose schema resolves to nothing is left out in silence: its records are
 * schema-less, delivered as files, and the push says so itself.
 *
 * @returns {Promise<{ violations: object[], setupErrors: object[], schemas: Set<string>, checked: number }>}
 */
async function validateRecordFiles(siteRoot, { srcDir, dataSchemas, paths, checked }) {
  const out = { violations: [], setupErrors: [], schemas: new Set(), checked: 0 }
  const pool = await readEntityPool(siteRoot, { dir: resolveRecordsDir(siteRoot, paths).rel })
  for (const [ref, entities] of groupPoolBySchema(pool.entities)) {
    const schema = await schemaForRecords(ref, { srcDir, dataSchemas })
    // An entity of a list-rooted schema too: it holds the list under its section's key.
    // ⛔ Until 2026-09-24 such a folder was skipped here without a word.
    if (!schema) continue
    for (const pooled of entities) {
      let records
      try {
        records = await readEntityFile(pooled.absPath)
      } catch (err) {
        out.setupErrors.push({ file: pooled.relPath, message: err.message, users: [] })
        continue
      }
      for (const r of records) {
        if (!r.slug || checked.has(recordKey(ref, r.slug))) continue
        out.checked++
        out.schemas.add(ref)
        for (const finding of validateItem(schema, withBody(schema, r))) {
          out.violations.push({ file: pooled.relPath, schema: ref, item: r.slug, users: [], ...finding })
        }
      }
    }
  }
  return out
}

// The schema a records folder names — the one a section binds if any does, else
// resolved the way every other ref is. Null when nothing resolves.
async function schemaForRecords(ref, { srcDir, dataSchemas }) {
  if (dataSchemas[ref]) return dataSchemas[ref]
  try {
    return (await buildDataSchemaMap([ref], { srcDir }))[ref] || null
  } catch {
    return null
  }
}

// A record as a push sends it: a markdown body fills the schema's content body field
// when the frontmatter does not set it.
function withBody(schema, r) {
  const record = { ...(r.data || {}) }
  if (typeof r.body !== 'string' || r.body.trim() === '') return record
  const key = Object.entries(flatRecordFields(schema) || {}).find(([, f]) => isContentBodyField(f))?.[0]
  if (key && record[key] === undefined) record[key] = r.body
  return record
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
        schemasSeen.add(`@std/${tag}`)
        const { items } = parse({ type: 'doc', content: node.content || [] }, { alwaysItems: true })
        const where = {
          file: `${page.route || '/'} › ${section.type || 'section'} › md:${tag}`,
          schema: `@std/${tag}`,
          users: [{ route: page.route, section: section.type, key: tag }],
        }

        // A list-rooted standard describes the block's items TOGETHER, so they are
        // checked as that list; any other describes each item. ⛔ Until 2026-09-24 a
        // list-rooted standard was skipped here without a word.
        if (rootListSection(schema)) {
          checked += items.length
          for (const finding of validateBound(schema, items)) {
            violations.push(listViolation(finding, (idx) => `item ${idx + 1}`, where))
          }
          continue
        }

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
 * The data inputs reaching a section, deduped by key — the fetches of its levels, most
 * specific first; when two levels share a key, the nearer one wins. What each input fills
 * is `fillDeclaredKeys`'s to say; this lists what arrived, for the message when nothing
 * the section reads is filled.
 */
function collectInputs(levels) {
  const byKey = new Map()
  // ⭐ Each level may declare SEVERAL — `query: [team, articles]` — so each is
  // flattened rather than read. Order is least- to most-specific and `set`
  // overwrites, which is what makes a section's declaration win the key.
  for (const source of [...levels].reverse()) {
    for (const f of toFetchList(source)) {
      // ⛔ Gate on the BINDING KEY. A gate on the wrong name silently yields
      // NOTHING here — no inputs collected, no violations found, a green run —
      // which is exactly how the rename was caught: the integration test went
      // from flagging the seeded violations to flagging none.
      const key = f?.as
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
      else if (path.endsWith('.yml') || path.endsWith('.yaml')) records = yaml.load(text, YAML_OPTIONS)
      else {
        // Unknown extension — try JSON, then YAML.
        try {
          records = JSON.parse(text)
        } catch {
          records = yaml.load(text, YAML_OPTIONS)
        }
      }
    } catch (err) {
      return { error: err.message }
    }
  }

  // Validate the shape that actually SHIPS. `/data/*.json` is JSON, so anything a
  // JSON round trip changes is checked as it arrives, while booleans / numbers /
  // nesting are unchanged. Checking the JSON-round-tripped form makes the checker
  // agree with the serialized payload the runtime and backend receive — and with the
  // prerendered HTML oracle. (A YAML date no longer needs it: the build's YAML
  // resolves no timestamps, `utils/yaml-schema.js`, so it is the string as written.)
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
