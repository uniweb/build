/**
 * Assemble the registry-publish `.uwx` — the names-only document `uniweb register`
 * submits to the backend registry (`uwx-format.md` §5).
 *
 * One document: a small envelope, then an `entities:` list — each entity names
 * its coined type with `model:` (by NAME) and carries content directly. **No
 * uuids anywhere** (this is the registry-publish use case, distinct from the
 * uuid-based user-content backup `.uwx` that `content export` of a site emits —
 * `uwx-format.md` §1.1/§6).
 *
 *   entities:
 *     - model: "@uniweb/data-schema"     # one per data schema this foundation DEFINES
 *       …the §3 declaration (from data-schema.js's lowering)…
 *     - model: "@uniweb/mapping-schema"  # one per mapping this foundation defines (src/mappings/)
 *       name, label?, description?, rules: { model, keys_from?, …the rest as written }
 *     - model: "@uniweb/vendor-schema"   # one per vendor file this foundation defines (src/vendors/)
 *       name, exports, sha256, size      # the file itself goes up after, by its sha256
 *     - model: "@uniweb/foundation-schema"   # the foundation (info/schema/i18n/data-schemas/mappings/vendors)
 *
 * `buildSchemaOnlyPackage` (below) assembles the foundation-LESS variant — only
 * `@uniweb/data-schema` entities, no foundation-schema — for a schemas-only
 * package (the standard schemas under `@std`, or an org's own `@org/schemas`).
 *
 * Scope: a foundation whose name is scoped (`@acme/fnd`) registers under that scope —
 * its name and its schemas' own `@/x` alike. A bare name takes `scope` ('@acme' or
 * 'acme'). With neither, names stay `@/x` (local preview / dry-run). A schemas-only
 * package has no name to carry one, so it always takes `scope`. See `uwx-format.md`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeFoundationSchema } from '@uniweb/schemas/foundation'
import { parseOptionsRef } from '@uniweb/schemas/format'
import { qualifyRef } from '@uniweb/schemas/refs'
import { mappingInFull } from '../foundation/mappings.js'
import { toDataSchemaDeclaration, optionsSectionPath } from './data-schema.js'
import { checkFoundationName, checkRegistrationScope, splitFoundationName } from '../foundation-name.js'

const FOUNDATION_SCHEMA = '@uniweb/foundation-schema'
const DATA_SCHEMA = '@uniweb/data-schema'
const MAPPING_SCHEMA = '@uniweb/mapping-schema'
const VENDOR_SCHEMA = '@uniweb/vendor-schema'

// @uniweb/build's own version, for the exporter envelope when the caller supplies
// none. Safe fallback if package.json isn't reachable (e.g. bundled contexts).
let TOOL_VERSION = '0.0.0'
try {
  TOOL_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
} catch {
  // keep the fallback
}

/**
 * Build the registry-publish document from a built foundation's schema.json.
 *
 * @param {Object} params
 * @param {Object} params.schema - parsed `dist/meta/schema.json`.
 * @param {string} [params.foundationDir] - foundation root, for the `i18n/` bundles.
 * @param {string} [params.scope] - org scope (`@acme` or `acme`) resolving `@/x` -> `@acme/x`,
 *   for a foundation whose name is bare. A scoped name's own scope is used instead, and
 *   a `scope` that contradicts it throws.
 * @param {Object} [params.exporter] - `{ tool, version, instance }` for the envelope.
 * @param {string} [params.exportedAt] - ISO timestamp (default: now).
 * @param {string} [params.runtime] - the `@uniweb/runtime` version this build
 *   linked against (its compatibility floor), from `dist/runtime-pin.json`.
 *   Rides in `info.runtime`; omitted when unknown.
 * @param {string} [params.digest] - the foundation's content digest (`sha256:…`),
 *   computed by the CLI over what register ships (shipping-model.md §4.1). Rides
 *   in the foundation-schema entity's `info.digest`; the backend stores it
 *   OPAQUE and returns it on the foundation-latest read so `publish`/`status`
 *   can detect "code changed since release" with no local state.
 * @param {Object} [params.vendors] - `{ '@/<name>': { exports, sha256, size } }`, the vendor files
 *   the foundation defines, read from disk by the caller (`vendorFileDigest`) when it registers.
 *   `schema._vendors` names them and the library ones; this gives the bytes' digest.
 * @returns {Object} the `.uwx` document (uwx/1; entities, names only, no uuids).
 */
export function buildRegistryPackage({ schema, foundationDir, scope, exporter, exportedAt, digest, runtime, vendors } = {}) {
  const self = schema?._self
  if (!self || !self.name || !self.version) {
    throw new Error('buildRegistryPackage: schema._self with name + version is required')
  }
  const dataSchemas = schema.dataSchemas || {}

  // One @uniweb/data-schema entity per data schema this foundation DEFINES (its
  // own `@/x`), each resolved to the concrete publish scope. Shared refs
  // (`@std/x`, `@other/x`) are named in the foundation's data-schemas.refs but
  // their declarations are not bundled — already published.
  const { entities: dataSchemaEntities, scoped, org } = buildDataSchemaEntities(
    dataSchemas,
    registrationScope(self.name, scope)
  )

  const mappingEntities = buildMappingEntities(schema._mappings || {}, scoped)
  // Its own, and the library mappings its main.js carries (`_mappings` keys in full), which their
  // library registers: a foundation names those, and registers none.
  const mappingRefs = [
    ...new Set([
      ...mappingEntities.map((e) => e.name),
      ...Object.keys(schema._mappings || {}).filter((ref) => !ref.startsWith('@/')),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name }))

  const vendorEntities = buildVendorEntities(vendors || {}, scoped)
  // Its own vendor files, and the library ones its main.js carries (`_vendors` keys in full), which
  // their library registers and uploads: a foundation names those, and registers none.
  const vendorRefs = [
    ...new Set([
      ...vendorEntities.map((e) => e.name),
      ...Object.keys(schema._vendors || {}).filter((ref) => !ref.startsWith('@/')),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name }))

  const foundationEntity = {
    model: FOUNDATION_SCHEMA,
    info: buildInfo(self, org, digest, runtime),
    schema: buildSchemaBlob(schema, org),
    i18n: { locales: loadI18nLocales(foundationDir) },
    'data-schemas': { refs: buildRefs(dataSchemas, scoped) },
    ...(mappingRefs.length && { mappings: { refs: mappingRefs } }),
    ...(vendorRefs.length && { vendors: { refs: vendorRefs } }),
  }

  // Data schemas, then mappings, then vendor files, then the foundation: a backend installs them in
  // the order they arrive, and each names only what came before it or is already registered.
  return wrapEntities([...dataSchemaEntities, ...mappingEntities, ...vendorEntities, foundationEntity], exporter, exportedAt)
}

/**
 * Assemble a foundation-LESS registry-publish `.uwx` — `@uniweb/data-schema` entities,
 * then a library's `@uniweb/mapping-schema` ones, and no foundation-schema. `uniweb
 * register` submits this for a schemas-only package (the standard schemas under `@std`,
 * an org's own `@org/schemas`, a library). A data-schema may be published on its own
 * (`uwx-format.md` §2 "A data-schema may also be published on its own", §5), and a
 * library may hold mappings alone — the wire shape is a names-only `.uwx` with no
 * foundation.
 *
 * @param {Object} params
 * @param {Object} params.schemas - map `{ '@/<name>': normalizedSchema }` of the
 *   schemas the package defines (from `collectStandaloneSchemas`).
 * @param {Object} [params.mappings] - map `{ '@/<name>': declaration }` of the
 *   mappings it defines (`buildMappingMap` over its `mappings/`).
 * @param {Object} [params.vendors] - map `{ '@/<name>': { exports, sha256, size } }` of the
 *   vendor files it defines (its `vendors/`).
 * @param {string} [params.scope] - org scope (`@std`/`std`) resolving `@/x` -> `@std/x`.
 * @param {Object} [params.exporter] - `{ tool, version, instance }` envelope.
 * @param {string} [params.exportedAt] - ISO timestamp (default: now).
 * @returns {Object} the `.uwx` document (uwx/1; no foundation, no uuids).
 */
export function buildSchemaOnlyPackage({ schemas, mappings, vendors, scope, exporter, exportedAt } = {}) {
  // ⛔ The producer's own guard, as `buildInfo`'s name check is for a foundation:
  // `uniweb register` refuses a reserved scope before it gets here.
  const reserved = checkRegistrationScope(scope)
  if (reserved) throw new Error(`buildSchemaOnlyPackage: ${reserved}`)
  const { entities, scoped } = buildDataSchemaEntities(schemas || {}, scope)
  // A library's mappings (its `mappings/`) after its types, as in a foundation's package.
  const mappingEntities = buildMappingEntities(mappings || {}, scoped)
  const vendorEntities = buildVendorEntities(vendors || {}, scoped)
  if (entities.length === 0 && mappingEntities.length === 0 && vendorEntities.length === 0) {
    throw new Error('buildSchemaOnlyPackage: no data schemas, mappings or vendor files to register (expected a map of "@/<name>" -> declaration).')
  }
  return wrapEntities([...entities, ...mappingEntities, ...vendorEntities], exporter, exportedAt)
}

// The scope a foundation registers under: the one in its name, else `scope`.
//
// ⭐ A SCOPED NAME IS THE SCOPE (2026-09-22). `@acme/fnd` registers under `@acme` —
// the foundation and its data schemas both, because a site's records name those
// schemas by the same scope. ⛔ Until then the schemas took `scope` while the name
// kept its own, so one foundation registered `@acme/fnd` beside `@proximify/member`.
// A `scope` that contradicts the name is refused rather than chosen between: which
// org was meant is not ours to guess.
function registrationScope(name, scope) {
  const { scope: nameScope } = splitFoundationName(name)
  const handle = scope ? String(scope).replace(/^@/, '').replace(/\/.*$/, '') : ''
  const given = handle ? `@${handle}` : null
  if (nameScope && given && given !== nameScope) {
    throw new Error(
      `buildRegistryPackage: the foundation is named ${name}, so it registers under ` +
        `${nameScope} — not ${given}. A foundation's scope is the one in its name.`
    )
  }
  return nameScope || scope
}

// Lower a `{ '@/<name>': normalizedSchema }` map into the sorted
// `@uniweb/data-schema` entity list, resolving each own `@/x` to the publish
// scope. Shared by the foundation publish (buildRegistryPackage) and the
// standalone schemas publish (buildSchemaOnlyPackage). Returns the entities plus
// the `scoped`/`org` the foundation path also needs for its info/refs.
function buildDataSchemaEntities(dataSchemas, scope) {
  // `scope` ('@acme' or 'acme') resolves a defined schema's own `@/x` name to a
  // concrete `@acme/x`. With no scope, `@/x` passes through (local preview).
  const org = scope ? String(scope).replace(/^@/, '').replace(/\/.*$/, '') : null
  const scoped = (ref) => qualifyRef(ref, org)

  const resolveOptions = makeOptionsResolver(dataSchemas, scoped)
  const entities = Object.entries(dataSchemas)
    .filter(([ref]) => ref.startsWith('@/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, normalized]) => ({
      model: DATA_SCHEMA,
      // `name` resolved to the concrete scope; entity_ref `models` resolve the same
      // way; item_ref `options` name the section whose items are the choices
      // (`@org/x/<section-path>`, `makeOptionsResolver`).
      ...toDataSchemaDeclaration(normalized, { name: scoped(ref), resolveName: scoped, resolveOptions }),
    }))
  return { entities: referencedFirst(entities), scoped, org }
}

/**
 * One `@uniweb/mapping-schema` entity per mapping the foundation defines (`schema._mappings`,
 * `foundation/mappings.js`): its identity flat, as a data schema's is, and the rest of the file under
 * `rules` — the envelope's `model:` names the exchange type, so the mapping's own `model:` cannot sit
 * beside it. `rules.model`, `rules.keys_from` and a reverse `follow` line's `model` are named in
 * full; nothing else in `rules` is touched, since a backend judges it. A mapping another one names in `keys_from` comes first.
 *
 * @param {Object<string, object>} mappings - `{ '@/<name>': declaration }`
 * @param {(ref: string) => string} scoped - `@/x` → the registration scope's name
 * @returns {object[]}
 */
function buildMappingEntities(mappings, scoped) {
  const entities = Object.entries(mappings)
    .filter(([ref]) => ref.startsWith('@/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, decl]) => {
      const { label, description, ...rules } = mappingInFull(decl, scoped)
      return {
        model: MAPPING_SCHEMA,
        name: scoped(ref),
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
        rules,
      }
    })
  const byName = new Map(entities.map((e) => [e.name, e]))
  const ordered = []
  const state = new Set()
  const visit = (entity) => {
    if (state.has(entity.name)) return // done, or on the walk now — a cycle keeps the walk's order
    state.add(entity.name)
    const from = entity.rules.keys_from
    if (from !== entity.name && byName.has(from)) visit(byName.get(from))
    ordered.push(entity)
  }
  for (const entity of entities) visit(entity)
  return ordered
}

/**
 * One `@uniweb/vendor-schema` entity per vendor file the package defines: its full name, the
 * functions it exports (sorted), and the `sha256` and `size` of its bytes as on disk. No source: the
 * file goes up after the call, addressed by that `sha256` (`vendor-uploads`). No `label` or
 * `description`: a `.js` file has nowhere to declare them.
 *
 * @param {Object<string, { exports: string[], sha256: string, size: number }>} vendors
 * @param {(ref: string) => string} scoped - `@/x` → the registration scope's name
 * @returns {object[]}
 */
function buildVendorEntities(vendors, scoped) {
  return Object.entries(vendors)
    .filter(([ref]) => ref.startsWith('@/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, v]) => ({
      model: VENDOR_SCHEMA,
      name: scoped(ref),
      exports: [...(v.exports || [])].sort(),
      sha256: v.sha256,
      size: v.size,
    }))
}

/**
 * The data schemas in an order a backend can install one at a time: a schema another one in
 * the package references comes BEFORE it — alphabetical otherwise, so the order is stable.
 *
 * ⭐ WHY. A backend installs a package's data schemas in the order they arrive, and refuses a
 * reference to a Model it holds neither yet nor from before: measured 2026-09-25, a foundation
 * whose `exhibit` references its own `specimen` was refused whole — *"entity_ref target
 * `@x/specimen` matches no model declared in this fixture or registered on the host"* — because
 * `exhibit` sorts first. Alphabetical order was right only by luck (`speaker` before `talk`).
 *
 * ⚠️ A CYCLE CANNOT BE ORDERED — `author` names `book` and `book` names `author` — and keeps
 * the order the walk gives it. Whether one package may reference itself in any order is the
 * backend's to accept; this only stops refusing what an order can fix. A schema naming ITSELF
 * is not a dependency.
 *
 * @param {Array<{ name: string, sections?: object }>} entities - lowered declarations
 * @returns {Array} the same entities, referenced ones first
 */
function referencedFirst(entities) {
  const byName = new Map(entities.map((e) => [e.name, e]))
  const targets = (entity) => {
    const out = new Set()
    const walk = (fields) => {
      for (const field of Object.values(fields || {})) {
        if (!field || typeof field !== 'object') continue
        if (field.type === 'entity_ref') for (const m of [field.model].flat()) out.add(m)
        // `options: '@org/x/<section>'` names a section of Model `@org/x`.
        if (field.type === 'item_ref' && typeof field.options === 'string') {
          out.add(field.options.split('/').slice(0, 2).join('/'))
        }
        if (field.type === 'section') walk(field.fields)
      }
    }
    for (const section of Object.values(entity.sections || {})) walk(section.fields)
    return [...out].filter((name) => name !== entity.name && byName.has(name)).sort()
  }
  const ordered = []
  const state = new Map() // name → 'visiting' | 'done'
  const visit = (entity) => {
    if (state.get(entity.name)) return // done, or on the walk now — a cycle
    state.set(entity.name, 'visiting')
    for (const name of targets(entity)) visit(byName.get(name))
    state.set(entity.name, 'done')
    ordered.push(entity)
  }
  for (const entity of entities) visit(entity)
  return ordered
}

// The shared `.uwx` envelope (uwx/1 + exporter + timestamp) around an entity list.
function wrapEntities(entities, exporter, exportedAt) {
  return {
    uwx: 1,
    exporter: exporter || { tool: 'uniweb', version: TOOL_VERSION, instance: 'build' },
    exported_at: exportedAt || new Date().toISOString(),
    entities,
  }
}

// --- foundation-schema content (names only) ----------------------------------

// Identity card — decomposed so it's readable without opening the blob. The
// optional `digest` (sha256:…) is the foundation's content fingerprint; the
// backend stores it opaque and returns it on the foundation-latest read.
function buildInfo(self, org, digest, runtime) {
  // Scope a bare foundation name (`marketing` -> `@acme/marketing`); leave an
  // already-scoped name.
  const name = org && !String(self.name).startsWith('@') ? `@${org}/${self.name}` : self.name
  // ⛔ The producer's own guard. `uniweb register` asks for a name before it gets
  // here; this refuses for any other caller, so nothing registers as `@org/src`
  // (`foundation-name.js`).
  const problem = checkFoundationName(name)
  if (problem) throw new Error(`buildRegistryPackage: ${problem}`)
  const info = { name, version: self.version, role: self.role || 'foundation' }
  if (self.description !== undefined) info.description = self.description
  if (digest) info.digest = digest
  // The compatibility FLOOR this build links against (dist/runtime-pin.json).
  // Omitted when unknown — and a consumer must read the omission as UNKNOWN
  // rather than unconstrained, since a floor nobody stated cannot be shown to
  // be satisfied. Same lift as `digest`: stated by the producer, opaque to the
  // backend, acted on by whoever resolves a whole site.
  if (runtime) info.runtime = runtime
  // The host services this foundation is BUILT AGAINST, from package.json's
  // `uniweb.supports`. `Array.isArray` and not truthiness: `[]` is an explicit
  // "none" and must survive as one, while an ABSENT key means UNKNOWN — the
  // same three-state rule `runtime` states above, for the same reason.
  if (Array.isArray(self.supports)) info.supports = self.supports
  return info
}

// The foundation schema an editor reads: the whole renderable schema.json MINUS identity
// and MINUS dataSchemas, _mappings and _vendors (each registered as its own entity, or named by ref), shipped as one object the backend stores and serves, and never
// reads into (custodian).
//
// ⭐ IN ITS NORMALIZED FORM — `schemaFormat: 3` (`@uniweb/schemas/foundation`, ruled
// 2026-10-01 [Diego]): every entry in one spelling per meaning, so the editor needs no
// framework grammar, and each `@/x` a `data:` key names qualified with the scope the
// foundation registers under — the name its Model was stored under. ⛔ Until 2026-10-01 the
// build's format 2 shipped as built, and `data: { team: '@/member' }` reached the editor
// as written. `dist/meta/schema.json` stays format 2: the build's own readers read it.
//
// It throws for a `data:` value that cannot be normalized — an inline field map that is
// not a valid data schema — naming the component and the key; the build warns of it first.
function buildSchemaBlob(schema, org) {
  const { dataSchemas: _ds, _mappings: _m, _vendors: _v2, ...rest } = schema
  // Every key hoisted into `info` is stripped here, so the wire carries each
  // fact ONCE. Two copies of one fact is a drift liability, and the copy inside
  // an opaque blob is the one nobody would think to update.
  const { name: _n, version: _v, description: _d, role: _r, supports: _s, ...selfConfig } =
    rest._self || {}
  return normalizeFoundationSchema({ ...rest, _self: selfConfig }, { scope: org || undefined })
}

// The data-schemas the foundation renders, by NAME (own + shared), sorted.
function buildRefs(dataSchemas, scoped) {
  return Object.keys(dataSchemas).sort().map((ref) => ({ name: scoped(ref) }))
}

// An item_ref's `options` as a registry takes it: `@scope/name/<section-path>`. A registry
// refuses a path that names no section, and picks none for us (2026-10-15). The section is
// the one the author named, or — for `'@/x'` alone — the options Model's one list
// (`optionsSectionPath`, which refuses a Model with several).
// ⛔ Until 2026-10-15 this took the Model's FIRST single-or-multi section, and this comment said
// the registry "splits on the last `/`" — it does not, and a two-segment path is refused.
function makeOptionsResolver(dataSchemas, scoped) {
  return (options) => {
    const { model, path } = parseOptionsRef(options)
    const target = dataSchemas[model]
    if (target) return `${scoped(model)}/${optionsSectionPath(options, target)}`
    if (path) return `${scoped(model)}/${path}`
    throw new Error(
      `takes its choices from '${options}', a Model this package does not define — name the section ` +
        `that holds them: '${options}/<section>'.`
    )
  }
}

// Per-locale sidecar map from `<foundationDir>/i18n/<locale>.json`. `{}` when none.
function loadI18nLocales(foundationDir) {
  if (!foundationDir) return {}
  const dir = join(foundationDir, 'i18n')
  if (!existsSync(dir)) return {}
  const locales = {}
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue
    locales[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  }
  return locales
}
