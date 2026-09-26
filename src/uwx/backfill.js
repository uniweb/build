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
// ⛔ A PUSH NEVER RENDERS THE BACKEND'S DOCUMENT OVER THE AUTHOR'S FILE. It did, for
// a record's first push, from 2026-05-29 to 2026-09-23 ("variant A"), and that
// document is not the author's file: it carries the serve URL the push put where the
// author wrote `/images/x.png`, and only the brief section's declared fields. So a
// first push rewrote the record's images to a backend route and deleted every key the
// Model does not declare, and every field of any other section. What a backend holds
// reaches the file on a pull (`records-project.js`), which restores asset paths first.
//
// Single-record YAML/JSON/markdown files are rendered/back-filled in place.
// Multi-record files — array-form YAML/JSON and BibTeX (many records in one
// file) — are grouped by file and written once, one `$uuid` per record keyed by
// slug/cite-key. Anything genuinely unwritable is reported as 'deferred', never
// silently skipped.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { proseMirrorToMarkdown } from '@uniweb/content-writer'
import { parseFrontmatter } from './entity-source.js'
import { isProseMirrorField } from './data-schema.js'
import { recordFileLayout, contentBodyTarget } from './record-layout.js'
import { unwrapLocalizedContent } from './locale-sync.js'
import { parseBibtex, exportBibtex } from '@citestyle/bibtex'

// Probed in this order to locate a single-record source file by slug.
const SOURCE_EXTENSIONS = ['.yml', '.yaml', '.json', '.md', '.bib']

/**
 * Locate the single-record source file for `slug` in a collection directory by
 * probing the supported extensions. Returns the absolute path or null (e.g. an
 * array-form file holding many records, whose name is not `<slug>.<ext>`).
 */
export function findRecordFile(poolDir, slug) {
  for (const ext of SOURCE_EXTENSIONS) {
    const p = join(poolDir, slug + ext)
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
      obj = yaml.load(text, YAML_OPTIONS)
    } catch (err) {
      return { status: 'error', message: `invalid YAML in ${filePath}: ${err.message}` }
    }
    if (Array.isArray(obj)) {
      return { status: 'deferred', message: 'array-form YAML (many records) not handled in v1' }
    }
    next = yaml.dump(withUuidFirst(obj && typeof obj === 'object' ? obj : {}, uuid))
  } else if (ext === '.md') {
    const { frontmatter, body } = parseFrontmatter(text, filePath)
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
    arr = ext === '.json' ? JSON.parse(text) : yaml.load(text, YAML_OPTIONS)
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

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Render an entity `document` a pull brought back to its source-file authoring shape
 * — the file becomes a projection of the backend's state, which is what a pull is
 * (`writeRecordFile`, `records-project.js`). A push never uses it (header ⛔).
 *
 * The file takes its schema's layout (`./record-layout.js`), the one the push reads:
 * FLAT for a schema with one top-level section holding one record — that section's
 * fields at the top — and BY SECTION otherwise, every section the document holds under
 * its own name: an object for a single section, a list of records for a `many` one, a
 * self-nesting record's `$children` written back as `children:`. Values are decoded by
 * their declaration at every depth (localized unwrapped to the source locale, a
 * ProseMirror doc to markdown, dates and scalars verbatim). Every record's own `$uuid`
 * is dropped — the backend matches a single section's record by singularity — and
 * `$schema`/`$id`/`$meta` are omitted; the entity's `$uuid` leads. A disabled entity
 * (`$disabled: true`) writes `draft: true`, and an enabled one writes no `draft:`.
 * For markdown, the content body field becomes the body; for YAML/JSON it stays a field.
 *
 * ⛔ Until 2026-09-24 this wrote the BRIEF section alone, flat. Every other section was
 * dropped from the file — a pulled `@std/article` markdown record came back with an
 * empty body, its `article_body` gone — and nothing said so.
 *
 * @param {object} params
 * @param {object} params.document     - a pulled `{ $uuid, $schema, <section>: … }`
 * @param {object} params.declaration  - the data schema's declaration (`sections`)
 * @param {string} params.format       - 'yaml' | 'json' | 'md'
 * @param {string} [params.sourceLocale]
 * @param {object} [params.collector]  - translation collector; target locales of
 *        localized SCALAR fields are captured into it (→ locales/records/{locale}.json),
 *        and a localized prosemirror BODY's target locales are captured as either a
 *        structural map or, when `freeformRelPath` is given, a free-form body override.
 * @param {string} [params.freeformRelPath] - the free-form path for this record's
 *        content body (buildFreeformRecordPath); lets a target-locale full-doc
 *        body be written under locales/freeform/{locale}/ instead of being dropped.
 * @param {(model: string, uuid: string) => string|null} [params.refName] - the name a
 *        referenced record goes by in the project, for a reference's uuid; a reference
 *        it has no name for is written as the uuid.
 * @returns {string} the source-file text
 */
export function renderEntityDocument({ document, declaration, format, sourceLocale = 'en', collector, freeformRelPath, refName, context = null }) {
  const layout = recordFileLayout(declaration)
  if (layout.sections.length === 0) {
    throw new Error('uwx/render: the data schema declares no sections')
  }
  // ⛔ An entity holding NONE of its schema's sections — what a partly applied push
  // left, before the backend's push became one transaction — is not written: rendered,
  // it would replace the author's record with an empty one. The caller skips it.
  if (!layout.sections.some(([name]) => document?.[name] != null)) {
    throw new Error("uwx/render: the entity holds none of its data schema's sections — nothing to write")
  }
  // Markdown: the content body field, wherever its single section is, becomes the body.
  const { target } = contentBodyTarget(declaration)
  const dec = { sourceLocale, collector, freeformRelPath, refName, context, bodyAt: format === 'md' ? target : null, body: '' }

  const record = {}
  if (document?.$uuid) record.$uuid = document.$uuid
  if (layout.flat) {
    const [name, def] = layout.sections[0]
    Object.assign(record, decodeRecord(def.fields, document?.[name], dec, name))
  } else {
    for (const [name, def] of layout.sections) {
      const value = document?.[name]
      if (value == null) continue
      if (def.multiple === true) {
        const list = decodeList(def, value, dec)
        if (list.length) record[name] = list
      } else {
        const data = decodeRecord(def.fields, value, dec, name)
        if (Object.keys(data).length) record[name] = data
      }
    }
  }
  // ⭐ A DISABLED ENTITY IS A DRAFT ON THE FILE SIDE. It is kept in the folder and never
  // publicly delivered, which is exactly what `draft: true` means. An enabled entity
  // carries no key and writes no `draft:`, so a record re-enabled on the backend
  // comes back without the line.
  if (document?.$disabled === true) record.draft = true

  if (format === 'json') return JSON.stringify(record, null, 2) + '\n'
  if (format === 'md') return `---\n${yaml.dump(record)}---\n${dec.body}`
  return yaml.dump(record) // yaml / yaml
}

// One record of a section, its declared fields in declared order. `sectionName` is the
// top-level section the record belongs to, so the content body can be found; null below.
function decodeRecord(fields, value, dec, sectionName) {
  const out = {}
  if (!isPlainObject(value)) return out
  for (const [key, field] of Object.entries(fields || {})) {
    const raw = value[key]
    if (raw === undefined) continue
    if (field?.type === 'section') {
      out[key] = field.multiple === true ? decodeList(field, raw, dec) : decodeRecord(field.fields, raw, dec, null)
      continue
    }
    const isBody = Boolean(dec.bodyAt) && sectionName === dec.bodyAt.section && key === dec.bodyAt.key
    const decoded = decodeLeaf(raw, field, dec, isBody)
    if (isBody) dec.body = typeof decoded === 'string' ? decoded : String(decoded ?? '')
    else out[key] = decoded
  }
  return out
}

// The records of a `many` section; a self-nesting one's `$children` nest back under
// `children:`, the reserved key the push reads them from.
function decodeList(def, value, dec) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const out = decodeRecord(def.fields, item, dec, null)
    if (def.self_nesting === true && Array.isArray(item?.$children) && item.$children.length) {
      out.children = decodeList(def, item.$children, dec)
    }
    return out
  })
}

// A leaf's authored value. A localized SCALAR's target locales are captured into the
// collector (the content body's are captured by `unwrapLocalizedContent`, with its
// free-form path); a list of localized values is unwrapped element by element.
function decodeLeaf(raw, field, dec, isBody) {
  if (field?.type === 'entity_ref') return decodeReference(raw, field, dec)
  if (isProseMirrorField(field)) {
    const sourceDoc = field.localized
      ? unwrapLocalizedContent(raw, dec.sourceLocale, dec.collector, isBody ? dec.freeformRelPath : undefined, null, dec.context)
      : raw
    return sourceDoc ? proseMirrorToMarkdown(sourceDoc) : ''
  }
  if (!field?.localized) return raw
  if (Array.isArray(raw)) {
    if (!isBody) for (const item of raw) dec.collector?.add(item, dec.context)
    return unwrapLocalizedList(raw, dec.sourceLocale)
  }
  if (!isBody) dec.collector?.add(raw, dec.context)
  return unwrapLocalized(raw, dec.sourceLocale)
}

// A reference comes back as the backend's uuid; the file names its record by handle — the
// name the site's folder gives it (`refName`), which is what a push resolves back to that
// uuid. A record the folder does not hold keeps its uuid, and a push sends it as it is.
function decodeReference(raw, field, dec) {
  const one = (v) => (typeof v === 'string' && dec.refName ? dec.refName(field.model, v) ?? v : v)
  return Array.isArray(raw) ? raw.map(one) : one(raw)
}

/**
 * Back-fill the sync response into the source files. Correlation is by **`index`**
 * — `finalized[i].index` is the 0-based position of the entity in the submitted
 * sequence, which equals the producer's `index` array order (the backend does not
 * echo `$id`). A single-record file gains the entity `$uuid` and nothing else —
 * never the returned `document` (see the ⛔ in the header). Multi-record YAML/JSON
 * files get a per-entry `$uuid` keyed by slug, and BibTeX one per cite key, grouped
 * so each file is written once.
 *
 * @param {object} params
 * @param {object[]} params.index     - the emitter's per-entity index, in submit
 *        order: `{ id, model, slug, sourceFile, format?, multiRecord?, ownId?, draft? }`.
 * @param {object[]} params.finalized - response entries `{ index, uuid, changed?, document? }`.
 *        `document` is read for one thing only: whether a record sent as a draft
 *        came back disabled.
 * @returns {{ updated: string[], unchanged: string[], deferred: object[], warnings: string[], mapped: Object<string,string>, notKeptAsDrafts: string[] }}
 *   `mapped` is own id → the uuid this backend minted, for the caller to record per backend.
 *   `notKeptAsDrafts` names records sent as drafts whose returned document is not disabled.
 */
export function backfillEntityUuids({ index, finalized }) {
  const updated = []
  const unchanged = []
  const deferred = []
  const warnings = []
  // ⭐ own id → the uuid THIS backend minted. The caller files it under the backend in
  // `sync.json::backends.<origin>.records`; this function knows no backend.
  const mapped = {}
  // Files holding only records that already carry their own id. Counted ONCE per file
  // at the end: an array-form file holds several records, and "examined, nothing
  // written" is a statement about the file, not about each record in it.
  const ownIdFiles = new Set()
  // Multi-record files are written ONCE per file, applying every (slug → uuid).
  const arrayFiles = new Map() // array-form YAML/JSON: sourceFile -> Map(slug -> uuid)
  const bibFiles = new Map() // BibTeX: sourceFile -> Map(cite key -> uuid)
  // Records sent as drafts that the backend stored enabled. See the check below.
  const notKeptAsDrafts = []

  for (const fin of finalized || []) {
    const uuid = fin.uuid
    if (!uuid) continue // nothing minted/returned to write
    const i = fin.index
    const entry = Number.isInteger(i) && i >= 0 ? (index || [])[i] : undefined
    if (!entry) {
      warnings.push(`finalized index ${i} has no matching submitted entity`)
      continue
    }
    // Skip the non-record entities: the site-content entity (its uuid is recorded in
    // sync.json by the caller, via writeSiteEntityUuid) and the folder entity
    // (no uuid to back-fill — the backend owns the site's folder, keyed by the
    // site-content uuid). Both are positional placeholders with no record source file.
    if (entry.kind === 'site' || entry.kind === 'folder') continue
    // ⛔ A DRAFT THE BACKEND DID NOT KEEP AS ONE. A backend is obliged to echo
    // `$disabled: true` on the document of an entity it stored disabled. One that predates
    // the key skips it without a word and stores the record enabled, so it is delivered
    // once the site is published. The file keeps its `draft: true` — only the uuid is
    // written — and the caller is told. Only a returned document that lacks the flag
    // counts: with no document there is nothing to judge.
    const draftNotKept = entry.draft === true && fin.document && fin.document.$disabled !== true
    if (draftNotKept) notKeptAsDrafts.push(entry.sourceFile || entry.id)
    if (!entry.sourceFile) {
      deferred.push({ index: i, id: entry.id, reason: 'no source file on disk' })
      continue
    }

    // ⭐ Every record the backend returned is mapped: own id → the uuid it minted.
    // A record new to EVERY backend has no own id yet, so the minted uuid becomes it
    // (written below) and the mapping is identity — which is exactly the behaviour
    // before identity was keyed by backend, so a single-backend project is unchanged.
    mapped[entry.ownId || uuid] = uuid

    // ⛔ A record that already carries its OWN id is NOT rewritten. Its id is stable
    // and travels with the file; this backend's uuid belongs in the map, not in the
    // author's file. And it must not be: the write below puts THIS backend's `$uuid` in
    // the file, so a second backend would silently overwrite the record's identity
    // with its own.
    if (entry.ownId) {
      ownIdFiles.add(entry.sourceFile)
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

    // The uuid, into the author's own file — never the returned document (header ⛔).
    const res = backfillUuid(entry.sourceFile, uuid)
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

  for (const file of ownIdFiles) {
    if (!updated.includes(file) && !unchanged.includes(file)) unchanged.push(file)
  }
  return { updated, unchanged, deferred, warnings, mapped, notKeptAsDrafts }
}
