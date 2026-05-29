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
// package_sha256 — bytes-integrity over the manifest as written.
//
// SHA-256 of the manifest.json bytes EXACTLY AS WRITTEN, with only the
// `package_sha256` field's value blanked to "". Producer flow: build the
// manifest with `package_sha256: ""`, serialize (that serialization IS the
// preimage), hash, write the digest back into the field. The consumer
// recomputes by taking the received bytes, blanking the `package_sha256` value
// in place, and hashing — reproducing the producer's preimage exactly.
//
// PRODUCER BYTES ARE AUTHORITATIVE: the hash is over OUR serialization, so the
// consumer never re-serializes and the manifest's field set / order / naming /
// formatting never has to match anything on the consumer side. That is what
// lets a JS producer and a non-JS consumer agree on the digest — an earlier
// recipe re-serialized the manifest on the consumer side and could not
// byte-match a different language's serializer.
//
// NOT provenance-free: `exporter` / `exported_at` are hashed as-is (they are in
// the written bytes), so two exports of the same content with different
// provenance get different digests. `package_sha256` is pure integrity; a
// content-dedupe key, if ever needed, is a separate provenance-excluded digest.
//
//   A1. blanked package_sha256  -> "" (empty string); the field keeps its place
//   A4. serialization           -> compact JSON, documented field order,
//                                  default JSON.stringify escaping/numbers
//   A6. output                  -> lowercase hex
// ---------------------------------------------------------------------------

export const PACKAGE_SHA256_ASSUMPTIONS = Object.freeze({
  blankedPackageSha256: '', // A1
})

export function computePackageSha256(manifest) {
  // Hash the manifest bytes as written, with package_sha256 blanked. At call
  // time the field is already "" (the build sets it before computing); forcing
  // it keeps the function correct if ever called on a populated manifest. The
  // spread preserves key insertion order, so package_sha256 keeps its position.
  const preimage = { ...manifest, package_sha256: PACKAGE_SHA256_ASSUMPTIONS.blankedPackageSha256 }
  return sha256Hex(toJsonBuffer(preimage)) // A4 + A6
}
