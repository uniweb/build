// emitEntityPackage — the single `subtype: entity` .uwx producer that the
// foundation and site mappers both call. No mapping here; it serializes
// already-shaped entities.

import { createZip } from './zip.js'
import {
  sha256Hex,
  toJsonBuffer,
  serializeEntityFile,
  buildManifest,
  computePackageSha256,
} from './manifest.js'

// `exporter.instance`: caller-override -> env UNIWEB_INSTANCE_ID ->
// "unknown". Provenance only; never used as identity.
function defaultExporter() {
  return {
    tool: 'uniweb',
    version: 'dev',
    instance: process.env.UNIWEB_INSTANCE_ID || 'unknown',
  }
}

/**
 * Build a `subtype: entity` .uwx package.
 *
 * @param {object}   opts
 * @param {object[]} opts.entities          - { uuid, (model_uuid | model),
 *                                             owner_uuid?, unit_uuid?, meta?,
 *                                             items[] } each. `model_uuid` for a
 *                                             uuid'd Model; `model` (a registry
 *                                             name) when there is no uuid.
 * @param {object[]} opts.modelsRequired    - { uuid?, name_at_export,
 *                                             policy_hint? }; the Model(s) the
 *                                             importer must resolve — by `uuid`,
 *                                             or by `name_at_export` when uuid is
 *                                             absent.
 * @param {string[]} [opts.roots]           - explicitly-exported entity uuids;
 *                                             defaults to every entity's uuid.
 * @param {object[]} [opts.referencedMembers]
 * @param {object[]} [opts.referencedUnits]
 * @param {object[]} [opts.edges]           - flat {from,to,role} list; empty
 *                                             is valid.
 * @param {object[]} [opts.blobs]           - {sha256,size,mime,name}; bytes
 *                                             travel out of band.
 * @param {object}   [opts.exporter]        - provenance; neutralized in the
 *                                             digest, so its value is inert.
 * @param {string}   [opts.exportedAt]      - ISO-8601; also digest-neutralized.
 * @returns {Buffer} the .uwx ZIP bytes
 */
export function emitEntityPackage({
  entities,
  modelsRequired,
  roots,
  referencedMembers = [],
  referencedUnits = [],
  edges = [],
  blobs = [],
  exporter = defaultExporter(),
  exportedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error('uwx: emitEntityPackage requires at least one entity')
  }
  if (!Array.isArray(modelsRequired) || modelsRequired.length === 0) {
    throw new Error('uwx: emitEntityPackage requires modelsRequired')
  }
  for (const e of entities) {
    if (e.model_uuid == null && !e.model) {
      throw new Error(
        `uwx: entity ${e.uuid} needs a model_uuid or a model (name)`
      )
    }
  }

  const files = []
  const entries = []

  for (const entity of entities) {
    const data = serializeEntityFile(entity)
    const file = `entities/${entity.uuid}.json`
    files.push({ name: file, data })
    const entry = { kind: 'entity', uuid: entity.uuid }
    // Mirror the per-entity type pointer (by-uuid vs by-name); see
    // serializeEntityFile. A by-uuid entry keeps its exact prior shape.
    if (entity.model_uuid != null) entry.model_uuid = entity.model_uuid
    else entry.model = entity.model
    entry.owner_uuid = entity.owner_uuid ?? null
    entry.unit_uuid = entity.unit_uuid ?? null
    // Derived columns the importer recomputes — preview only.
    entry.brief = entity.brief ?? null
    entry.sort_date = entity.sort_date ?? null
    entry.updated_at = entity.updated_at ?? null
    entry.file = file
    entry.sha256 = sha256Hex(data)
    entries.push(entry)
  }

  const manifest = buildManifest({
    subtype: 'entity',
    exporter,
    exportedAt,
    modelsRequired: modelsRequired.map((m) => ({
      // uuid is OPTIONAL — null when the importer must resolve the Model by
      // `name_at_export` (used when the exporter has no uuid for the Model).
      uuid: m.uuid ?? null,
      name_at_export: m.name_at_export ?? null,
      policy_hint: m.policy_hint ?? 'validate_existing',
    })),
    referencedMembers,
    referencedUnits,
    roots: roots ?? entities.map((e) => e.uuid),
    entries,
    edges,
    blobs,
  })

  manifest.package_sha256 = computePackageSha256(manifest)

  return createZip([
    { name: 'manifest.json', data: toJsonBuffer(manifest) },
    ...files,
  ])
}
