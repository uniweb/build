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
 * Back-fill minted `$uuid`s into an array-form source file (many records in one
 * YAML/JSON file), keyed by each record's slug. Each entry is its own entity, so
 * this writes one `$uuid` per entry — a re-sync then round-trips them by uuid
 * (no duplicate-on-resync). The whole file is parsed and re-rendered ONCE with
 * `$uuid` set as the leading key on every matched element. Idempotent.
 *
 * @param {string} filePath
 * @param {Map<string,string>} uuidBySlug - slug → minted uuid for this file
 * @returns {{ status: 'updated'|'unchanged'|'deferred'|'error', message?: string }}
 */
export function backfillArrayFile(filePath, uuidBySlug) {
  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { status: 'error', message: `cannot read ${filePath}: ${err.message}` }
  }
  let arr
  try {
    arr = ext === '.json' ? JSON.parse(text) : yaml.load(text)
  } catch (err) {
    return { status: 'error', message: `invalid ${ext || '(no extension)'} in ${filePath}: ${err.message}` }
  }
  if (!Array.isArray(arr)) {
    return { status: 'deferred', message: 'expected an array-form (multi-record) file' }
  }
  const next = arr.map((el) => {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return el
    const uuid = uuidBySlug.get(el.slug)
    if (!uuid || el.$uuid === uuid) return el
    return withUuidFirst(el, uuid)
  })
  const out = ext === '.json' ? JSON.stringify(next, null, 2) + '\n' : yaml.dump(next)
  if (out === text) return { status: 'unchanged' }
  writeFileSync(filePath, out)
  return { status: 'updated' }
}

/**
 * Back-fill every finalized entity's `$uuid` into its source file.
 *
 * @param {object} params
 * @param {object[]} params.index     - the emitter's per-entity index:
 *        `{ id, model, slug, sourceFile, format?, multiRecord? }`. Single-record
 *        files render whole; multi-record YAML/JSON files get a per-entry write
 *        keyed by slug (grouped so each file is rewritten once); BibTeX stays
 *        deferred.
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
  // Multi-record YAML/JSON files are written ONCE, applying every (slug → uuid)
  // for that file together.
  const arrayFiles = new Map() // sourceFile -> Map(slug -> uuid)

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
      deferred.push({ id, model, reason: 'no source file on disk' })
      continue
    }
    if (entry.multiRecord) {
      // BibTeX multi-record write-back is a follow-up (no serializer; per-entry
      // $uuid insertion + reference-manager re-export fragility). Array-form
      // YAML/JSON is handled below.
      if (entry.format === 'bib') {
        deferred.push({ id, model, file: entry.sourceFile, reason: 'BibTeX write-back is a follow-up' })
        continue
      }
      let m = arrayFiles.get(entry.sourceFile)
      if (!m) {
        m = new Map()
        arrayFiles.set(entry.sourceFile, m)
      }
      m.set(entry.slug, uuid)
      continue
    }
    const res = backfillUuid(entry.sourceFile, uuid)
    if (res.status === 'updated') updated.push(entry.sourceFile)
    else if (res.status === 'unchanged') unchanged.push(entry.sourceFile)
    else if (res.status === 'deferred') deferred.push({ id, model, file: entry.sourceFile, reason: res.message })
    else warnings.push(`${entry.sourceFile}: ${res.message}`)
  }

  for (const [file, uuidBySlug] of arrayFiles) {
    const res = backfillArrayFile(file, uuidBySlug)
    if (res.status === 'updated') updated.push(file)
    else if (res.status === 'unchanged') unchanged.push(file)
    else if (res.status === 'deferred') deferred.push({ file, reason: res.message })
    else warnings.push(`${file}: ${res.message}`)
  }

  return { updated, unchanged, deferred, warnings }
}
