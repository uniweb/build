// Collections projection — write a folder + its record entities back to the
// site's `collections/**` source files. The inverse of the collections producer
// (collections.js + folder.js): the producer reads source records and emits the
// `@uniweb/folder` entity + one section-keyed `$`-document per record; this takes
// those documents back and renders them to files.
//
// Identity & placement. A record's on-disk home is `(collection, slug)`:
//   - `slug` and `collection` come from the FOLDER document — each ref leaf is
//     `{ entry: { model, entity: <uuid> }, path_segment: <slug> }` inside a branch
//     (its `$children`) whose `path_segment` is the collection name (folder.js
//     `defaultContents`). The
//     folder is the authoritative organization on a read (the record document's
//     own `$id` envelope is not guaranteed to be echoed back), with the record
//     document's `$id` (`<collection>/<slug>`) used as a fallback when present.
//   - the collection's directory is resolved from the collections config
//     (`collections.yml`/`site.yml` `path:`), defaulting to `collections/<name>`.
//   - an existing local file carrying the same `$uuid` is re-rendered in place;
//     otherwise a new single-record file is placed at `<slug>.<ext>`, its format
//     matched to the collection's existing files, else markdown when the Model's
//     brief has a content body field, else YAML.
//
// Field rendering reuses renderEntityDocument (via writeRecordFile) — localized
// unwrap, date handling, content-body→body are already inverted there.
//
// v1 scope / deferred: array-form & BibTeX multi-record files (a pulled record is
// placed as its own single-record file; merging into an existing array file is a
// later nicety); deriving an on-disk collection from a deeply NESTED virtual
// folder org when the record carries no `$id`; and rewriting `collections.yml`'s
// `folders:` organization + synthesizing declarations for newly-introduced collections
// (a comment-preserving config rewrite is a separate quality bar). The folder itself
// carries no `$uuid` — the backend owns it, keyed by the site-content uuid — so
// nothing is written into `collections.yml` here. Nothing is silently dropped: an
// unplaceable or unresolvable record is reported.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, relative, extname, basename, sep } from 'node:path'
import yaml from 'js-yaml'
import { parseFrontmatter } from './collection-source.js'
import { writeRecordFile, writeQueriesConfig, writeRecordsConfig } from './project-writer.js'
import { defaultSchema, deferredFromSchema, foundationDataSchemas } from './collections-config.js'
import { poolDirsForSchema, ENTITIES_DIR } from '../site/entity-pool.js'
import { isContentBodyField } from './data-schema.js'
import { createTranslationCollector, writeLocaleTranslations, writeFreeformTranslations } from './locale-sync.js'
import { buildFreeformCollectionPath } from '../i18n/freeform.js'

// Single-record source extensions we scan + place (BibTeX is multi-record → out).
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
// content body field (so the body has a home), else YAML.
function defaultFormat(collectionDir, declaration) {
  if (existsSync(collectionDir)) {
    for (const entry of readdirSync(collectionDir)) {
      if (entry.startsWith('_')) continue
      const format = formatForExt(extname(entry).toLowerCase())
      if (format) return format
    }
  }
  return briefHasContentBody(declaration) ? 'md' : 'yaml'
}

// Whether the declaration's brief section declares a content body field — a markup
// `text` field or a `format: prosemirror` json field (the md-body target).
function briefHasContentBody(declaration) {
  const brief = Object.values(declaration?.sections || {}).find((s) => s && s.brief === true)
  return Object.values(brief?.fields || {}).some((f) => isContentBodyField(f))
}

// Build `uuid → { collection, slug }` from the folder document's ref leaves. The
// folder is a self-nesting tree under `contents`, nesting via `$children` (the
// site-content invariant — folder.js). A leaf sits in a branch whose
// `path_segment` is the collection; the leaf's `path_segment` is the slug and its
// `entry` is the entity_ref open form `{ model, entity: <uuid> }`. Nested branches
// are walked; the collection is the NEAREST enclosing branch segment (correct for
// the default one-branch-per-collection org; a deeply nested virtual org may
// differ — see the module header).
function indexFolder(folderDoc) {
  const byUuid = new Map()
  const walk = (nodes, collection) => {
    for (const node of nodes || []) {
      if (node?.kind === 'branch') {
        walk(node.$children, node.path_segment ?? collection)
      } else if (node?.kind === 'ref' && node.entry) {
        // `entry` is `{ model, entity: <uuid> }`; tolerate a bare uuid defensively.
        const uuid = typeof node.entry === 'object' ? node.entry.entity : node.entry
        if (uuid) byUuid.set(uuid, { collection, slug: node.path_segment })
      }
    }
  }
  walk(folderDoc?.contents, null)
  return byUuid
}

// Where a pulled record is written: the pool folder its MODEL names.
//
// ⛔ NOT THE QUERY'S DIRECTORY — a query has none. A record's home is decided by
// what it IS, and `entities/{schema}/` is the one place a thing of that model
// lives. That is also why the placement survives a query being renamed, added or
// deleted, none of which is a fact about the record.
//
// ⚠️ Derived by `poolDirsForSchema`, the exact inverse of the reader's
// `schemaForPoolDirs`, and deliberately not a second rule: if the two disagreed,
// a pulled record would land somewhere the next build reads as a different
// schema — silently, because both paths are well-formed.
function recordDirFor(siteRoot, model, selfOrg) {
  const dirs = poolDirsForSchema(unresolveSelfScope(model, selfOrg))
  return dirs ? join(siteRoot, ENTITIES_DIR, ...dirs) : null
}

/**
 * Undo the self-scope resolution the producer applies before shipping.
 *
 * ⛔ WITHOUT THIS THE ROUND TRIP IS NOT A FIXED POINT, and the failure is silent
 * on both ends. `@/article` is a FOUNDATION-RELATIVE alias: the producer resolves
 * it to `@acme/article` before it ships, because the backend resolves Models by
 * name and never mints. So a record authored under `entities/article/` comes back
 * as `@acme/article` and, placed literally, lands under `entities/acme/article/` —
 * a different schema folder, which the next build reads as a different schema.
 *
 * ⚠️ It did not show before records were placed by their model: every record went
 * to `collections/<collection>/` regardless, so the resolution had nowhere to leak.
 *
 * ⭐ The site records its own org at create (`site.yml::$org` — "whose this is"),
 * which is exactly the inverse. A model scoped to ANOTHER org is left alone: it
 * genuinely is that org's, and `@/` would be a lie.
 */
export function unresolveSelfScope(model, selfOrg) {
  if (typeof model !== 'string' || !selfOrg) return model
  const org = String(selfOrg).replace(/^@/, '').replace(/\/.*$/, '')
  if (!org) return model
  return model.startsWith(`@${org}/`) ? `@/${model.slice(org.length + 2)}` : model
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

/** `site.yml::$org`, bare (`acme`), or null. Stored bare — see `writeSiteOrg`. */
function readSiteOrg(siteRoot) {
  try {
    const y = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8')) || {}
    return typeof y.$org === 'string' && y.$org ? y.$org : null
  } catch {
    return null
  }
}

// Skip undefined when copying optional fields into a projected declaration.
function setIf(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

// Invert one wire declaration (`collectionsNested` output) back to its file-side
// shape. Returns `{ name, decl }`.
//
//  - `path:` is written VERBATIM, and omitted entirely when it equals the default
//    (the query's own name under the pool).
//  - `url:` (remote source) and a bare `source:` object are carried as-is.
//  - `schema:` is dropped when it only restates the query-name convention default,
//    so a terse author file stays terse.
//
// ⛔ THE `collections/`-PREFIX STRIP AND THE site.yml ROUTING ARE BOTH GONE, and
// they went together. They existed because `collections.yml` sat INSIDE
// `collections/` and so could not express a path outside it: a path elsewhere had
// to be sent back to `site.yml` to survive the round trip. `queries.yml` is at the
// site root and its `path:` is site-root-relative, so there is one home and no
// path it cannot state. ⚠️ Leaving the strip in place would have written
// `path: items` for a source path `collections/items`, which the reader then
// resolves as `items` — a round trip that silently relocates a query's pool.
// Wire keys `declToFileShape` consumes explicitly — mapped, renamed, or folded into
// the file-side `path`/`url`. `$id`/`$uuid`/`name` are identity, not content.
const DECL_WIRE_CONSUMED = new Set([
  'name',
  '$id',
  '$uuid',
  'source',
  'schema',
  'sort',
  'where',
  'limit',
  'excerpt',
  'deferred',
  'detail_url',
  'queryable'
])

// Is this wire `deferred` exactly what the schema's brief would have derived? Compared
// as an ORDER-INSENSITIVE set: the deriver walks `flatRecordFields`, and a round trip
// through YAML and the store is not obliged to preserve that order. Comparing as a list
// would classify a reordered-but-identical value as authored, and persist it.
function isDerivedDeferred(d, dataSchemas) {
  if (!dataSchemas || !Array.isArray(d.deferred)) return false
  const derived = deferredFromSchema(dataSchemas[d.schema])
  if (!derived || derived.length !== d.deferred.length) return false
  const a = new Set(derived)
  return d.deferred.every((f) => a.has(f))
}

function declToFileShape(d, dataSchemas = null) {
  const name = d.name || d.$id
  const decl = {}

  const source = d.source || {}
  if (typeof source.url === 'string') {
    decl.url = source.url
  } else if (typeof source.path === 'string') {
    // ⛔ A FILE-BASED QUERY HAS NO PATH TO WRITE BACK. `entities/{schema}/` is the
    // pool and `schema:` addresses it, so a `path` arriving on the wire is either
    // stale storage or something only a remote source could have meant. Dropping
    // it keeps the author's file saying what the build actually reads.
    decl.path = source.path
  } else if (source && typeof source === 'object' && Object.keys(source).length > 0) {
    decl.source = source
  }

  if (d.schema && d.schema !== defaultSchema(name)) decl.schema = d.schema
  setIf(decl, 'sort', d.sort)
  setIf(decl, 'where', d.where)
  setIf(decl, 'limit', d.limit)
  setIf(decl, 'excerpt', d.excerpt)
  // ⛔ DO NOT WRITE A DERIVATION INTO THE AUTHOR'S FILE. `deferred:` is derived from
  // the schema's brief when unstated (`collections-config.js::deriveDeferredFromSchemas`)
  // — framework's own test opens with "derived from a collection's data schema, NOT
  // written by hand". But the deriver mutates the declaration in place, so by the time
  // it reaches the wire an emitted `deferred` is indistinguishable from an authored one.
  //
  // ⚠️ Measured 2026-08-29: one push + one pull turned an unstated `deferred:` into a
  // hardcoded list in `collections.yml` — a DIFFERENT file, at HIGHER precedence than
  // the `site.yml` the collection was declared in. The collection then stopped tracking
  // its schema's brief permanently, and nothing reported it.
  //
  // ⭐ This is exactly what the `schema` line above already does: emit on push (the
  // backend needs the effective value), drop on pull when it merely restates what would
  // be derived, so a terse author file stays terse and keeps tracking its schema.
  //
  // ⚖️ Only an EQUAL value is dropped. An author who deliberately writes a narrower or
  // wider `deferred:` than the brief implies has expressed intent, and that survives.
  if (d.deferred !== undefined && !isDerivedDeferred(d, dataSchemas)) {
    decl.deferred = d.deferred
  }
  // wire `detail_url` → file-side `detailUrl` (the key the producer reads).
  if (d.detail_url !== undefined) decl.detailUrl = d.detail_url
  setIf(decl, 'queryable', d.queryable)

  // ⛔ PRESERVE WHAT WE DO NOT MODEL — the pull half of the same rule the emitter
  // follows (`site.js::collectionsNested`). A wire field this function has not been
  // taught is dropped here and then absent on the next push, where the backend's
  // wholesale `data` replace destroys it. Two allowlists facing each other make the
  // round trip lossy in BOTH directions with nothing reporting it.
  //
  // An unknown WIRE key is safe to keep verbatim: unlike the push direction there is
  // no framework-local vocabulary to filter out, because everything here came off the
  // backend's Model.
  for (const [key, value] of Object.entries(d)) {
    if (value === undefined || DECL_WIRE_CONSUMED.has(key)) continue
    decl[key] = value
  }

  return { name, decl }
}

/**
 * Project the QUERY declarations carried in a site-content document
 * (`document.collections`, the inverse of site.js `collectionsNested`) back to
 * `queries.yml` — the one home. Untouched queries are preserved via the
 * shallow-merge writer. The record FILES are written elsewhere
 * (collectionsToProject); this is only the declaration config.
 *
 * Idempotent and non-destructive: with no declarations it writes nothing (so a
 * pull that doesn't carry collections never clobbers a hand-authored file).
 *
 * @param {object} params
 * @param {object} params.document - a site-content `$`-document (`{ collections }`)
 * @param {string} params.siteRoot
 * @returns {{ collections?: 'updated'|'unchanged' }}
 */
export function declarationsToCollectionsYml({ document, siteRoot }) {
  const decls = Array.isArray(document?.collections) ? document.collections : []
  const report = {}
  if (decls.length === 0) return report

  // The foundation's data schemas, loaded ONCE for the whole projection — they are what
  // lets `declToFileShape` tell a derived `deferred:` from an authored one. Absent (no
  // foundation on disk, unbuilt, unresolvable) the inverter simply never fires and every
  // `deferred` is treated as authored: the pre-2026-08-29 behaviour, which is the safe
  // direction to fail — persisting a value that did not need persisting loses nothing,
  // where dropping an AUTHORED one would.
  let siteYml = null
  try {
    siteYml = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8')) || null
  } catch {
    siteYml = null
  }
  const dataSchemas = siteYml ? foundationDataSchemas(siteRoot, siteYml) : null

  const queries = {}
  for (const d of decls) {
    const { name, decl } = declToFileShape(d, dataSchemas)
    if (!name) continue
    queries[name] = decl
  }

  if (Object.keys(queries).length > 0) {
    report.collections = writeQueriesConfig(siteRoot, queries)
  }
  return report
}

/**
 * Project a pulled `@uniweb/folder` document back to `records.yml`.
 *
 * ⭐ THE FOLDER IS THE ONE THING THAT ROUND-TRIPS TRIVIALLY, and that is by design
 * rather than luck: `records.yml` holds concrete refs on both sides, so there is
 * nothing to invert. The old shape put QUERY MACROS in the folder — a virtual
 * `folders:` tree naming collections — and inverting a macro is not possible in
 * general, which is why rewriting it stayed deferred for as long as it existed.
 * Taking queries out of the folder is what dissolved that.
 *
 * ⛔ AN EMPTY RESULT IS NOT WRITTEN. An empty `records.yml` means "the folder holds
 * nothing" and REMOVES on the next push, so a pull that carried no folder — or one
 * whose leaves could not be placed — must leave the file alone rather than author
 * the destructive state on the author's behalf.
 *
 * @param {object} params
 * @param {object} params.folderDoc - the stored `@uniweb/folder` document
 * @param {string} params.siteRoot
 * @param {Map<string,string>} params.poolPathByUuid - record `$uuid` → the path
 *        under `entities/` of the file just written for it. Supplied by
 *        `collectionsToProject`, which is the only thing that knows the extension
 *        each record landed with.
 * @returns {{ status: 'updated'|'unchanged'|'skipped', entries: Array, warnings: string[] }}
 */
export function folderToRecordsYml({ folderDoc, siteRoot, poolPathByUuid }) {
  const warnings = []

  const walk = (nodes) => {
    const out = []
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue
      if (node.kind === 'branch') {
        const entry = { folder: node.path_segment }
        // Only a BRANCH takes a label. A record carries its own title; the folder
        // does not caption its rows.
        if (node.name !== undefined) entry.label = node.name
        entry.records = walk(node.$children)
        out.push(entry)
        continue
      }
      const uuid = node.entry?.entity ?? node.entry
      const rel = typeof uuid === 'string' ? poolPathByUuid.get(uuid) : null
      if (!rel) {
        // ⚠️ Reported, never dropped in silence. A leaf whose record did not land
        // means the folder and the pool disagree, and writing the file without it
        // would quietly unpublish that record on the next push.
        warnings.push(
          `records.yml: a folder leaf ("${node.path_segment ?? '?'}") references a record that ` +
            `was not written locally — the file was left unchanged rather than dropping it.`
        )
        return null
      }
      out.push(rel)
    }
    return out
  }

  const entries = walk(folderDoc?.contents)
  if (entries === null) return { status: 'skipped', entries: [], warnings }
  if (entries.length === 0) return { status: 'skipped', entries: [], warnings }
  return { status: writeRecordsConfig(siteRoot, entries), entries, warnings }
}

/**
 * Project a pulled folder + its record entities to `entities/**` files.
 *
 * @param {object} params
 * @param {object} params.folderDoc   - the `@uniweb/folder` document `{ contents }` (no `$uuid`)
 * @param {object[]} params.recordDocs - record `$`-documents `{ $uuid?, $id?, $model, <brief> }`
 * @param {string} params.siteRoot
 * @param {object} params.opts
 * @param {(modelName: string) => object|null|undefined} params.opts.resolveDeclaration
 *        - resolve a Model's data-schema declaration by name (`$model`).
 * @param {string} [params.opts.org] - the site's own org, so a `@org/x` model the
 *        producer resolved from `@/x` is placed back where the author wrote it.
 *        Defaults to `site.yml::$org`.
 * @param {string} [params.opts.sourceLocale]
 * @returns {{ updated: string[], placed: string[], unchanged: string[], skipped: object[], warnings: string[], locales: object }}
 */
export function collectionsToProject({ folderDoc, recordDocs = [], siteRoot, opts = {} }) {
  const { resolveDeclaration, sourceLocale = 'en' } = opts
  // The site's own org, so a `@org/x` model the producer resolved from `@/x` is
  // placed back where the author wrote it. Read from `site.yml::$org` unless the
  // caller already has it.
  const selfOrg = opts.org ?? readSiteOrg(siteRoot)
  if (typeof resolveDeclaration !== 'function') {
    throw new Error('uwx/collections-project: opts.resolveDeclaration(modelName) is required')
  }

  const folderIndex = indexFolder(folderDoc)
  // Captures target-locale translations of localized record fields: SCALARs →
  // locales/collections/{locale}.json (structural maps too), and a prosemirror
  // BODY's free-form per-locale override → locales/freeform/{locale}/collections/.
  const collector = createTranslationCollector(sourceLocale)
  const updated = []
  const placed = []
  const unchanged = []
  const skipped = []
  const warnings = []
  // uuid → the path under `entities/` the record landed at. Only this loop knows
  // the extension each one got, so `records.yml` is written from it rather than
  // re-derived (a second rule could pick a different extension and the folder
  // would name a file that is not there).
  const poolPathByUuid = new Map()

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

    const collectionDir = recordDirFor(siteRoot, document.$model, selfOrg)
    if (!collectionDir) {
      skipped.push({
        uuid: document.$uuid,
        slug: where.slug,
        reason: `model ${document.$model} names no pool folder (expected @/name or @org/name)`,
      })
      continue
    }
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

    // The free-form home for this record's content body (locale-independent); a
    // target-locale full-doc body is written under locales/freeform/{locale}/here.
    const freeformRelPath = buildFreeformCollectionPath(document.$model, where.slug)

    let status
    try {
      status = writeRecordFile({ filePath, document, declaration, format, sourceLocale, collector, freeformRelPath })
    } catch (err) {
      warnings.push(`${where.collection}/${where.slug}: ${err.message}`)
      continue
    }
    if (status === 'unchanged') unchanged.push(filePath)
    else if (isNew) placed.push(filePath)
    else updated.push(filePath)
    if (document.$uuid) {
      poolPathByUuid.set(document.$uuid, relative(join(siteRoot, ENTITIES_DIR), filePath).split(sep).join('/'))
    }
  }

  // ⭐ THE FOLDER ITSELF, written back as `records.yml`. Steps that only touched the
  // READ path would leave every pull authoring the old shape — the site would build
  // from the new layout and be projected back into the one it replaced.
  //
  // The folder ENTITY still carries no `$uuid` we persist: the backend owns the
  // site's folder, keyed by the site-content uuid.
  const records = folderToRecordsYml({ folderDoc, siteRoot, poolPathByUuid })
  warnings.push(...records.warnings)

  // Flush localized record-field translations to locales/collections/{locale}.json,
  // and any prosemirror free-form body overrides to locales/freeform/{locale}/.
  const locales = writeLocaleTranslations(siteRoot, collector.byLocale, 'collections')
  const freeform = writeFreeformTranslations(siteRoot, collector.freeformPending)

  return { updated, placed, unchanged, skipped, warnings, locales, freeform, records: records.status }
}
