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
 *     - model: "@uniweb/foundation-schema"   # the foundation (info/schema/i18n/data-schemas)
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

import { toDataSchemaDeclaration } from './data-schema.js'
import { checkFoundationName, splitFoundationName } from '../foundation-name.js'

const FOUNDATION_SCHEMA = '@uniweb/foundation-schema'
const DATA_SCHEMA = '@uniweb/data-schema'

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
 * @returns {Object} the `.uwx` document (uwx/1; entities, names only, no uuids).
 */
export function buildRegistryPackage({ schema, foundationDir, scope, exporter, exportedAt, digest, runtime } = {}) {
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

  const foundationEntity = {
    model: FOUNDATION_SCHEMA,
    info: buildInfo(self, org, digest, runtime),
    schema: buildSchemaBlob(schema),
    i18n: { locales: loadI18nLocales(foundationDir) },
    'data-schemas': { refs: buildRefs(dataSchemas, scoped) },
  }

  // Data schemas first so the foundation's refs always resolve (§5 step 5).
  return wrapEntities([...dataSchemaEntities, foundationEntity], exporter, exportedAt)
}

/**
 * Assemble a foundation-LESS registry-publish `.uwx` — only `@uniweb/data-schema`
 * entities, no foundation-schema. `uniweb register` submits this for a
 * schemas-only package (the standard schemas under `@std`, or an org's own
 * `@org/schemas`). A data-schema may be published on its own (`uwx-format.md` §2
 * "A data-schema may also be published on its own", §5) — the wire shape is a
 * names-only `.uwx` whose entities are all data-schemas.
 *
 * @param {Object} params
 * @param {Object} params.schemas - map `{ '@/<name>': normalizedSchema }` of the
 *   schemas the package defines (from `collectStandaloneSchemas`).
 * @param {string} [params.scope] - org scope (`@std`/`std`) resolving `@/x` -> `@std/x`.
 * @param {Object} [params.exporter] - `{ tool, version, instance }` envelope.
 * @param {string} [params.exportedAt] - ISO timestamp (default: now).
 * @returns {Object} the `.uwx` document (uwx/1; only data-schema entities, no uuids).
 */
export function buildSchemaOnlyPackage({ schemas, scope, exporter, exportedAt } = {}) {
  const { entities } = buildDataSchemaEntities(schemas || {}, scope)
  if (entities.length === 0) {
    throw new Error('buildSchemaOnlyPackage: no data schemas to register (expected a map of "@/<name>" -> schema).')
  }
  return wrapEntities(entities, exporter, exportedAt)
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
  const scoped = (ref) =>
    org && typeof ref === 'string' && ref.startsWith('@/') ? `@${org}/${ref.slice(2)}` : ref

  const resolveOptions = makeOptionsResolver(dataSchemas, scoped)
  const entities = Object.entries(dataSchemas)
    .filter(([ref]) => ref.startsWith('@/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, normalized]) => ({
      model: DATA_SCHEMA,
      // `name` resolved to the concrete scope; entity_ref `models` resolve the same
      // way; item_ref `options` get the full `@org/x/<section>` path (§10.1).
      ...toDataSchemaDeclaration(normalized, { name: scoped(ref), resolveName: scoped, resolveOptions }),
    }))
  return { entities, scoped, org }
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

// The whole renderable schema.json MINUS identity and MINUS dataSchemas, shipped
// as one opaque object the backend never reads into (custodian).
function buildSchemaBlob(schema) {
  const { dataSchemas: _ds, ...rest } = schema
  // Every key hoisted into `info` is stripped here, so the wire carries each
  // fact ONCE. Two copies of one fact is a drift liability, and the copy inside
  // an opaque blob is the one nobody would think to update.
  const { name: _n, version: _v, description: _d, role: _r, supports: _s, ...selfConfig } =
    rest._self || {}
  return { ...rest, _self: selfConfig }
}

// The data-schemas the foundation renders, by NAME (own + shared), sorted.
function buildRefs(dataSchemas, scoped) {
  return Object.keys(dataSchemas).sort().map((ref) => ({ name: scoped(ref) }))
}

// Resolve an item_ref `options: '@/x'` to the full `@/x/<section>` path the
// backend needs (it splits on the last `/`; a bare model mis-resolves — §10.1).
// The section is the options model's single item-bearing (single/multi) section.
function makeOptionsResolver(dataSchemas, scoped) {
  return (ref) => {
    const model = dataSchemas[ref]
    if (!model) return scoped(ref)
    const section = itemBearingSectionName(model, ref)
    return section ? `${scoped(ref)}/${section}` : scoped(ref)
  }
}

function itemBearingSectionName(normalized, ref) {
  // fields-form → the synthesized single section (named by the ref's short segment)
  if (normalized.fields) return String(ref).split('/').pop()
  // sections-form → the first item-bearing (single/multi) section
  for (const [name, sec] of Object.entries(normalized.sections || {})) {
    const kind = sec.kind || 'single'
    if (kind === 'single' || kind === 'multi') return name
  }
  return null
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
