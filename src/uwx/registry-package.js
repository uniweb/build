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
 * Namespace-relative on the wire: a schema's own ref `@/x` and the foundation's
 * `data-schemas.refs` stay `@/x`; the backend resolves `@org` from the acting
 * org at submit time (the CLI never needs the org to *generate*, only to submit).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { toDataSchemaDeclaration } from './data-schema.js'

const FOUNDATION_SCHEMA = '@uniweb/foundation-schema'
const DATA_SCHEMA = '@uniweb/data-schema'

/**
 * Build the registry-publish document from a built foundation's schema.json.
 *
 * @param {Object} params
 * @param {Object} params.schema - parsed `dist/meta/schema.json`.
 * @param {string} [params.foundationDir] - foundation root, for the `i18n/` bundles.
 * @param {Object} [params.exporter] - `{ tool, version, instance }` for the envelope.
 * @param {string} [params.exportedAt] - ISO timestamp (default: now).
 * @returns {Object} the `.uwx` document (uwx/1; entities, names only, no uuids).
 */
export function buildRegistryPackage({ schema, foundationDir, exporter, exportedAt } = {}) {
  const self = schema?._self
  if (!self || !self.name || !self.version) {
    throw new Error('buildRegistryPackage: schema._self with name + version is required')
  }
  const dataSchemas = schema.dataSchemas || {}

  // One @uniweb/data-schema entity per data schema this foundation DEFINES (its
  // own `@/x`). Shared refs (`@std/x`, `@other/x`) are named in the foundation's
  // data-schemas.refs but their declarations are not bundled — already published.
  const dataSchemaEntities = Object.entries(dataSchemas)
    .filter(([ref]) => ref.startsWith('@/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, normalized]) => ({
      model: DATA_SCHEMA,
      // Namespace-relative name; the backend resolves @org. Refs pass through
      // unchanged for the same reason.
      ...toDataSchemaDeclaration(normalized, { name: ref, resolveName: (r) => r }),
    }))

  const foundationEntity = {
    model: FOUNDATION_SCHEMA,
    info: buildInfo(self),
    schema: buildSchemaBlob(schema),
    i18n: { locales: loadI18nLocales(foundationDir) },
    'data-schemas': { refs: buildRefs(dataSchemas) },
  }

  return {
    uwx: 1,
    exporter: exporter || { tool: 'uniweb', instance: 'build' },
    exported_at: exportedAt || new Date().toISOString(),
    // Data schemas first so the foundation's refs always resolve (§5 step 5).
    entities: [...dataSchemaEntities, foundationEntity],
  }
}

// --- foundation-schema content (names only) ----------------------------------

// Identity card — decomposed so it's readable without opening the blob.
function buildInfo(self) {
  const info = { name: self.name, version: self.version, role: self.role || 'foundation' }
  if (self.description !== undefined) info.description = self.description
  return info
}

// The whole renderable schema.json MINUS identity and MINUS dataSchemas, shipped
// as one opaque object the backend never reads into (custodian).
function buildSchemaBlob(schema) {
  const { dataSchemas: _ds, ...rest } = schema
  const { name: _n, version: _v, description: _d, role: _r, ...selfConfig } = rest._self || {}
  return { ...rest, _self: selfConfig }
}

// The data-schemas the foundation renders, by NAME (own + shared), sorted.
function buildRefs(dataSchemas) {
  return Object.keys(dataSchemas).sort().map((ref) => ({ name: ref }))
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
