// Back-fill minted `$uuid`s from a sync's finalized response into the source
// files, so a re-sync round-trips them for update-in-place. The symmetric
// write-side of the collection-sync emitter (collections.js): the emitter sends
// `$id` with no `$uuid` on first sync; the backend mints `$uuid` and returns it;
// this writes it next to the record in its source file (docs/reference/entity-content.md).
//
// v1 handles single-record YAML and JSON files (the flat-collection case). MD
// frontmatter, BibTeX, and array-form files (many records in one file) are
// deferred — reported as 'deferred', never silently skipped.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Probed in this order to locate a single-record source file by slug.
const SOURCE_EXTENSIONS = ['.yml', '.yaml', '.json', '.md', '.bib']
const DEFERRED_EXTENSIONS = new Set(['.md', '.bib'])

/**
 * Locate the single-record source file for `slug` in a collection directory by
 * probing the supported extensions. Returns the absolute path or null (e.g. an
 * array-form file holding many records, whose name is not `<slug>.<ext>`).
 */
export function findRecordFile(collectionDir, slug) {
  for (const ext of SOURCE_EXTENSIONS) {
    const p = join(collectionDir, slug + ext)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Insert `$uuid` into a single-record source file, preserving the rest of the
 * file. Idempotent — a file already carrying the same `$uuid` is left untouched.
 *
 * @param {string} filePath
 * @param {string} uuid
 * @returns {{ status: 'updated'|'unchanged'|'deferred'|'error', message?: string }}
 */
export function backfillUuid(filePath, uuid) {
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
  if (DEFERRED_EXTENSIONS.has(ext)) {
    return { status: 'deferred', message: `${ext} back-fill is not yet implemented` }
  }
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { status: 'error', message: `cannot read ${filePath}: ${err.message}` }
  }

  if (ext === '.json') return backfillJson(filePath, text, uuid)
  if (ext === '.yml' || ext === '.yaml') return backfillYaml(filePath, text, uuid)
  return { status: 'deferred', message: `unsupported source format "${ext || '(none)'}"` }
}

// YAML: a textual insert/replace so comments and formatting survive. A top-level
// `$uuid:` line is replaced in place (re-sync); otherwise `$uuid:` is prepended
// as the record's first key (first sync), matching the entity-content convention.
function backfillYaml(filePath, text, uuid) {
  const existing = /^\$uuid\s*:\s*(.*)$/m.exec(text)
  if (existing) {
    if (existing[1].trim() === uuid) return { status: 'unchanged' }
    // Function replacer: avoids `$`-pattern interpretation in the replacement.
    const next = text.replace(/^\$uuid\s*:.*$/m, () => `$uuid: ${uuid}`)
    writeFileSync(filePath, next)
    return { status: 'updated' }
  }
  writeFileSync(filePath, `$uuid: ${uuid}\n${text}`)
  return { status: 'updated' }
}

// JSON: parse, set `$uuid` as the first key, re-serialize (2-space + newline).
// JSON has no comments to preserve; key order is normalized with `$uuid` leading.
function backfillJson(filePath, text, uuid) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (err) {
    return { status: 'error', message: `invalid JSON in ${filePath}: ${err.message}` }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { status: 'deferred', message: 'array-form / non-object JSON not handled in v1' }
  }
  if (obj.$uuid === uuid) return { status: 'unchanged' }
  const { $uuid: _drop, ...rest } = obj
  const out = { $uuid: uuid, ...rest }
  writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n')
  return { status: 'updated' }
}

/**
 * Back-fill every finalized entity's `$uuid` into its source file.
 *
 * @param {object} params
 * @param {object[]} params.index     - the emitter's per-entity index:
 *        `{ id, model, slug, sourceFile }` (sourceFile null when not on disk).
 * @param {object[]} params.finalized - the response entities:
 *        `{ $id, $model, $uuid }` (only those carrying a `$uuid` are written).
 * @returns {{ updated: string[], unchanged: string[], deferred: object[], warnings: string[] }}
 */
export function backfillEntityUuids({ index, finalized }) {
  const byKey = new Map((index || []).map((e) => [`${e.model} ${e.id}`, e]))
  const updated = []
  const unchanged = []
  const deferred = []
  const warnings = []

  for (const fin of finalized || []) {
    const id = fin.$id
    const model = fin.$model
    const uuid = fin.$uuid
    if (!uuid) continue // nothing minted/returned to write
    const entry = byKey.get(`${model} ${id}`)
    if (!entry) {
      warnings.push(`finalized ($model=${model}, $id=${id}) has no matching submitted record`)
      continue
    }
    if (!entry.sourceFile) {
      deferred.push({ id, model, reason: 'no single-record source file (array-form?)' })
      continue
    }
    const res = backfillUuid(entry.sourceFile, uuid)
    if (res.status === 'updated') updated.push(entry.sourceFile)
    else if (res.status === 'unchanged') unchanged.push(entry.sourceFile)
    else if (res.status === 'deferred') deferred.push({ id, model, file: entry.sourceFile, reason: res.message })
    else warnings.push(`${entry.sourceFile}: ${res.message}`)
  }
  return { updated, unchanged, deferred, warnings }
}
