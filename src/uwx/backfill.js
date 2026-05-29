// Back-fill minted `$uuid`s from a sync's finalized response into the source
// files, so a re-sync round-trips them for update-in-place. The symmetric
// write-side of the collection-sync emitter (collections.js): the emitter sends
// `$id` with no `$uuid` on first sync; the backend mints `$uuid` and returns it;
// this writes it into the record in its source file (docs/reference/entity-content.md).
//
// Write-back RE-RENDERS the parsed record with `$uuid` as the leading key, rather
// than surgically patching the text. It does not preserve comments or incidental
// formatting (accepted) — in exchange it is one uniform path across YAML, JSON, and
// markdown frontmatter, and it converges to a fixpoint: a pristine file gains only
// a `$uuid`, and a no-op re-sync is byte-identical (render(parse(x)) == x once
// canonical). It reads from the SOURCE file (not the backend's finalized document),
// so field values round-trip untouched and no inverse decode is needed in v1.
//
// Single-record YAML/JSON/markdown files are handled. Array-form files (many
// records in one file) and BibTeX are deferred — reported as 'deferred', never
// silently skipped (no single-record file to rewrite in place).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { parseFrontmatter } from './collection-source.js'

// Probed in this order to locate a single-record source file by slug.
const SOURCE_EXTENSIONS = ['.yml', '.yaml', '.json', '.md', '.bib']

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

// `$uuid` as the leading key, the rest of the object after it in its existing
// order. Re-used by every format renderer so key order is uniform.
function withUuidFirst(obj, uuid) {
  const { $uuid: _drop, ...rest } = obj
  return { $uuid: uuid, ...rest }
}

/**
 * Insert `$uuid` into a single-record source file by re-rendering the parsed
 * record with `$uuid` leading. Idempotent — if the render equals the file's
 * current bytes, nothing is written.
 *
 * @param {string} filePath
 * @param {string} uuid
 * @returns {{ status: 'updated'|'unchanged'|'deferred'|'error', message?: string }}
 */
export function backfillUuid(filePath, uuid) {
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()

  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { status: 'error', message: `cannot read ${filePath}: ${err.message}` }
  }

  let next
  if (ext === '.json') {
    let obj
    try {
      obj = JSON.parse(text)
    } catch (err) {
      return { status: 'error', message: `invalid JSON in ${filePath}: ${err.message}` }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { status: 'deferred', message: 'array-form / non-object JSON not handled in v1' }
    }
    next = JSON.stringify(withUuidFirst(obj, uuid), null, 2) + '\n'
  } else if (ext === '.yml' || ext === '.yaml') {
    let obj
    try {
      obj = yaml.load(text)
    } catch (err) {
      return { status: 'error', message: `invalid YAML in ${filePath}: ${err.message}` }
    }
    if (Array.isArray(obj)) {
      return { status: 'deferred', message: 'array-form YAML (many records) not handled in v1' }
    }
    next = yaml.dump(withUuidFirst(obj && typeof obj === 'object' ? obj : {}, uuid))
  } else if (ext === '.md') {
    const { frontmatter, body } = parseFrontmatter(text)
    next = `---\n${yaml.dump(withUuidFirst(frontmatter, uuid))}---\n${body}`
  } else {
    return { status: 'deferred', message: `${ext || '(no extension)'} back-fill is not yet implemented` }
  }

  if (next === text) return { status: 'unchanged' }
  writeFileSync(filePath, next)
  return { status: 'updated' }
}

/**
 * Back-fill every finalized entity's `$uuid` into its source file.
 *
 * @param {object} params
 * @param {object[]} params.index     - the emitter's per-entity index:
 *        `{ id, model, slug, sourceFile }` (sourceFile null when not a
 *        single-record file — array-form / BibTeX).
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
      deferred.push({ id, model, reason: 'no single-record source file (array-form / BibTeX)' })
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
