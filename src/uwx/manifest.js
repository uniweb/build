// Manifest assembly, per-entity serialization, and the package digest for
// the Uniweb exchange format (`.uwx`, `uwx/1`).
//
// This emits the WIRE format `uwx/1` — never the human fixture-authoring
// shape. The two are different formats; don't conflate them.

import { createHash } from 'node:crypto'

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// Compact JSON, UTF-8. Key order = object insertion order (JS preserves it
// for string keys). Callers build objects in the documented field order so
// the bytes are stable and diffable.
export function toJsonBuffer(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
}

/**
 * Per-entity file. `items[]` carry positional `parent_path` (not a parent
 * uuid) — the importer reconstructs the tree from position.
 *
 * `brief` / `sort_date` / `updated_at` are NOT in the per-entity file — they
 * are derived columns the importer recomputes. The exporter only carries
 * them in the manifest `entries[]` as a preview convenience.
 */
export function serializeEntityFile(entity) {
  const out = { uuid: entity.uuid }
  // Type pointer. A uuid'd Model carries `model_uuid`; a Model referenced by
  // NAME carries `model`, and the importer resolves the name — used when the
  // exporter has no uuid for the Model. Exactly one is set; emitting `model`
  // only when there is no uuid keeps a by-uuid entity's bytes (and the package
  // digest) unchanged.
  if (entity.model_uuid != null) out.model_uuid = entity.model_uuid
  else out.model = entity.model
  out.owner_uuid = entity.owner_uuid ?? null
  out.unit_uuid = entity.unit_uuid ?? null
  out.meta = entity.meta ?? {}
  out.items = (entity.items ?? []).map((it) => ({
    uuid: it.uuid,
    section: it.section,
    parent_section: it.parent_section ?? null,
    parent_path: it.parent_path ?? null,
    data: it.data ?? {},
    meta: it.meta ?? {},
    item_date: it.item_date ?? null,
    order_number: it.order_number ?? null,
  }))
  return toJsonBuffer(out)
}

// Manifest field order is part of the format. Built in this exact order so
// the serialized bytes are stable (and so the digest's neutralized copy
// below is a byte-for-byte slice of the same shape).
export function buildManifest({
  subtype,
  exporter,
  exportedAt,
  modelsRequired,
  referencedMembers,
  referencedUnits,
  roots,
  entries,
  edges,
  blobs,
}) {
  return {
    format: 'uwx/1',
    subtype,
    exporter,
    exported_at: exportedAt,
    models_required: modelsRequired,
    referenced_members: referencedMembers,
    referenced_units: referencedUnits,
    roots,
    entries,
    edges,
    blobs,
    package_sha256: '',
  }
}

// ---------------------------------------------------------------------------
// package_sha256 — a stable, provenance-free content key.
//
// SHA-256 of the manifest with `package_sha256` zeroed AND `exported_at` /
// `exporter` neutralized (provenance is not content identity), concatenated
// with each entry's lowercase-hex `sha256` in `entries` order. Two exports
// of identical content produce the same value (used for dedupe). It is
// deliberately NOT reproducible via `unzip -p manifest.json | sha256sum`.
//
// An importer recomputes this to verify integrity, so the recipe must match
// exactly. The ambiguous serialization choices are isolated below as
// numbered assumptions, each independently flippable, and verified against a
// reference vector:
//
//   A1. "zeroed" package_sha256        -> "" (empty string)
//   A2. "neutralized" exporter         -> null
//   A3. "neutralized" exported_at      -> "" (empty string)
//   A4. manifest serialization         -> compact JSON, documented field
//                                         order, default JSON.stringify
//                                         escaping/number formatting
//   A5. concatenation                  -> utf8(neutralizedJson) then each
//                                         entry.sha256 as an ascii hex string,
//                                         in entries order
//   A6. output                         -> lowercase hex
// ---------------------------------------------------------------------------

export const PACKAGE_SHA256_ASSUMPTIONS = Object.freeze({
  zeroedPackageSha256: '', // A1
  neutralizedExporter: null, // A2
  neutralizedExportedAt: '', // A3
})

export function computePackageSha256(manifest) {
  const neutralized = {
    ...manifest,
    exporter: PACKAGE_SHA256_ASSUMPTIONS.neutralizedExporter, // A2
    exported_at: PACKAGE_SHA256_ASSUMPTIONS.neutralizedExportedAt, // A3
    package_sha256: PACKAGE_SHA256_ASSUMPTIONS.zeroedPackageSha256, // A1
  }
  // A4: spreading preserves the original key insertion order; the three
  // overridden keys keep their original positions.
  const parts = [toJsonBuffer(neutralized)] // A5
  for (const entry of manifest.entries) {
    parts.push(Buffer.from(entry.sha256, 'ascii'))
  }
  return sha256Hex(Buffer.concat(parts)) // A6
}
