// emitEntitySyncPackage — the `.uwx` producer for the entity-content SYNC lane.
//
// Distinct from package.js's emitEntityPackage (the register / site-content lane,
// whose per-entity body is the legacy `items[]` shape). The sync lane's per-entity
// body is the section-keyed `$`-document (see docs/reference/entity-content.md):
// `$uuid?` then `$id` `$model`, then one key per top-level section.
//
// Identity rides in the BODY — the backend reads `$id` always, `$uuid` when
// present, and MINTS `$uuid` on first sync. The manifest is the INDEX, not a copy
// of identity: `entries[].file` locates the body, `sha256` is integrity, `model`
// resolves the Model by name (resolve-never-mint). Properties of the sync wire:
//   - first-sync entities carry no `$uuid`, so the file name is opaque (the
//     reader uses `entries[].file`, never the filename);
//   - `entries[].uuid` is only a fallback handle label when the body omits `$id`
//     — never the identity key, never uuid-parsed — so we set it to `$id`;
//   - `roots` is parsed as a uuid set consulted only for the writable-vs-reference
//     decision; a self-owned sync writes every node, so we send `[]`;
//   - `package_sha256` IS verified on load — computed via the shared recipe.

import { createZip } from './zip.js'
import {
  sha256Hex,
  toJsonBuffer,
  buildManifest,
  computePackageSha256,
} from './manifest.js'

// `exporter.instance`: caller-override -> env UNIWEB_INSTANCE_ID -> "unknown".
// Provenance only; neutralized in the digest, so its value is inert.
function defaultExporter() {
  return {
    tool: 'uniweb',
    version: 'dev',
    instance: process.env.UNIWEB_INSTANCE_ID || 'unknown',
  }
}

/**
 * Build a `subtype: entity` .uwx for the sync lane from pre-shaped `$`-documents.
 * Serializes only — the mapper (collections.js) shapes each `document` in the
 * wire's canonical key order; nothing is reordered here.
 *
 * @param {object}   opts
 * @param {object[]} opts.entities       - { id, model, file, document } each.
 *        `document` is the section-keyed `$`-document body; `file` is its
 *        path-in-ZIP; `id` is the `$id` handle; `model` is the registry name.
 * @param {object[]} opts.modelsRequired - { name_at_export } each; the Model(s)
 *        the importer resolves BY NAME (no uuids — resolve-never-mint).
 * @param {object}   [opts.exporter]     - provenance; digest-neutralized.
 * @param {string}   [opts.exportedAt]   - ISO-8601; digest-neutralized.
 * @returns {Buffer} the .uwx ZIP bytes
 */
export function emitEntitySyncPackage({
  entities,
  modelsRequired,
  exporter = defaultExporter(),
  exportedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error('uwx: emitEntitySyncPackage requires at least one entity')
  }
  if (!Array.isArray(modelsRequired) || modelsRequired.length === 0) {
    throw new Error('uwx: emitEntitySyncPackage requires modelsRequired')
  }

  const files = []
  const entries = []
  for (const entity of entities) {
    const data = toJsonBuffer(entity.document)
    files.push({ name: entity.file, data })
    entries.push({
      kind: 'entity',
      // `$id` as the handle label — NOT the identity key on the sync lane (the
      // backend reads identity from the body) and never uuid-parsed for entities.
      uuid: entity.id,
      // Model referenced BY NAME; the importer resolves it (no uuid).
      model: entity.model,
      owner_uuid: null,
      unit_uuid: null,
      // Derived columns the backend recomputes on ingest — preview slots, null.
      brief: null,
      sort_date: null,
      updated_at: null,
      file: entity.file,
      sha256: sha256Hex(data),
    })
  }

  const manifest = buildManifest({
    subtype: 'entity',
    exporter,
    exportedAt,
    modelsRequired: modelsRequired.map((m) => ({
      uuid: null,
      name_at_export: m.name_at_export ?? null,
      policy_hint: 'validate_existing',
    })),
    referencedMembers: [],
    referencedUnits: [],
    // A self-owned sync writes every node, so `roots` (the writable-vs-reference
    // set) is never consulted; first-sync entities have no uuid to list anyway.
    roots: [],
    entries,
    edges: [],
    blobs: [],
  })
  manifest.package_sha256 = computePackageSha256(manifest)

  return createZip([
    { name: 'manifest.json', data: toJsonBuffer(manifest) },
    ...files,
  ])
}
