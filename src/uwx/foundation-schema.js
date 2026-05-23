// Map a built foundation's `dist/meta/schema.json` to one
// `@uniweb/foundation-schema` entity, then to a `subtype: entity` .uwx.
//
// Matches the @uniweb/foundation-schema system Model in uniweb-rs
// (apps/uniweb-rs/uniwebd/system-models/foundation-schema.fixture.yaml): each
// coarse Section ships a slice of schema.json WHOLE, by location. The backend
// never queries into these blobs (only the editor reads inside them), so we
// don't decompose, transform, snake_case, localize, or drop keys — we slice
// and ship. (Build-plumbing keys like `_layouts[].entryFile` ride along in the
// blob; strip later if that's ever unwanted.)
//
//   info        single, brief — identity: name, version, role, description.
//   config      single — `_self` minus identity + outputs, as one `schema` blob.
//   components  single — the non-underscore top-level keys (the section-type
//               component map), as one `schema` blob.
//   layouts     single — `_layouts`, as one `schema` blob.
//   outputs     single — `_self.outputs`, as one `schema` blob.
//
// The Model also declares `i18n` and `models` Sections; they're NOT populated
// here. i18n's source is the foundation's separate `i18n/` bundles, and
// `models` comes from `_self.models` (which the build doesn't emit yet). Both
// ride later.
//
// schema.json shape (see src/schema.js `buildSchema`):
//   _self    : the main.js/foundation.js default export (open) plus
//              package.json identity ({name,version,description}).
//              `_self.outputs` is `{ fmt: { extension?, via? } }`.
//   _layouts : { name: { name, path, ...meta, entryFile? } }
//   <Pascal> : section-type components { name, path, ...meta, title }
//
// A foundation version is immutable, so the entity is keyed by `name@version`:
// a sidecar-backed re-publish of the same version reuses the uuid (idempotent
// re-import); the library default is mint (submit-once).

import { FOUNDATION_MODEL_UUID } from './models.js'
import { emitEntityPackage } from './package.js'
import { mintResolver, sidecarResolver } from './identity.js'

/**
 * @param {object} schema  - parsed dist/meta/schema.json
 * @param {object} [opts]
 * @param {object} [opts.idResolver]  - identity resolver (default: mint).
 * @param {string} [opts.entityUuid]  - explicitly pin the entity uuid
 *                                      (overrides the resolver).
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

  // info (brief) — identity only. role is absent for primary foundations
  // (set only for extensions) → default "foundation".
  const info = {
    name: self.name,
    version: self.version,
    role: self.role || 'foundation',
  }
  if (self.description !== undefined) info.description = self.description

  // config — everything else on `_self` (defaultLayout, defaultSection, vars,
  // props, handlers, viewTransitions, defaultInsets, xref, …) minus identity
  // and outputs, which have their own Sections. Shipped whole.
  const config = { ...self }
  delete config.name
  delete config.version
  delete config.description
  delete config.role
  delete config.outputs

  // components — the non-underscore top-level keys: the section-type map, as
  // the foundation authored it (labels stay single-language; translations ride
  // in the i18n Section later).
  const components = {}
  for (const [key, entry] of Object.entries(schema)) {
    if (!key.startsWith('_')) components[key] = entry
  }

  const items = [
    single('info', info),
    single('config', { schema: config }),
    single('components', { schema: components }),
    single('layouts', { schema: schema._layouts || {} }),
    single('outputs', { schema: self.outputs || {} }),
  ]

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
 * schema.json -> a one-entity `@uniweb/foundation-schema` .uwx Buffer.
 *
 * @param {object} schema
 * @param {object} [opts] - entityUuid?, exporter?, exportedAt?, idResolver?,
 *        or sidecar (a string path).
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
      { uuid: FOUNDATION_MODEL_UUID, name_at_export: '@uniweb/foundation-schema' },
    ],
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })
}
