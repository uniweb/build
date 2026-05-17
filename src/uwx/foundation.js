// Map a built foundation's `dist/meta/schema.json` to one
// `@uniweb/foundation` entity, then to a `subtype: entity` .uwx.
//
// schema.json shape (see src/schema.js `buildSchema`): a flat object —
//   _self      : the main.js/foundation.js default export (open) plus
//                package.json identity ({name,version,description}).
//                `_self.outputs` is `{ fmt: { extension?, via? } }` after
//                JSON serialization strips the getOptions functions.
//   _layouts   : { name: { name, path, ...meta, entryFile? } }
//   <Pascal>   : section-type components { name, path, ...meta, title }
//
// Mapped to the @uniweb/foundation Model's four Sections (info,
// section_types, layouts, outputs).
//
// The Model is a closed, enumerated contract; `_self`/`…meta` are open
// bags. We map ONLY the enumerated fields and intentionally drop the rest —
// a catch-all json field would defeat the point of a typed contract.
// `entryFile` is build plumbing — dropped. `role` is absent for primary
// foundations (set only for extensions) — defaulted to "foundation".
//
// A foundation version is immutable, so the entity is keyed by
// `name@version`: a sidecar-backed re-publish of the same version reuses the
// uuid (idempotent re-import); the library default is mint (submit-once).

import { FOUNDATION_MODEL_UUID } from './models.js'
import { emitEntityPackage } from './package.js'
import { localize, LOCALIZED_FIELD_ASSUMPTION } from './localize.js'
import { mintResolver, sidecarResolver } from './identity.js'

// Copy only the enumerated (target <- source) pairs that are defined;
// everything else in `source` is intentionally dropped. `localizeKeys` get
// the localized wrapping.
function mapFields(source, pairs, { localizeKeys = [], sourceLocale } = {}) {
  const out = {}
  for (const [target, from] of pairs) {
    const v = source?.[from]
    if (v === undefined) continue
    out[target] = localizeKeys.includes(target) ? localize(v, sourceLocale) : v
  }
  return out
}

const INFO_PAIRS = [
  ['name', 'name'],
  ['version', 'version'],
  ['description', 'description'],
  ['default_layout', 'defaultLayout'],
  ['default_section', 'defaultSection'],
  ['vars', 'vars'],
  ['props', 'props'],
  ['handlers', 'handlers'],
  ['view_transitions', 'viewTransitions'],
  ['default_insets', 'defaultInsets'],
  ['xref', 'xref'],
]

const SECTION_TYPE_PAIRS = [
  ['name', 'name'],
  ['title', 'title'],
  ['description', 'description'],
  ['category', 'category'],
  ['path', 'path'],
  ['params', 'params'],
  ['context', 'context'],
  ['initial_state', 'initialState'],
  ['schemas', 'schemas'],
  ['inherit_data', 'inheritData'],
  ['preset', 'preset'],
  ['inset', 'inset'],
  ['background', 'background'],
  ['hidden', 'hidden'],
]

const LAYOUT_PAIRS = [
  ['name', 'name'],
  ['title', 'title'],
  ['description', 'description'],
  ['path', 'path'],
  ['areas', 'areas'],
  ['scroll', 'scroll'],
  ['params', 'params'],
]

/**
 * @param {object} schema  - parsed dist/meta/schema.json
 * @param {object} [opts]
 * @param {object} [opts.idResolver]  - identity resolver (default: mint).
 * @param {string} [opts.entityUuid]  - explicitly pin the entity uuid
 *                                      (overrides the resolver).
 * @param {string} [opts.sourceLocale]- localized-wrap locale (default "en").
 * @returns {object} entity ready for emitEntityPackage
 */
export function foundationSchemaToEntity(schema, opts = {}) {
  const id = opts.idResolver || mintResolver()
  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale
  const self = schema?._self
  if (!self || !self.name || !self.version) {
    throw new Error(
      'uwx/foundation: schema._self with name + version is required'
    )
  }
  const entityKey = `${self.name}@${self.version}`

  const items = []

  // ---- info (single, brief) ------------------------------------------------
  const infoData = mapFields(self, INFO_PAIRS)
  // role: absent for primary foundations (set only for extensions) —
  // default "foundation".
  infoData.role = self.role || 'foundation'
  items.push({
    uuid: id.item(`${entityKey}::info`),
    section: 'info',
    parent_section: null,
    parent_path: null,
    data: infoData,
    order_number: null,
  })

  // ---- section_types (multi) — top-level non-underscore keys --------------
  let n = 0
  for (const [key, entry] of Object.entries(schema)) {
    if (key.startsWith('_')) continue
    const data = mapFields(entry, SECTION_TYPE_PAIRS, {
      localizeKeys: ['title', 'description'],
      sourceLocale,
    })
    if (data.name === undefined) data.name = key
    items.push({
      uuid: id.item(`${entityKey}::st:${data.name}`),
      section: 'section_types',
      parent_section: null,
      parent_path: null,
      data,
      order_number: n++,
    })
  }

  // ---- layouts (multi) ----------------------------------------------------
  let l = 0
  for (const [key, entry] of Object.entries(schema._layouts || {})) {
    const data = mapFields(entry, LAYOUT_PAIRS, {
      localizeKeys: ['title', 'description'],
      sourceLocale,
    })
    if (data.name === undefined) data.name = key
    items.push({
      uuid: id.item(`${entityKey}::lay:${data.name}`),
      section: 'layouts',
      parent_section: null,
      parent_path: null,
      data,
      order_number: l++,
    })
  }

  // ---- outputs (multi) — _self.outputs { fmt: { extension?, via? } } ------
  let o = 0
  for (const [format, decl] of Object.entries(self.outputs || {})) {
    const data = { format }
    if (decl?.extension !== undefined) data.extension = decl.extension
    if (decl?.via !== undefined) data.via = decl.via
    items.push({
      uuid: id.item(`${entityKey}::out:${format}`),
      section: 'outputs',
      parent_section: null,
      parent_path: null,
      data,
      order_number: o++,
    })
  }

  return {
    // A foundation entity is owner-less (a frozen published artifact, not
    // user content).
    uuid: opts.entityUuid || id.entity(entityKey),
    model_uuid: FOUNDATION_MODEL_UUID,
    owner_uuid: null,
    unit_uuid: null,
    meta: {},
    items,
  }
}

/**
 * schema.json -> a one-entity `@uniweb/foundation` .uwx Buffer.
 *
 * @param {object} schema
 * @param {object} [opts] - entityUuid?, sourceLocale?, exporter?, exportedAt?,
 *        idResolver?, or sidecar (a string path).
 * @returns {Buffer}
 */
export function emitFoundationPackage(schema, opts = {}) {
  let id = opts.idResolver
  if (!id && typeof opts.sidecar === 'string') id = sidecarResolver(opts.sidecar)
  if (!id) id = mintResolver()

  const entity = foundationSchemaToEntity(schema, { ...opts, idResolver: id })
  id.flush()

  return emitEntityPackage({
    entities: [entity],
    modelsRequired: [
      { uuid: FOUNDATION_MODEL_UUID, name_at_export: '@uniweb/foundation' },
    ],
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })
}
