// Records projection — write a pulled folder and its records back to the site's
// `records/**` files and the folder's organization, `records/folder.yml`. The
// inverse of the producer (`records.js` + `folder.js`): the producer reads the
// records directory and emits the `@uniweb/folder` entity + one section-keyed
// `$`-document per record; this takes those documents back and renders them to files.
//
// Identity & placement:
//   - a record's slug comes from the FOLDER document — each ref leaf is
//     `{ entry: { schema, entity: <uuid> }, name: <slug> }`, at the top of the folder
//     or inside a branch (its `$children`) whose `name` names the sub-folder. The
//     folder is the authoritative organization on a read (the record document's own
//     `$id` envelope is not guaranteed to be echoed back), with the record
//     document's `$id` (its position in the directory) as a fallback when present.
//   - the record's directory comes from its data schema (`$schema`, read by
//     `documentSchema`) — `records/{schema}/` is where
//     a record of that model lives (`site.yml::paths.records` moves it). Not from any
//     query: a query has no directory, and which query selects a record is not a
//     fact about it.
//   - an existing local file carrying the same `$uuid` is re-rendered in place;
//     otherwise a new single-record file is placed at `<slug>.<ext>`, its format
//     matched to the schema folder's existing files, else markdown when the Model's
//     brief has a content body field, else YAML.
//
// Field rendering reuses renderEntityDocument (via writeRecordFile) — localized
// unwrap, date handling, content-body→body are already inverted there. Asset paths
// are restored before it runs (`restoreAssetRefs`), as the content lane does.
//
// Deferred: array-form & BibTeX multi-record files (a pulled record is placed as
// its own single-record file; merging into an existing array file is a later
// nicety). The folder itself carries no `$uuid` — the backend owns it, keyed by the
// site-content uuid. Nothing is silently dropped: an unplaceable or unresolvable
// record is reported.

import { readBackendState, updateBackendMap } from './sync-store.js'
import { restoreAssetRefs } from './asset-map.js'
import { documentSchema } from './entity-document.js'
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve, relative, extname, basename, sep } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { parseFrontmatter } from './entity-source.js'
import { writeRecordFile, writeQueriesConfig, writeRecordsConfig } from './project-writer.js'
import { defaultSchema, deferredFromSchema, foundationDataSchemas } from './queries-config.js'
import { poolDirsForSchema, resolveRecordsDir } from '../site/entity-pool.js'
import { folderYmlPath } from '../site/records-config.js'
import { isContentBodyField } from './data-schema.js'
import { unresolveSelfScope, refuseOrgOption } from './self-scope.js'
import { parseCatalogRef } from '../site/foundation-ref.js'
import { unwrapLocalized } from './backfill.js'
import { createTranslationCollector, writeLocaleTranslations, writeFreeformTranslations } from './locale-sync.js'
import { buildFreeformRecordPath } from '../i18n/freeform.js'

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
    if (format === 'md') return parseFrontmatter(raw, filePath).frontmatter?.$uuid ?? null
    const parsed = format === 'json' ? JSON.parse(raw) : yaml.load(raw, YAML_OPTIONS)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed.$uuid ?? null
  } catch {
    return null
  }
}

/**
 * Find the single-record file in `poolDir` whose `$uuid` matches, or null.
 * @returns {{ path: string, format: 'md'|'yaml'|'json' }|null}
 */
export function findRecordFileByUuid(poolDir, uuid) {
  if (!uuid || !existsSync(poolDir)) return null
  for (const entry of readdirSync(poolDir)) {
    if (entry.startsWith('_')) continue
    const format = formatForExt(extname(entry).toLowerCase())
    if (!format) continue
    const path = join(poolDir, entry)
    if (readFileUuid(path, format) === uuid) return { path, format }
  }
  return null
}

// The format to give a NEW record file in a collection: match the collection's
// existing single-record files, else markdown when the Model's brief carries a
// content body field (so the body has a home), else YAML.
function defaultFormat(poolDir, declaration) {
  if (existsSync(poolDir)) {
    for (const entry of readdirSync(poolDir)) {
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
// site-content invariant — folder.js). A leaf sits in a branch whose `name` is
// the collection; the leaf's `name` is the slug (the handle) and its `entry` is
// the entity_ref open form `{ schema, entity: <uuid> }`. ⛔ `path_segment` is not
// read: the store renamed it on 2026-09-04 and a pull emits the new shape only —
// a reader that kept the old key would index every record as
// `{ folderPath: null, slug: undefined }` and rewrite records.yml with
// `folder: undefined` branches (measured on this reader, 2026-09-04). Nested branches
// are walked; the collection is the NEAREST enclosing branch segment (correct for
// the default one-branch-per-collection org; a deeply nested virtual org may
// differ — see the module header).
function indexFolder(folderDoc) {
  const byUuid = new Map()
  const walk = (nodes, folderPath) => {
    for (const node of nodes || []) {
      if (node?.kind === 'branch') {
        walk(node.$children, node.name ?? folderPath)
      } else if (node?.kind === 'ref' && node.entry) {
        // `entry` is `{ schema, entity: <uuid> }`; tolerate a bare uuid defensively.
        const uuid = typeof node.entry === 'object' ? node.entry.entity : node.entry
        if (uuid) byUuid.set(uuid, { folderPath, slug: node.name })
      }
    }
  }
  walk(folderDoc?.contents, null)
  return byUuid
}

// Where a pulled record is written: the pool folder its MODEL names.
//
// ⛔ NOT THE QUERY'S DIRECTORY — a query has none. A record's home is decided by
// what it IS, and `records/{schema}/` is the one place a record of that model
// lives. That is also why the placement survives a query being renamed, added or
// deleted, none of which is a fact about the record.
//
// ⚠️ Derived by `poolDirsForSchema`, the exact inverse of the reader's
// `schemaForPoolDirs`, and deliberately not a second rule: if the two disagreed,
// a pulled record would land somewhere the next build reads as a different
// schema — silently, because both paths are well-formed.
function recordDirFor(recordsRoot, model, scope) {
  const dirs = poolDirsForSchema(unresolveSelfScope(model, scope))
  return dirs ? join(recordsRoot, ...dirs) : null
}

// ⚠️ Undoing the producer's self-scope resolution (`unresolveSelfScope`) lives in
// `./self-scope.js`, beside the forward rule it inverts. It did not show before
// records were placed by their model: every record went to
// `collections/<collection>/` regardless, so the resolution had nowhere to leak.

// Resolve a record's (collection, slug): the folder index first (authoritative on
// a read), the record document's `$id` (`<collection>/<slug>`) as a fallback.
function locate(document, folderIndex) {
  const fromFolder = document.$uuid ? folderIndex.get(document.$uuid) : null
  if (fromFolder?.slug) return fromFolder
  if (typeof document.$id === 'string' && document.$id.includes('/')) {
    const parts = document.$id.split('/')
    return { folderPath: parts.slice(0, -1).join('/'), slug: parts[parts.length - 1] }
  }
  return fromFolder || null
}

// Skip undefined when copying optional fields into a projected declaration.
function setIf(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

// Invert one wire declaration (`queriesNested` output) back to its file-side
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
// ⛔ `detail_url` and `detail` are consumed and never written back: both are retired on a
// query and the build refuses them, so a pull that restored a stored one would hand the
// author a file that does not build. (`detail:` was pushed as an unmodelled field until
// 2026-09-14, so a store can hold it.)
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
  'detail',
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

function declToFileShape(wire, dataSchemas = null, scope = null) {
  // ⛔ UNDO THE PRODUCER'S QUALIFICATION FIRST, before anything compares against
  // `schema`. The push qualifies a foundation-relative `@/x` to `@scope/x`
  // (`site.js::queriesNested`), and both checks below are keyed by the author's
  // `@/x`: against `@scope/x` the query-name default would never match — writing an
  // explicit schema the author never had — and the derived-`deferred` lookup would
  // miss, persisting a derivation into their file (the 2026-08-29 defect).
  const d = scope && typeof wire.schema === 'string'
    ? { ...wire, schema: unresolveSelfScope(wire.schema, scope) }
    : wire
  const name = d.name || d.$id
  const decl = {}

  const source = d.source || {}
  if (typeof source.url === 'string') {
    // ⭐ An external query's source, whole — the inverse of `site.js::externalSource`.
    decl.url = source.url
    setIf(decl, 'method', source.method)
    setIf(decl, 'body', source.body)
    setIf(decl, 'transform', source.transform)
    setIf(decl, 'record', source.record)
  } else if (typeof source.path === 'string') {
    // ⛔ A FILE-BASED QUERY HAS NO PATH TO WRITE BACK. `records/{schema}/` holds its
    // records and `schema:` addresses them, so a `path` arriving on the wire is either
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
  // ⛔ A stored `detail_url` is not written back: `detailUrl:` is retired (2026-09-13)
  // and the build refuses it — its case is `record.url` on an external query.
  setIf(decl, 'queryable', d.queryable)

  // ⛔ PRESERVE WHAT WE DO NOT MODEL — the pull half of the same rule the emitter
  // follows (`site.js::queriesNested`). A wire field this function has not been
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
 * (`document.queries`, the inverse of site.js `queriesNested`) back to
 * `queries.yml` — the one home. Untouched queries are preserved via the
 * shallow-merge writer. The record FILES are written elsewhere
 * (recordsToProject); this is only the declaration config.
 *
 * Idempotent and non-destructive: with no declarations it writes nothing (so a
 * pull that doesn't carry collections never clobbers a hand-authored file).
 *
 * @param {object} params
 * @param {object} params.document - a site-content `$`-document (`{ queries }`)
 * @param {string} params.siteRoot
 * @param {string|null} [params.scope] - the scope the push qualified a `schema` from
 *        `@/x` with — the site's foundation's — so it is written back as `@/x`.
 *        Defaults to the scope of the foundation ref the pulled document carries
 *        (`info.foundation`, the pinned `@org/name@version`), which is that scope.
 * @returns {{ collections?: 'updated'|'unchanged' }}
 */
export function declarationsToQueriesYml({ document, siteRoot, scope, ...rest }) {
  refuseOrgOption(rest, 'declarationsToQueriesYml')
  const decls = Array.isArray(document?.queries) ? document.queries : []
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
    siteYml = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8'), YAML_OPTIONS) || null
  } catch {
    siteYml = null
  }
  const dataSchemas = siteYml ? foundationDataSchemas(siteRoot, siteYml) : null
  const selfScope =
    scope !== undefined ? scope : (parseCatalogRef(document?.info?.foundation)?.scope ?? null)

  const queries = {}
  for (const d of decls) {
    const { name, decl } = declToFileShape(d, dataSchemas, selfScope)
    if (!name) continue
    queries[name] = decl
  }

  if (Object.keys(queries).length > 0) {
    report.queries = writeQueriesConfig(siteRoot, queries)
  }
  return report
}

/**
 * Project a pulled `@uniweb/folder` document back to `folder.yml` in the records
 * directory (`records/folder.yml`, or under `site.yml::paths.records`).
 *
 * ⭐ THE FOLDER ROUND-TRIPS TRIVIALLY, and that is by design rather than luck:
 * `folder.yml` holds concrete paths on both sides, so there is nothing to invert.
 * The old shape put QUERY MACROS in the folder — a virtual `folders:` tree naming
 * collections — and inverting a macro is not possible in general. Taking queries
 * out of the folder is what dissolved that.
 *
 * ⭐ ONLY THE SUB-FOLDERS ARE WRITTEN (ruled 2026-09-21 [Diego]). A record at the
 * top of the folder needs no line — being in the records directory is what puts it
 * there — so `folder.yml` carries the branches and the records placed in them, and
 * a folder with no branches is a site with no `folder.yml`: a local one is REMOVED
 * (it could only describe sub-folders the backend's folder no longer has). No state
 * of the file removes a record, so this cannot empty anything.
 *
 * ⛔ A PULL THAT CARRIED NO FOLDER, or one with a placed record that was not written
 * locally, leaves the file alone: it has nothing true to write.
 *
 * @param {object} params
 * @param {object} params.folderDoc - the stored `@uniweb/folder` document
 * @param {string} params.siteRoot
 * @param {Map<string,string>} params.poolPathByUuid - record `$uuid` → the path
 *        under `records/` of the file just written for it. Supplied by
 *        `recordsToProject`, which is the only thing that knows the extension
 *        each record landed with.
 * @returns {{ status: 'updated'|'unchanged'|'removed'|'skipped', entries: Array, warnings: string[], file: string }}
 *   `file` is where the organization lives, as the author would write it
 */
export function folderToFolderYml({ folderDoc, siteRoot, poolPathByUuid, sourceLocale = 'en' }) {
  const warnings = []
  const { abs, rel: file } = folderYmlPath(siteRoot)
  if (!folderDoc) return { status: 'skipped', entries: [], warnings, file }
  let unplaceable = false

  const walk = (nodes, inBranch) => {
    const out = []
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue
      if (node.kind === 'branch') {
        const entry = { folder: node.name }
        // Only a BRANCH takes a label. A record carries its own title; the folder
        // does not caption its rows. On the wire the label is a localized map;
        // folder.yml carries the source-locale string (a bare string passes).
        if (node.label !== undefined) entry.label = unwrapLocalized(node.label, sourceLocale)
        entry.records = walk(node.$children, true)
        out.push(entry)
        continue
      }
      const uuid = node.entry?.entity ?? node.entry
      const rel = typeof uuid === 'string' ? poolPathByUuid.get(uuid) : null
      // A record at the top of the folder needs no line — but one that did not land
      // is still said: the next push sends the folder the directory holds, which
      // would not have it.
      if (!inBranch) {
        if (!rel) {
          warnings.push(
            `the folder holds a record ("${node.name ?? '?'}") that was not written locally — ` +
              `a push from here would remove it from the folder.`
          )
        }
        continue
      }
      if (!rel) {
        // ⚠️ Reported, never dropped in silence. A placed record that did not land
        // means the folder and the directory disagree, and writing the file without
        // it would move that record to the top of the folder on the next push.
        warnings.push(
          `${file}: the folder places a record ("${node.name ?? '?'}") that was not ` +
            `written locally — the file was left unchanged rather than dropping it.`
        )
        unplaceable = true
        continue
      }
      out.push(rel)
    }
    return out
  }

  const entries = walk(folderDoc.contents, false)
  if (unplaceable) return { status: 'skipped', entries: [], warnings, file }
  if (entries.length === 0) {
    if (!existsSync(abs)) return { status: 'unchanged', entries, warnings, file }
    unlinkSync(abs)
    return { status: 'removed', entries, warnings, file }
  }
  return { status: writeRecordsConfig(siteRoot, entries), entries, warnings, file }
}

/**
 * Project a pulled folder + its record entities to `records/**` files.
 *
 * @param {object} params
 * @param {object} params.folderDoc   - the `@uniweb/folder` document `{ contents }` (no `$uuid`)
 * @param {object[]} params.recordDocs - record `$`-documents `{ $uuid?, $id?, $schema, <brief> }`
 * @param {string} params.siteRoot
 * @param {object} params.opts
 * @param {(modelName: string) => object|null|undefined} params.opts.resolveDeclaration
 *        - resolve a data schema's declaration by its scoped name (`documentSchema`).
 * @param {string|null} [params.opts.scope] - the scope the push qualified a record's
 *        `@/x` Model with — the site's foundation's — so a `@scope/x` model is placed
 *        back where the author wrote it. The caller resolves it up front, as it does
 *        Models (`siteSelfScope`); absent, a model is placed under its own scope.
 * @param {string} [params.opts.backend] - whose record map to read and extend
 * @param {string} [params.opts.sourceLocale]
 * @returns {{ updated: string[], placed: string[], unchanged: string[], skipped: object[], warnings: string[], locales: object }}
 */
export function recordsToProject({ folderDoc, recordDocs = [], siteRoot, opts = {} }) {
  const { resolveDeclaration, sourceLocale = 'en' } = opts
  refuseOrgOption(opts, 'recordsToProject')
  // The scope the push qualified `@/x` with — the site's foundation's — so a
  // `@scope/x` model is placed back where the author wrote it. ⛔ It was the site
  // owner's org, read from `sync.json`, until 2026-09-22 (`self-scope.js`).
  const selfScope = opts.scope ?? null
  if (typeof resolveDeclaration !== 'function') {
    throw new Error('uwx/records-project: opts.resolveDeclaration(modelName) is required')
  }

  const folderIndex = indexFolder(folderDoc)
  // Where records land — `site.yml::paths.records`, else `records/`: the one resolver
  // the build and the push read too, so a pulled record lands where the next build
  // looks. ⛔ This wrote into the default directory until 2026-09-21, whatever the
  // site had moved its records to.
  const recordsRoot = resolveRecordsDir(siteRoot).abs
  // Captures target-locale translations of localized record fields: SCALARs →
  // locales/records/{locale}.json (structural maps too), and a prosemirror
  // BODY's free-form per-locale override → locales/freeform/{locale}/records/.
  const collector = createTranslationCollector(sourceLocale)
  const updated = []
  const placed = []
  const unchanged = []
  const skipped = []
  const warnings = []
  const backendState = opts.backend ? readBackendState(siteRoot, opts.backend) : {}
  // ⛔ PUT THE AUTHOR'S ASSET PATHS BACK BEFORE ANYTHING IS RENDERED — the step the
  // content lane takes (`site-project.js`), for the same reason. A pushed record goes
  // up with the serve URL the push put where its author wrote `/images/x.png`, and it
  // comes back that way; rendered as is, a pull rewrites the author's file to a
  // backend route. Asset ids and fingerprints are per backend, so a projection tied
  // to none restores nothing. Missing here until 2026-09-23.
  restoreAssetRefs(recordDocs, backendState.assets || {})
  // This backend's record map, inverted: its uuid → the record's own id.
  const recordMap = backendState.records || {}
  const ownIdByTheirs = new Map(Object.entries(recordMap).map(([own, theirs]) => [theirs, own]))
  // own id → their uuid, for every record this pull wrote. Recorded at the end.
  const learned = {}
  // uuid → the path under `records/` the record landed at. Only this loop knows
  // the extension each one got, so `folder.yml` is written from it rather than
  // re-derived (a second rule could pick a different extension and the folder
  // would name a file that is not there).
  const poolPathByUuid = new Map()

  for (const document of recordDocs) {
    const where = locate(document, folderIndex)
    if (!where?.slug) {
      skipped.push({ uuid: document.$uuid, reason: 'no slug (not in the folder, no $id)' })
      continue
    }
    const schema = documentSchema(document)
    const declaration = schema ? resolveDeclaration(schema) : null
    if (!declaration) {
      skipped.push({ uuid: document.$uuid, slug: where.slug, reason: `unresolved model ${schema || '(none)'}` })
      continue
    }

    const poolDir = recordDirFor(recordsRoot, schema, selfScope)
    if (!poolDir) {
      skipped.push({
        uuid: document.$uuid,
        slug: where.slug,
        reason: `model ${schema} names no pool folder (expected @/name or @org/name)`,
      })
      continue
    }
    // ⭐ The incoming `$uuid` is the BACKEND's. The file holds the record's OWN id, so
    // reverse this backend's map to find it. With no mapping the two are the same —
    // the first backend a record reaches minted the id it keeps — so the backend's
    // uuid is the own id, exactly as before identity was keyed by backend.
    const theirs = document.$uuid || null
    const own = theirs ? ownIdByTheirs.get(theirs) || theirs : null
    const existing = own ? findRecordFileByUuid(poolDir, own) : null

    let filePath
    let format
    let isNew
    if (existing) {
      filePath = existing.path
      format = existing.format
      isNew = false
    } else {
      format = defaultFormat(poolDir, declaration)
      filePath = join(poolDir, where.slug + EXT_FOR_FORMAT[format])
      isNew = true
    }

    // The free-form home for this record's content body (locale-independent); a
    // target-locale full-doc body is written under locales/freeform/{locale}/here.
    const freeformRelPath = buildFreeformRecordPath(schema, where.slug)

    // ⛔ The file gets the record's OWN id, never this backend's — a pull from a second
    // backend must not overwrite the identity the record already has.
    const toWrite = own && own !== theirs ? { ...document, $uuid: own } : document
    let status
    try {
      status = writeRecordFile({ filePath, document: toWrite, declaration, format, sourceLocale, collector, freeformRelPath })
    } catch (err) {
      // ⛔ A record that could not be written was not placed, so it is a SKIP, not a
      // warning: a caller that counts what it placed (the CLI's pull) must see it.
      // Until 2026-09-24 it was a warning, and a pull over records with no Sections —
      // what a partly applied push left — reported every one of them as taken.
      skipped.push({ uuid: document.$uuid, slug: where.slug, reason: err.message })
      continue
    }
    if (status === 'unchanged') unchanged.push(filePath)
    else if (isNew) placed.push(filePath)
    else updated.push(filePath)
    // Keyed by THEIR uuid: the folder document references records in the backend's
    // terms, so that is what `folderToFolderYml` will look them up by.
    if (theirs) {
      poolPathByUuid.set(theirs, relative(recordsRoot, filePath).split(sep).join('/'))
      if (own) learned[own] = theirs
    }
  }

  // ⭐ THE FOLDER ITSELF, written back as `folder.yml`. Steps that only touched the
  // READ path would leave every pull authoring the old shape — the site would build
  // from the new layout and be projected back into the one it replaced.
  //
  // The folder ENTITY still carries no `$uuid` we persist: the backend owns the
  // site's folder, keyed by the site-content uuid.
  const records = folderToFolderYml({ folderDoc, siteRoot, poolPathByUuid, sourceLocale })
  warnings.push(...records.warnings)

  // Flush localized record-field translations to locales/records/{locale}.json,
  // and any prosemirror free-form body overrides to locales/freeform/{locale}/.
  const locales = writeLocaleTranslations(siteRoot, collector.byLocale, 'records')
  const freeform = writeFreeformTranslations(siteRoot, collector.freeformPending)

  if (opts.backend && Object.keys(learned).length) {
    updateBackendMap(siteRoot, opts.backend, 'records', learned)
  }

  return { updated, placed, unchanged, skipped, warnings, locales, freeform, records: records.status, recordsFile: records.file }
}
