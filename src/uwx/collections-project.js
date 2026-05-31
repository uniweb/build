// Collections projection — write a folder + its record entities back to the
// site's `collections/**` source files. The inverse of the collections producer
// (collections.js + folder.js): the producer reads source records and emits the
// `@uniweb/folder` entity + one section-keyed `$`-document per record; this takes
// those documents back and renders them to files.
//
// Identity & placement. A record's on-disk home is `(collection, slug)`:
//   - `slug` and `collection` come from the FOLDER document — each ref leaf is
//     `{ entry: <uuid>, path_segment: <slug> }` inside a branch whose
//     `path_segment` is the collection name (folder.js `defaultEntries`). The
//     folder is the authoritative organization on a read (the record document's
//     own `$id` envelope is not guaranteed to be echoed back), with the record
//     document's `$id` (`<collection>/<slug>`) used as a fallback when present.
//   - the collection's directory is resolved from the collections config
//     (`collections.yml`/`site.yml` `path:`), defaulting to `collections/<name>`.
//   - an existing local file carrying the same `$uuid` is re-rendered in place;
//     otherwise a new single-record file is placed at `<slug>.<ext>`, its format
//     matched to the collection's existing files, else markdown when the Model's
//     brief has a richtext field (a body), else YAML.
//
// Field rendering reuses renderEntityDocument (via writeRecordFile) — localized
// unwrap, date handling, richtext→body are already inverted there.
//
// v1 scope / deferred: array-form & BibTeX multi-record files (a pulled record is
// placed as its own single-record file; merging into an existing array file is a
// later nicety); deriving an on-disk collection from a deeply NESTED virtual
// folder org when the record carries no `$id`; and rewriting `collections.yml`'s
// `folders:` organization + synthesizing declarations for newly-introduced collections
// (only the folder `$uuid` is written here, via writeFolderUuid — the
// comment-preserving config rewrite is a separate quality bar). Nothing is
// silently dropped: an unplaceable or unresolvable record is reported.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'
import yaml from 'js-yaml'
import { parseFrontmatter } from './collection-source.js'
import { writeRecordFile } from './project-writer.js'
import { writeFolderUuid } from './folder.js'

const RICHTEXT_TYPE = 'richtext'
// Single-record source extensions we scan + place (BibTeX is multi-record → out).
const SINGLE_RECORD_EXTS = ['.md', '.yml', '.yaml', '.json']
const EXT_FOR_FORMAT = { md: '.md', yaml: '.yml', json: '.json' }

function formatForExt(ext) {
  if (ext === '.md') return 'md'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  if (ext === '.json') return 'json'
  return null
}

// Read the `$uuid` declared in a single-record source file, or null (array-form,
// unreadable, or no `$uuid`). Used to find an existing local file for a record.
function readFileUuid(filePath, format) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    if (format === 'md') return parseFrontmatter(raw).frontmatter?.$uuid ?? null
    const parsed = format === 'json' ? JSON.parse(raw) : yaml.load(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed.$uuid ?? null
  } catch {
    return null
  }
}

/**
 * Find the single-record file in `collectionDir` whose `$uuid` matches, or null.
 * @returns {{ path: string, format: 'md'|'yaml'|'json' }|null}
 */
export function findRecordFileByUuid(collectionDir, uuid) {
  if (!uuid || !existsSync(collectionDir)) return null
  for (const entry of readdirSync(collectionDir)) {
    if (entry.startsWith('_')) continue
    const format = formatForExt(extname(entry).toLowerCase())
    if (!format) continue
    const path = join(collectionDir, entry)
    if (readFileUuid(path, format) === uuid) return { path, format }
  }
  return null
}

// The format to give a NEW record file in a collection: match the collection's
// existing single-record files, else markdown when the Model's brief carries a
// richtext field (so the body has a home), else YAML.
function defaultFormat(collectionDir, declaration) {
  if (existsSync(collectionDir)) {
    for (const entry of readdirSync(collectionDir)) {
      if (entry.startsWith('_')) continue
      const format = formatForExt(extname(entry).toLowerCase())
      if (format) return format
    }
  }
  return briefHasRichtext(declaration) ? 'md' : 'yaml'
}

// Whether the declaration's brief section declares a richtext field (the md-body
// target). Mirrors the same check in backfill.js (kept local — not exported there).
function briefHasRichtext(declaration) {
  const brief = Object.values(declaration?.sections || {}).find((s) => s && s.brief === true)
  return Object.values(brief?.fields || {}).some((f) => f.type === RICHTEXT_TYPE)
}

// Build `uuid → { collection, slug }` from the folder document's ref leaves. A
// leaf sits in a branch whose `path_segment` is the collection; the leaf's
// `path_segment` is the slug and its `entry` is the record uuid. Nested branches
// are walked; the collection is the NEAREST enclosing branch segment (correct for
// the default one-branch-per-collection org; a deeply nested virtual org may
// differ — see the module header).
function indexFolder(folderDoc) {
  const byUuid = new Map()
  const walk = (entries, collection) => {
    for (const node of entries || []) {
      if (node?.kind === 'branch') {
        walk(node.entries, node.path_segment ?? collection)
      } else if (node?.kind === 'ref' && node.entry) {
        byUuid.set(node.entry, { collection, slug: node.path_segment })
      }
    }
  }
  walk(folderDoc?.entries, null)
  return byUuid
}

// Resolve a collection's directory from the collections config `path:` (already
// site-root-relative), defaulting to `collections/<name>`.
function collectionDirFor(siteRoot, collection, collectionsConfig) {
  const declPath = collectionsConfig?.declarations?.[collection]?.path
  return declPath ? resolve(siteRoot, declPath) : join(siteRoot, 'collections', collection)
}

// Resolve a record's (collection, slug): the folder index first (authoritative on
// a read), the record document's `$id` (`<collection>/<slug>`) as a fallback.
function locate(document, folderIndex) {
  const fromFolder = document.$uuid ? folderIndex.get(document.$uuid) : null
  if (fromFolder?.collection && fromFolder.slug) return fromFolder
  if (typeof document.$id === 'string' && document.$id.includes('/')) {
    const [collection, ...rest] = document.$id.split('/')
    return { collection, slug: rest.join('/') }
  }
  return fromFolder || null
}

/**
 * Project a pulled folder + its record entities to `collections/**` files.
 *
 * @param {object} params
 * @param {object} params.folderDoc   - the `@uniweb/folder` document `{ $uuid?, entries }`
 * @param {object[]} params.recordDocs - record `$`-documents `{ $uuid?, $id?, $model, <brief> }`
 * @param {string} params.siteRoot
 * @param {object} params.opts
 * @param {(modelName: string) => object|null|undefined} params.opts.resolveDeclaration
 *        - resolve a Model's data-schema declaration by name (`$model`).
 * @param {object} [params.opts.collectionsConfig] - from resolveCollectionsConfig
 *        (for `path:` overrides); optional — defaults to `collections/<name>`.
 * @param {string} [params.opts.sourceLocale]
 * @returns {{ updated: string[], placed: string[], unchanged: string[], skipped: object[], warnings: string[] }}
 */
export function collectionsToProject({ folderDoc, recordDocs = [], siteRoot, opts = {} }) {
  const { resolveDeclaration, collectionsConfig, sourceLocale = 'en' } = opts
  if (typeof resolveDeclaration !== 'function') {
    throw new Error('uwx/collections-project: opts.resolveDeclaration(modelName) is required')
  }

  const folderIndex = indexFolder(folderDoc)
  const updated = []
  const placed = []
  const unchanged = []
  const skipped = []
  const warnings = []

  for (const document of recordDocs) {
    const where = locate(document, folderIndex)
    if (!where?.collection || !where?.slug) {
      skipped.push({ uuid: document.$uuid, reason: 'no collection/slug (not in folder, no $id)' })
      continue
    }
    const declaration = document.$model ? resolveDeclaration(document.$model) : null
    if (!declaration) {
      skipped.push({ uuid: document.$uuid, slug: where.slug, reason: `unresolved model ${document.$model || '(none)'}` })
      continue
    }

    const collectionDir = collectionDirFor(siteRoot, where.collection, collectionsConfig)
    const existing = document.$uuid ? findRecordFileByUuid(collectionDir, document.$uuid) : null

    let filePath
    let format
    let isNew
    if (existing) {
      filePath = existing.path
      format = existing.format
      isNew = false
    } else {
      format = defaultFormat(collectionDir, declaration)
      filePath = join(collectionDir, where.slug + EXT_FOR_FORMAT[format])
      isNew = true
    }

    let status
    try {
      status = writeRecordFile({ filePath, document, declaration, format, sourceLocale })
    } catch (err) {
      warnings.push(`${where.collection}/${where.slug}: ${err.message}`)
      continue
    }
    if (status === 'unchanged') unchanged.push(filePath)
    else if (isNew) placed.push(filePath)
    else updated.push(filePath)
  }

  // Write the folder identity into collections.yml (idempotent, comment-preserving
  // top-level scalar). The virtual `folders:` org + declarations for newly-
  // introduced collections are a later, comment-sensitive rewrite (header).
  if (folderDoc?.$uuid) writeFolderUuid(siteRoot, folderDoc.$uuid)

  return { updated, placed, unchanged, skipped, warnings }
}
