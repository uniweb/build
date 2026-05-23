// Map a built foundation's `dist/meta/schema.json` to one
// `@uniweb/foundation-schema` entity, then to a `subtype: entity` .uwx.
//
// SOURCE OF TRUTH for the entity shape is the server fixture
// `apps/uniweb-rs/uniwebd/system-models/foundation-schema.fixture.yaml` — NOT
// this comment. The foundation-schema entity type has FOUR Sections
// (registry-redesign.md §5: "decompose only the axis the backend traverses;
// keep coarse what is shipped whole"):
//
//   info    single, brief — identity ONLY: name, version, role, description.
//                           Field-decomposed (the backend sorts/pins by
//                           name/version). This IS the entity_ref card.
//   schema  single — ONE opaque `schema` json field: the whole renderable
//                    schema.json MINUS identity and MINUS dataSchemas
//                    (components, layouts, outputs, plus foundation-wide config
//                    — vars, props, handlers, defaultLayout, …). Shipped WHOLE
//                    to the frontend editor; the server never queries into it,
//                    so the build owns its internal shape. (This collapses the
//                    former config/components/layouts/outputs Sections.)
//   i18n    single — ONE localized `locales` json field: the per-locale sidecar
//                    map `{ en: <sidecar>, … }` assembled from the foundation's
//                    `i18n/{locale}.json` bundles. `{}` when none.
//   models  single — ONE `refs` json field: the deduped data-schema references
//                    `[{ model_uuid, name, version }]`. The ONLY axis the
//                    server traverses (to light its offer edge). Built from
//                    schema.json's `dataSchemas` map; each ref's stable
//                    schema-identity uuid comes from the id resolver's
//                    `schema()` bag (sidecar — reused across foundation
//                    versions). `name` is the ref verbatim
//                    (`@/article` / `@uniweb/person`); org resolution to
//                    `@org/article` is a downstream (register/backend) concern.
//                    `version` is the schema's declared version, informational
//                    (the backend resolves by uuid, latest-wins).
//
// See kb/framework/plans/uniweb-register-contract.md for the full contract.
//
// schema.json shape (see src/schema.js `buildSchema`):
//   _self        : foundation.js/package.json config + identity
//                  ({ name, version, description, role? }).
//   dataSchemas? : { '<ref>': { name, version, description?, fields } }
//   _layouts?    : { name: { name, path, ...meta, entryFile? } }
//   <Pascal>     : section-type components { name, path, ...meta, title }
//
// A foundation version is immutable, so the entity is keyed by `name@version`:
// a sidecar-backed re-publish of the same version reuses the uuid (idempotent
// re-import); the library default is mint (submit-once).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { FOUNDATION_SCHEMA_TYPE_UUID } from './entity-types.js'
import { emitEntityPackage } from './package.js'
import { mintResolver, sidecarResolver } from './identity.js'

/**
 * @param {object} schema  - parsed dist/meta/schema.json
 * @param {object} [opts]
 * @param {object} [opts.idResolver]    - identity resolver (default: mint).
 * @param {string} [opts.entityUuid]    - explicitly pin the entity uuid
 *                                        (overrides the resolver).
 * @param {string} [opts.foundationDir] - foundation root, for reading the
 *                                        `i18n/` bundles. Omit → empty locales.
 * @returns {object} entity ready for emitEntityPackage
 */
export function foundationSchemaToEntity(schema, opts = {}) {
  const id = opts.idResolver || mintResolver()
  const self = schema?._self
  if (!self || !self.name || !self.version) {
    throw new Error(
      'uwx/foundation: schema._self with name + version is required'
    )
  }
  const entityKey = `${self.name}@${self.version}`

  // A single-Item Section carrying `data`, keyed stably by section name so a
  // re-export of the same foundation version reuses the item uuid.
  const single = (section, data) => ({
    uuid: id.item(`${entityKey}::${section}`),
    section,
    parent_section: null,
    parent_path: null,
    data,
    order_number: null,
  })

  // ── info — identity only (brief). role defaults to "foundation" (set only
  // for extensions). ────────────────────────────────────────────────────────
  const info = {
    name: self.name,
    version: self.version,
    role: self.role || 'foundation',
  }
  if (self.description !== undefined) info.description = self.description

  // ── schema — the whole renderable schema.json minus identity and minus
  // dataSchemas, shipped WHOLE as one opaque blob. ───────────────────────────
  const { dataSchemas, ...rest } = schema
  const {
    name: _n,
    version: _v,
    description: _d,
    role: _r,
    ...selfConfig
  } = rest._self || {}
  const schemaBlob = { ...rest, _self: selfConfig }

  // ── models — the deduped data-schema references (sorted for stable output).
  // (`models` is the server's Section name; `model_uuid` is the wire field —
  // both fixed by the foundation-schema entity format. Our side speaks schema:
  // the stable id comes from `id.schema(ref)`.)
  const refs = Object.entries(dataSchemas || {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, def]) => ({
      model_uuid: id.schema(ref),
      name: ref,
      version: def?.version,
    }))

  const items = [
    single('info', info),
    single('schema', { schema: schemaBlob }),
    single('i18n', { locales: loadI18nLocales(opts.foundationDir) }),
    single('models', { refs }),
  ]

  return {
    // A foundation entity is owner-less (a frozen published artifact, not
    // user content).
    uuid: opts.entityUuid || id.entity(entityKey),
    model_uuid: FOUNDATION_SCHEMA_TYPE_UUID,
    owner_uuid: null,
    unit_uuid: null,
    meta: {},
    items,
  }
}

/**
 * schema.json -> a one-entity `@uniweb/foundation-schema` .uwx Buffer.
 *
 * @param {object} schema
 * @param {object} [opts] - entityUuid?, foundationDir?, exporter?, exportedAt?,
 *        idResolver?, or sidecar (a string path).
 * @returns {Buffer}
 */
export function emitFoundationSchemaPackage(schema, opts = {}) {
  let id = opts.idResolver
  if (!id && typeof opts.sidecar === 'string') id = sidecarResolver(opts.sidecar)
  if (!id) id = mintResolver()

  const entity = foundationSchemaToEntity(schema, { ...opts, idResolver: id })
  id.flush()

  return emitEntityPackage({
    entities: [entity],
    modelsRequired: [
      { uuid: FOUNDATION_SCHEMA_TYPE_UUID, name_at_export: '@uniweb/foundation-schema' },
    ],
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })
}

// Assemble the per-locale sidecar map from `<foundationDir>/i18n/<locale>.json`.
// Each file's basename is the locale; its parsed JSON is that locale's whole
// sidecar. Returns `{}` when there is no foundationDir or no i18n/ directory.
function loadI18nLocales(foundationDir) {
  if (!foundationDir) return {}
  const dir = join(foundationDir, 'i18n')
  if (!existsSync(dir)) return {}
  const locales = {}
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue
    const locale = file.slice(0, -'.json'.length)
    locales[locale] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  }
  return locales
}
