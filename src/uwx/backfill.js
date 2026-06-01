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
// Single-record YAML/JSON/markdown files are rendered/back-filled in place.
// Multi-record files — array-form YAML/JSON and BibTeX (many records in one
// file) — are grouped by file and written once, one `$uuid` per record keyed by
// slug/cite-key. Anything genuinely unwritable is reported as 'deferred', never
// silently skipped.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { proseMirrorToMarkdown } from '@uniweb/content-writer'
import { parseFrontmatter } from './collection-source.js'
import { isProseMirrorField } from './data-schema.js'
import { unwrapLocalizedContent } from './locale-sync.js'
import { parseBibtex, exportBibtex } from '@citestyle/bibtex'

// Probed in this order to locate a single-record source file by slug.
const SOURCE_EXTENSIONS = ['.yml', '.yaml', '.json', '.md', '.bib']
const RICHTEXT_TYPE = 'richtext'

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
 * Back-fill minted `$uuid`s into a BibTeX file (many entries in one file), keyed
 * by each entry's cite key (the slug / `$id`). Parse → set `$uuid` on each matched
 * entry → re-export canonically. `@citestyle/bibtex` (>=1.1.0) preserves `$`-sigil
 * fields through parse↔export, so the uuid rides in the entry and a re-sync
 * round-trips it. Sync owns the output, so comments/order are not preserved (by
 * design); idempotent — re-exporting already-`$uuid`'d entries is byte-identical.
 *
 * @param {string} filePath
 * @param {Map<string,string>} uuidBySlug - cite key → minted uuid for this file
 * @returns {{ status: 'updated'|'unchanged'|'error', message?: string }}
 */
export function backfillBibFile(filePath, uuidBySlug) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { status: 'error', message: `cannot read ${filePath}: ${err.message}` }
  }
  let entries
  try {
    entries = parseBibtex(text)
  } catch (err) {
    return { status: 'error', message: `invalid BibTeX in ${filePath}: ${err.message}` }
  }
  if (!Array.isArray(entries)) {
    return { status: 'error', message: `expected BibTeX entries in ${filePath}` }
  }
  const next = entries.map((e) => {
    const uuid = e && e.id ? uuidBySlug.get(e.id) : null
    if (!uuid || e.$uuid === uuid) return e
    return withUuidFirst(e, uuid)
  })
  const out = exportBibtex(next)
  if (out === text) return { status: 'unchanged' }
  writeFileSync(filePath, out)
  return { status: 'updated' }
}

// Unwrap a localized wire value `{ <locale>: v }` back to the authored bare value
// (the source locale, else the first present). Non-localized values pass through.
export function unwrapLocalized(value, sourceLocale) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, sourceLocale)) return value[sourceLocale]
    const keys = Object.keys(value)
    if (keys.length) return value[keys[0]]
  }
  return value
}

// Inverse of locale-sync's localizeScalarList: unwrap a `multiple: true` localized
// field element-wise. An array unwraps each element; a bare localized map unwraps to
// one value. The container shape is preserved (mirrors how the producer built it).
export function unwrapLocalizedList(value, sourceLocale) {
  if (Array.isArray(value)) return value.map((v) => unwrapLocalized(v, sourceLocale))
  return unwrapLocalized(value, sourceLocale)
}

// The brief is the section marked `brief: true` in the declaration's sections map
// (the sections-tree has no schema-level `brief:` back-reference). Returned with
// its name attached (the map key) so callers can key the document by it.
function briefSectionOf(declaration) {
  const entry = Object.entries(declaration?.sections || {}).find(([, s]) => s && s.brief === true)
  return entry ? { name: entry[0], ...entry[1] } : null
}

// Whether a Model's brief section declares a CONTENT body field (richtext, or a
// `format: prosemirror` json field) — the md-body target. A markdown source file
// can only be safely rendered from the document when its body has a field home —
// otherwise the body would be lost (variant B then).
function briefHasContentBody(declaration) {
  const brief = briefSectionOf(declaration)
  return Object.values(brief?.fields || {}).some((f) => f.type === RICHTEXT_TYPE || isProseMirrorField(f))
}

/**
 * Render a finalized entity `document` back to its source-file authoring shape
 * (variant A — the file becomes a projection of backend state). For a flat/brief
 * entity: the entity `$uuid` + the brief section's fields (localized unwrapped,
 * date/scalars verbatim), with the brief record's own `$uuid` DROPPED (the backend
 * matches a single-section item by singularity) and `$model`/`$id`/`$meta` omitted.
 * For markdown, the richtext field becomes the body; for YAML/JSON it stays a field.
 *
 * @param {object} params
 * @param {object} params.document     - finalized `{ $uuid, $model, <brief>: {…} }`
 * @param {object} params.declaration  - the Model declaration (`brief` + `sections`)
 * @param {string} params.format       - 'yaml' | 'json' | 'md'
 * @param {string} [params.sourceLocale]
 * @param {object} [params.collector]  - translation collector; target locales of
 *        localized SCALAR fields are captured into it (→ locales/collections/{locale}.json),
 *        and a localized prosemirror BODY's target locales are captured as either a
 *        structural map or, when `freeformRelPath` is given, a free-form body override.
 * @param {string} [params.freeformRelPath] - the free-form path for this record's
 *        content body (buildFreeformCollectionPath); lets a target-locale full-doc
 *        body be written under locales/freeform/{locale}/ instead of being dropped.
 * @returns {string} the source-file text
 */
export function renderEntityDocument({ document, declaration, format, sourceLocale = 'en', collector, freeformRelPath }) {
  const brief = briefSectionOf(declaration)
  const section = brief ? document?.[brief.name] : null
  if (!brief || !section || typeof section !== 'object') {
    throw new Error('uwx/render: document has no resolvable brief section')
  }
  const fields = brief.fields || {}
  // The body target is the CONTENT field — a `richtext` field or a `format:
  // prosemirror` json field (the latter is a ProseMirror doc on the wire).
  const contentKey = Object.entries(fields).find(
    ([, f]) => f.type === RICHTEXT_TYPE || isProseMirrorField(f)
  )?.[0]

  const record = {}
  if (document.$uuid) record.$uuid = document.$uuid
  let body = ''
  for (const [key, field] of Object.entries(fields)) {
    const raw = section[key]
    if (raw === undefined) continue

    // A `format: prosemirror` field is a ProseMirror doc (or localized doc+maps)
    // on the wire → markdown on disk. unwrapLocalizedContent yields the source doc
    // and captures target-locale structural maps into the collector.
    if (isProseMirrorField(field)) {
      const sourceDoc = field.localized ? unwrapLocalizedContent(raw, sourceLocale, collector, freeformRelPath) : raw
      const md = sourceDoc ? proseMirrorToMarkdown(sourceDoc) : ''
      if (format === 'md' && key === contentKey) body = md
      else record[key] = md
      continue
    }

    // Capture target-locale translations of localized SCALAR fields (not the
    // content body) into the collector when one is supplied.
    if (field.localized && key !== contentKey) collector?.add(raw)
    const value = field.localized ? unwrapLocalized(raw, sourceLocale) : raw
    if (format === 'md' && key === contentKey) {
      body = typeof value === 'string' ? value : String(value ?? '')
      continue
    }
    record[key] = value
  }

  if (format === 'json') return JSON.stringify(record, null, 2) + '\n'
  if (format === 'md') return `---\n${yaml.dump(record)}---\n${body}`
  return yaml.dump(record) // yaml / yaml
}

// Write text only when it differs from what's on disk (idempotent).
function writeIfChanged(filePath, text) {
  let current = ''
  try {
    current = readFileSync(filePath, 'utf8')
  } catch {
    // new file / unreadable — treat as a change
  }
  if (text === current) return 'unchanged'
  writeFileSync(filePath, text)
  return 'updated'
}

/**
 * Back-fill the sync response into the source files. Correlation is by **`index`**
 * — `finalized[i].index` is the 0-based position of the entity in the submitted
 * sequence, which equals the producer's `index` array order (the backend does not
 * echo `$id`). Single-record files are rendered from the finalized `document`
 * (variant A) when the document + declaration are present and lossless for the
 * format (markdown needs a richtext field to carry the body); otherwise the
 * entity `$uuid` is back-filled in place (variant B). Multi-record YAML/JSON files
 * get a per-entry `$uuid` keyed by slug, grouped so each file is written once;
 * BibTeX stays deferred.
 *
 * @param {object} params
 * @param {object[]} params.index     - the emitter's per-entity index, in submit
 *        order: `{ id, model, slug, sourceFile, format?, multiRecord?, declaration? }`.
 * @param {object[]} params.finalized - response entries `{ index, uuid, changed?, document? }`.
 * @param {string} [params.sourceLocale]
 * @returns {{ updated: string[], unchanged: string[], deferred: object[], warnings: string[] }}
 */
export function backfillEntityUuids({ index, finalized, sourceLocale = 'en' }) {
  const updated = []
  const unchanged = []
  const deferred = []
  const warnings = []
  // Multi-record files are written ONCE per file, applying every (slug → uuid).
  const arrayFiles = new Map() // array-form YAML/JSON: sourceFile -> Map(slug -> uuid)
  const bibFiles = new Map() // BibTeX: sourceFile -> Map(cite key -> uuid)

  for (const fin of finalized || []) {
    const uuid = fin.uuid
    if (!uuid) continue // nothing minted/returned to write
    const i = fin.index
    const entry = Number.isInteger(i) && i >= 0 ? (index || [])[i] : undefined
    if (!entry) {
      warnings.push(`finalized index ${i} has no matching submitted entity`)
      continue
    }
    // Skip the non-record entities: the site-content entity (its uuid is back-filled
    // into site.yml by the caller, via writeSiteEntityUuid) and the folder entity
    // (no uuid to back-fill — the backend owns the site's folder, keyed by the
    // site-content uuid). Both are positional placeholders with no record source file.
    if (entry.kind === 'site' || entry.kind === 'folder') continue
    if (!entry.sourceFile) {
      deferred.push({ index: i, id: entry.id, reason: 'no source file on disk' })
      continue
    }
    if (entry.multiRecord) {
      // Many records in one file → group by file, written once. BibTeX and
      // array-form YAML/JSON both re-render canonically (sync owns the output);
      // the per-file writer is chosen by format below.
      const group = entry.format === 'bib' ? bibFiles : arrayFiles
      let m = group.get(entry.sourceFile)
      if (!m) {
        m = new Map()
        group.set(entry.sourceFile, m)
      }
      m.set(entry.slug, uuid)
      continue
    }

    // Variant A: render the finalized document over the file when we have it +
    // the declaration, and it's lossless for the format (md needs a richtext field
    // for its body). Otherwise variant B: back-fill the uuid in place.
    const canRenderA =
      fin.document &&
      entry.declaration &&
      (entry.format !== 'md' || briefHasContentBody(entry.declaration))
    let res
    if (canRenderA) {
      try {
        const text = renderEntityDocument({
          document: fin.document,
          declaration: entry.declaration,
          format: entry.format,
          sourceLocale,
        })
        res = { status: writeIfChanged(entry.sourceFile, text) }
      } catch (err) {
        warnings.push(`${entry.sourceFile}: ${err.message}; fell back to uuid back-fill`)
        res = backfillUuid(entry.sourceFile, uuid)
      }
    } else {
      res = backfillUuid(entry.sourceFile, uuid)
    }
    if (res.status === 'updated') updated.push(entry.sourceFile)
    else if (res.status === 'unchanged') unchanged.push(entry.sourceFile)
    else if (res.status === 'deferred') deferred.push({ index: i, id: entry.id, file: entry.sourceFile, reason: res.message })
    else warnings.push(`${entry.sourceFile}: ${res.message}`)
  }

  for (const [file, uuidBySlug] of arrayFiles) {
    const res = backfillArrayFile(file, uuidBySlug)
    if (res.status === 'updated') updated.push(file)
    else if (res.status === 'unchanged') unchanged.push(file)
    else if (res.status === 'deferred') deferred.push({ file, reason: res.message })
    else warnings.push(`${file}: ${res.message}`)
  }
  for (const [file, uuidBySlug] of bibFiles) {
    const res = backfillBibFile(file, uuidBySlug)
    if (res.status === 'updated') updated.push(file)
    else if (res.status === 'unchanged') unchanged.push(file)
    else warnings.push(`${file}: ${res.message}`)
  }

  return { updated, unchanged, deferred, warnings }
}
