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
 * @param {object[]} opts.entities          - { uuid, model_uuid, owner_uuid?,
 *                                             unit_uuid?, meta?, items[] } each.
 * @param {object[]} opts.modelsRequired    - { uuid, name_at_export,
 *                                             policy_hint? }; the system Model
 *                                             uuid(s) the importer must have.
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

  const files = []
  const entries = []

  for (const entity of entities) {
    const data = serializeEntityFile(entity)
    const file = `entities/${entity.uuid}.json`
    files.push({ name: file, data })
    entries.push({
      kind: 'entity',
      uuid: entity.uuid,
      model_uuid: entity.model_uuid,
      owner_uuid: entity.owner_uuid ?? null,
      unit_uuid: entity.unit_uuid ?? null,
      // Derived columns the importer recomputes — preview only.
      brief: entity.brief ?? null,
      sort_date: entity.sort_date ?? null,
      updated_at: entity.updated_at ?? null,
      file,
      sha256: sha256Hex(data),
    })
  }

  const manifest = buildManifest({
    subtype: 'entity',
    exporter,
    exportedAt,
    modelsRequired: modelsRequired.map((m) => ({
      uuid: m.uuid,
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
