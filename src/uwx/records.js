// Map a site's file-based collections to exchange (`.uwx`) ENTITIES of a Model
// referenced BY NAME, on the entity-content SYNC lane.
//
// Each record becomes a section-keyed `$`-document (docs/reference/entity-content.md):
// `$id` (the producer-local handle), `$model` (the Model by name), and
// each SINGLE section keyed by its name — the brief plus any sibling singles, not
// the brief alone. The backend MINTS `$uuid` on first sync and
// returns it in the finalized response; the verb back-fills it into the source
// file. A record that already carries `$uuid` (a prior back-fill) round-trips it
// for restore-in-place. No id sidecar — identity is the file-embedded `$uuid` plus
// the back-fill round-trip.
//
// To shape each record, the mapper needs the Model's declaration — the brief
// section name, its field order, and which fields are localized. The orchestrator
// reads that from the LOCAL foundation's built `dist/meta/schema.json` (lowered
// via `toDataSchemaDeclaration`, the same path `uniweb register` uses), so it
// stays offline.
//
// Scope: this mapper implements the FLAT-RECORD shape — one source file whose
// frontmatter keys are field names — so it walks the Model's `single` sections
// and skips `multi` ones.
//
// ⛔ That is a property of THIS MAPPER, not of the schema system, and saying
// otherwise has already misled twice. `multi` is first-class: the author writes
// `many: true`, which lowers to IR `kind: 'multi'` and to wire `multiple: true`.
// A Model whose ONLY section is `many` is a supported shape in its own right — a
// root list, content authored as a bare array (`@uniweb/schemas` `rootListSection`;
// `@std/nav` and `@std/form` are exactly this). Such a Model has no flat-record
// surface at all, so it is not that its records "cannot be expressed" — it is
// that they are not this shape, and this mapper only knows this shape.
//
// Nested sections (a `type: section` field) and entity_ref / item_ref / file
// fields have no branch in `encodeFieldValue`; unverified either way.
//
// ⚠️ Two claims that used to sit here were stale and were removed rather than
// re-worded, because both named real capabilities as missing: NON-BRIEF single
// sections are handled (see `recordSections` below — the filter is `multiple !==
// true`, not `brief === true`), and REMOTE foundations are handled through the
// injected `opts.resolveModel`. A scope note that under-claims is worse than none:
// it sends a reader to build what is already there.

import { readFileSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { detectFoundationType } from '../site/foundation-ref.js'
import { join, resolve } from 'node:path'

import { resolveQueriesConfig } from './queries-config.js'
import { readEntityFile } from './entity-source.js'
import { readRecordsConfig, resolveFolder, RECORDS_YML_RELPATH } from '../site/records-config.js'
import {
  readEntityPool,
  groupPoolBySchema,
  poolPathReadings,
  poolDirsForSchema,
} from '../site/entity-pool.js'
import { toDataSchemaDeclaration, isProseMirrorField, isMarkupTextField, isContentBodyField } from './data-schema.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { sha256Hex, toJsonBuffer } from './manifest.js'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { LOCALIZED_FIELD_ASSUMPTION, localize } from './localize.js'
import { localizeScalar, localizeContentDoc, loadLocaleTranslations, discoverLocales, discoverFreeformLocales, localesDir, isLocalizedContent } from './locale-sync.js'
import { loadFreeformRecord } from '../i18n/freeform.js'

const DATE_KINDS = new Set(['date', 'datetime'])
// Identity/transport keys on a source record — never Model fields, never warned.
// `$body` carries the markdown body (mapped to the brief's content body field below).
// Note: there is NO delivery-derived ignore list (route/excerpt/image/content) —
// the source reader never produces those, and a real unknown key SHOULD warn (it
// means the frontmatter doesn't match the collection's data schema).
const SKIP_KEYS = new Set([
  'slug',
  '$id',
  '$uuid',
  '$model',
  '$owner',
  '$unit',
  '$meta',
  '$body',
])

// Recursively drop IDENTITY `$`-sigil keys (`$uuid`/`$id`/`$model`/… — never
// field data; the sigil-exclusivity invariant guarantees this) at every level,
// so a back-filled `$uuid` doesn't change the hash. `$children` is the exception:
// it is STRUCTURAL content (a self-nesting record's subtree, e.g. site-content's
// nested pages/sections), so it is KEPT and recursed into — otherwise a nesting
// change would be invisible to "send only changed". Flat records carry no
// `$children`, so this is a no-op for the collection lane.
function stripSigils(value) {
  if (Array.isArray(value)) return value.map(stripSigils)
  if (value && typeof value === 'object') {
    // ⛔ A `@uniweb/folder` REF LEAF ENCODES ONE REFERENCE TWO WAYS, and hashing the
    // encoding rather than the reference made the folder's hash unreproducible.
    //
    // `refLeaf` (uwx/folder.js) emits `$ref: <the record's $id>` — the pool position
    // `<dirs>/<slug>` — while the record is brand-new, and `entry: { model, entity:
    // <uuid> }` once it has been minted.
    // Both denote the same record. A push hashes the folder BEFORE submitting, then
    // back-fills the minted `$uuid` into every record's source file — so the very
    // next emit builds the OTHER encoding, and the hash the push just banked can
    // never be recomputed. Measured on the matinee manor 2026-08-29: `uniweb status`
    // reported the folder changed immediately after a successful push, permanently.
    // Stripping the back-filled uuids from the sources reproduced the banked hash
    // exactly, which is what identified the encoding as the variable.
    //
    // ⭐ Neither encoding is content. What the folder SAYS is "this branch contains
    // this record, here, in this order" — and that is already hashed: a leaf carries
    // `name` (the record's handle) inside a branch carrying the collection's.
    // A `folders:` branch's entries are COLLECTION names, so every leaf under one
    // comes from a single collection, where a slug is unique. Position plus segment
    // therefore identify the record on their own; `$ref` adds a payload-local handle
    // and `entry` adds identity, and both are exactly what `$uuid` is stripped for.
    //
    // ⚖️ The previous rule kept `$ref` "so a reference change is visible". It still
    // is: point a leaf at a different record and its `name` moves with it.
    const isFolderRefLeaf = value.kind === 'ref'
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (isFolderRefLeaf && (k === '$ref' || k === 'entry')) continue
      // `$children` (a self-nesting subtree) is structural CONTENT, not an identity
      // sigil — kept and recursed into, so a nesting change stays visible.
      if (k === '$children') {
        out[k] = stripSigils(v)
        continue
      }
      if (k.startsWith('$')) continue
      out[k] = stripSigils(v)
    }
    return out
  }
  return value
}

/**
 * Identity-INDEPENDENT content hash of an entity `$`-document: strip every
 * `$`-sigil (so a back-filled `$uuid` doesn't change it), then sha256 the
 * canonical content. An unchanged record hashes the same on first sync and every
 * re-sync — the basis for the "send only changed" pre-filter (the producer's
 * sync-cache, keyed by `<model> <id>`). Distinct from the manifest's
 * `entries[].sha256`, which is over the whole document incl. `$uuid`.
 */
export function entityContentHash(document) {
  return sha256Hex(toJsonBuffer(stripSigils(document)))
}

function encodeFieldValue(value, field, sourceLocale, translations) {
  if (value == null) return value
  if (isProseMirrorField(field)) {
    // markdown source → ProseMirror doc. When localized, wrap per-locale exactly
    // like a page section's content (source doc + target structural maps) — same
    // path, flushed to locales/records/{locale}.json by the caller.
    const doc = typeof value === 'string' ? markdownToProseMirror(value) : value
    if (!field.localized) return doc
    const localized = localizeContentDoc(doc, sourceLocale, Object.keys(translations || {}), translations)
    // localizeContentDoc returns a BARE doc when there are no target locales. A
    // localized field MUST ride as a `{ lang: value }` map on the wire — the
    // schema-driven projector drops a localized field whose value isn't a map — so
    // wrap the source doc, consistent with localizeScalar (which always wraps).
    return isLocalizedContent(localized) ? localized : { [sourceLocale]: localized }
  }
  if (field.localized) {
    // A markup `text` BODY (format markdown|html) rides as a RAW string, wrapped
    // per-locale wholesale (its per-string translations live in the i18n manifest /
    // free-form, not the scalar map). Other localized scalars wrap per-string from
    // locales/records/{locale}.json.
    return isMarkupTextField(field)
      ? localize(value, sourceLocale)
      : localizeScalar(value, sourceLocale, translations)
  }
  // A YAML scalar date parses to a Date. The backend validates `date` as
  // `YYYY-MM-DD` and `datetime` as RFC3339 — emitting full ISO for a `date`
  // field is rejected before storage, so split by kind.
  if (DATE_KINDS.has(field.type) && value instanceof Date) {
    return field.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value
}

/**
 * Map one file-based collection's records to entity-content `$`-documents of
 * `declaration`'s Model. PURE — records + declaration in, entity descriptors out;
 * no I/O, no minting. The backend mints `$uuid` on first sync; a record that
 * already carries `$uuid` (back-filled from a prior sync) round-trips it.
 *
 * @param {object} params
 * @param {string} params.queryName  - the query's name in site.yml
 * @param {object[]} params.records        - [{ slug, ...fields }]
 * @param {object} params.declaration      - the `@uniweb/data-schema` declaration
 *        (from toDataSchemaDeclaration): `{ name, brief, sections }`
 * @param {string} [params.sourceLocale]   - locale for localized-field wrap
 * @param {object} [params.translations]   - `{ locale: { hash: tgt } }` for wrapping
 *        localized scalar fields per-locale (from loadLocaleTranslations)
 * @returns {{ entities: object[], warnings: string[] }} each entity is
 *   `{ id, uuid, model, file, document }` — `document` is the section-keyed body.
 */
export function recordsToEntities({
  queryName,
  records,
  declaration,
  sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale,
  translations,
}) {
  if (!declaration || !declaration.name) {
    throw new Error('uwx/records: a declaration with a name is required')
  }
  // A record (one source file) maps to the Model's SINGLE sections in declared
  // order — the brief (the card) plus any sibling single sections, e.g. a body
  // section like `article_body`. Multi-section Models are the norm for `@std/*`
  // types; the markdown body lands in the designated content field WHEREVER it is
  // declared (the brief, or a non-brief body section). `multi` sections (repeating
  // items) can't be expressed by one flat record and are skipped. The brief is the
  // section marked `brief: true` (the sections-tree has no schema-level back-ref).
  const sectionEntries = Object.entries(declaration.sections || {})
  const briefEntry = sectionEntries.find(([, s]) => s && s.brief === true)
  const briefName = briefEntry?.[0]
  if (!briefName) {
    throw new Error(`uwx/records: Model ${declaration.name} has no brief section`)
  }
  // The single sections one record can populate (the brief + sibling singles).
  //
  // ⛔ `fieldByKey` IS NOT A FIELD→SECTION ROUTING TABLE, and must not be used as
  // one. It answers exactly one question — "is this frontmatter key declared
  // anywhere on this Model?" — for the unknown-key warning below. The assignment
  // loop does not consult it: it walks each section and reads `record[key]` afresh.
  //
  // ⚠️ SO A FIELD NAME DECLARED IN TWO SECTIONS FANS OUT. The same frontmatter
  // value is written into BOTH sections, each encoded per its own field's type — so
  // a name shared by, say, a `string` and a `json` field yields one plausible value
  // and one malformed one, silently. And flat frontmatter has no way to give the
  // two fields different values in the first place: the representation is lossy
  // exactly where names collide.
  //
  // ⛔ Nothing prevents this. A previous version of this comment asserted that
  // "field names are unique across a Model's sections (the declaration's own
  // convention)" — that is FALSE, no such convention holds, and nothing validates
  // it: `resolve-data-schema.js` throws in 14 places and never checks this, and the
  // only `unique_field` in the schema translator is a section-scoped constraint on
  // an open map's KEY VALUE, which is unrelated. The invariant was asserted, relied
  // on, and never provided.
  const recordSections = sectionEntries.filter(([, s]) => s && s.multiple !== true)
  const fieldByKey = new Map()
  for (const [, sec] of recordSections) {
    for (const [key, field] of Object.entries(sec.fields || {})) {
      if (!fieldByKey.has(key)) fieldByKey.set(key, field)
    }
  }

  // The markdown body of a `.md` record is the value of the Model's CONTENT body
  // field — a markup `text` field (raw source string) or a `format: prosemirror`
  // json field (docs/reference/entity-content.md) — wherever it is declared (the
  // brief, or a non-brief body section like `article_body.content`). encodeFieldValue
  // does the md→ProseMirror conversion per field kind. One content field is the body
  // target; zero means a `.md` body has nowhere to go (warn per record).
  const contentMatches = []
  for (const [secName, sec] of recordSections) {
    for (const [key, field] of Object.entries(sec.fields || {})) {
      if (isContentBodyField(field)) contentMatches.push({ secName, key })
    }
  }
  const bodyTarget = contentMatches[0] || null

  const entities = []
  const warnings = []
  if (contentMatches.length > 1) {
    warnings.push(
      `${queryName}: ${declaration.name} has more than one content ` +
        `(markdown / html / prosemirror) field — the markdown body maps to ` +
        `"${bodyTarget.secName}.${bodyTarget.key}"`
    )
  }
  for (const record of records || []) {
    const slug = record.slug
    if (!slug) {
      warnings.push(`${queryName}: a record without a slug was skipped`)
      continue
    }
    // ⛔ `$id` IS NOT THE SLUG. It is the payload-local, PATH-QUALIFIED handle, so
    // the @uniweb/folder entity can point a leaf at it via `$ref`. An explicit
    // frontmatter `$id` wins.
    //
    // ⚠️ The authoritative value is the record's POOL POSITION — `<dirs>/<slug>` —
    // and it is set upstream, at the pool walk; see the ⭐ comment there, which is
    // where the reasoning lives. `<query>/<slug>` below is only the fallback for a
    // record that did not arrive through the pool, and it is explicitly NOT the
    // shape identity is meant to take: two queries over one Model would mint two
    // identities for one file.
    //
    // The qualification is a CONSTRAINT, not a style: the sync response is keyed per
    // (`$model`, `$id`), so a bare slug would collide whenever two queries over the
    // same Model reuse one (see the duplicate check below). ⇒ Do not describe this
    // value as "the slug" — the folder leaf's `name` is the bare segment, and
    // conflating the two has already misdirected a naming decision.
    const id = record.$id || `${queryName}/${slug}`
    const uuid = record.$uuid || null
    const hasBody = typeof record.$body === 'string' && record.$body.trim() !== ''

    // Per-section data in schema-declared field order (the wire's canonical order).
    // Frontmatter keys land in their declaring section; the markdown body fills the
    // designated content field (in whatever section declares it) unless frontmatter
    // already set it explicitly. An absent field is simply omitted — an incomplete
    // entity is a valid stored state; the foundation copes at render time.
    const sectionData = {}
    for (const [secName, sec] of recordSections) {
      const data = {}
      for (const [key, field] of Object.entries(sec.fields || {})) {
        let value = record[key]
        if (value === undefined && bodyTarget && secName === bodyTarget.secName && key === bodyTarget.key && hasBody) {
          value = record.$body
        }
        if (value === undefined) continue
        const encoded = encodeFieldValue(value, field, sourceLocale, translations)
        if (encoded !== undefined) data[key] = encoded
      }
      if (Object.keys(data).length) sectionData[secName] = data
    }
    // Warn for author keys not on ANY record section. A real unknown key means the
    // frontmatter doesn't match the collection's data schema — that SHOULD warn
    // (only identity/transport keys in SKIP_KEYS are silent).
    for (const key of Object.keys(record)) {
      if (SKIP_KEYS.has(key) || fieldByKey.has(key)) continue
      warnings.push(
        `${queryName}/${slug}: field "${key}" is not on ` +
          `${declaration.name} — not synced`
      )
    }
    if (hasBody && !bodyTarget) {
      warnings.push(
        `${queryName}/${slug}: markdown body present but ` +
          `${declaration.name} has no content body field — body not synced`
      )
    }

    // The `$`-document, in canonical key order: `$uuid?`, `$id`, `$model`, then each
    // populated section in declared order (the brief always present as the card).
    // `$owner`/`$unit`/`$meta` are omitted — the backend binds owner + unit on its side.
    const document = {}
    if (uuid) document.$uuid = uuid
    document.$id = id
    document.$model = declaration.name
    document[briefName] = sectionData[briefName] || {}
    for (const [secName] of recordSections) {
      if (secName !== briefName && sectionData[secName]) document[secName] = sectionData[secName]
    }

    entities.push({
      id,
      uuid,
      slug,
      model: declaration.name, // reference the Model BY NAME — importer resolves it
      file: `entities/${queryName}/${slug}.json`,
      document,
    })
  }
  return { entities, warnings }
}

// Post-pass: override a collection record's localized CONTENT body with a per-locale
// FREE-FORM body when `locales/freeform/{locale}/entities/<schema>/<slug>.md` exists
// — the override wins over the structural map, exactly like site-content sections
// (site.js localizeContentTree). Only a `format: prosemirror` localized field can
// take it (it is a PM doc on the wire; a markup `text` body stays a raw string).
// Mutates the entity documents in place. Async — the free-form read hits the disk.
async function applyFreeformRecordOverrides({
  entities,
  queryName,
  declaration,
  sourceLocale,
  targetLocales,
  localesBase,
}) {
  const briefEntry = Object.entries(declaration.sections || {}).find(([, s]) => s && s.brief === true)
  const briefName = briefEntry?.[0]
  const fields = briefEntry?.[1]?.fields || {}
  // The body target for a free-form override is the prosemirror CONTENT field.
  const contentKey = Object.entries(fields).find(([, f]) => isProseMirrorField(f) && f.localized)?.[0]
  if (!briefName || !contentKey) return

  for (const entity of entities) {
    const data = entity.document?.[briefName]
    if (!data || data[contentKey] === undefined) continue
    let localized = data[contentKey]
    // The source-locale doc to promote to the localized-map form (when the field is
    // still a bare doc because no structural translation was present).
    const sourceDoc = isLocalizedContent(localized) ? localized[sourceLocale] : localized
    for (const locale of targetLocales) {
      // loadFreeformRecord returns { content, frontmatter, … } — doc is `.content`.
      const body = (await loadFreeformRecord({ slug: entity.slug }, entity.model, locale, localesBase))?.content
      if (!body) continue
      if (!isLocalizedContent(localized)) localized = { [sourceLocale]: sourceDoc }
      localized[locale] = body // free-form full body overrides the structural map
    }
    data[contentKey] = localized
  }
}

// --- orchestration (file I/O) ------------------------------------------------

// The collections in site.yml that opt into export (an object decl with `model:`).
// The declared collections that opt into sync: a resolvable data schema present
// (explicit or convention-defaulted) and not opted out (`sync: false`). Takes the
// merged declarations from resolveQueriesConfig (collections.yml over
// site.yml::collections), so collections.yml is honored without re-reading.
function syncableQueries(declarations) {
  const out = []
  for (const decl of Object.values(declarations)) {
    if ((decl.schema || decl.model) && decl.sync !== false) out.push({ name: decl.name, decl })
  }
  return out
}

// Resolve the foundation dir from an explicit opt, else the site's `file:`
// foundation dep. A local foundation supplies locally-defined Model declarations
// offline; non-local Models are fetched via an injected resolver (see below).
// Where this site's foundation lives, via the ONE resolver for that question
// (`../site/foundation-ref.js` — a leaf precisely so this lane can import it).
//
// This used to be a private copy that read `package.json` `dependencies.foundation`
// — a key no current template produces, since a site's foundation dep is keyed by
// the foundation's package name (`"src": "file:../src"`). It returned null for
// every scaffolded site, so the local-foundation path silently never ran: with a
// `resolveModel` wired the caller fell back to the backend, and without one every
// collection soft-skipped to delivery-only.
//
// The site declares its foundation in `site.yml`; the resolver turns that
// declaration into a location. A declaration it refuses (a versionless registry
// ref, an unknown name) is not this function's error to raise — the caller decides
// whether a local foundation was required — so a throw becomes "no local
// foundation" here and the caller's `required` flag still owns the message.
function resolveFoundationDir(siteRoot, opts) {
  if (opts.foundationDir) return resolve(opts.foundationDir)
  try {
    const siteYml = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8')) || {}
    if (!siteYml.foundation) return null
    const info = detectFoundationType(siteYml.foundation, siteRoot)
    return info?.type === 'local' && info.path ? info.path : null
  } catch {
    return null
  }
}

// Load the local foundation's built schema.json (the source of locally-defined
// Model declarations), or null when there's no local foundation. `required` (set
// when no remote resolver is available) turns "missing" into a helpful error
// instead of null, preserving the offline-only behavior.
function loadLocalFoundationSchema(siteRoot, opts, { required }) {
  const foundationDir = resolveFoundationDir(siteRoot, opts)
  if (!foundationDir) {
    if (required) {
      throw new Error(
        'uwx/records: could not locate a local foundation. Pass foundationDir, ' +
          'use a `file:` foundation dependency, or run via `uniweb sync` so non-local ' +
          'Models resolve from the registry.'
      )
    }
    return null
  }
  const schemaPath = join(foundationDir, 'dist', 'meta', 'schema.json')
  if (!existsSync(schemaPath)) {
    if (required) {
      throw new Error(
        `uwx/records: ${schemaPath} not found — build the foundation first ` +
          '(`uniweb build`).'
      )
    }
    return null
  }
  return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

// Find the data-schema this foundation DEFINES that matches a fully-qualified
// `model:` name, and lower it to its declaration. The foundation's own schemas
// are keyed `@/x`; resolve them into the requested name's org and exact-match.
// Returns null when the Model isn't defined locally (e.g. a shared ref the
// foundation only references — v1 needs the declaration locally).
function resolveDeclaration(schema, modelName) {
  const dataSchemas = schema?.dataSchemas || {}
  const m = /^@([^/]+)\/(.+)$/.exec(modelName)
  const org = m ? m[1] : null
  const resolveName = (ref) =>
    typeof ref === 'string' && ref.startsWith('@/') && org
      ? `@${org}/${ref.slice(2)}`
      : ref
  for (const [ref, normalized] of Object.entries(dataSchemas)) {
    if (resolveName(ref) === modelName) {
      return toDataSchemaDeclaration(normalized, { name: modelName, resolveName })
    }
  }
  return null
}

// Load a query's ORIGINAL source records for export — the author's files,
// untouched (raw frontmatter + raw markdown body, raw YAML/JSON, raw BibTeX). This
// is deliberately NOT `processQueries` (the delivery pipeline that builds
// public/data, converts bodies to ProseMirror, and copies assets). Sync carries
// the source.
//
// ⭐ THE QUERY NAMES A SCHEMA AND THE POOL FOLLOWS. It does not name a directory,
// and there is no disk path for it to name: `entities/{schema}/` declares the
// model, so the entities of a schema ARE its records. That is the de-conflation —
// `collections/<name>/` used to answer "which files", "which schema" and "grouped
// how" with one directory, and only the first two were ever the same question.
//
// Remote (`url:`) queries have no local files; the caller warns and skips.
function loadSourceRecordsFromPool(poolBySchema, decl, placements) {
  if (!decl.schema) return null
  const entities = poolBySchema.get(decl.schema)
  if (!entities) return null
  // ⛔ ONLY WHAT `records.yml` REFERENCES. An entity of the right schema that no
  // entry places is not a record, so syncing it would create something nobody can
  // reach — and would make the payload disagree with the folder describing it.
  const placed = entities.filter((e) => placements.has(e.id))
  return placed.length ? placed : null
}

/**
 * Build the collection entity descriptors + back-fill index for a site's
 * `model:`-mapped file collections — PURE assembly (no hashing, no emit), so it
 * composes with other entity sources (e.g. site-content) into one sync package.
 * First sync sends no `$uuid` (the backend mints); re-sync round-trips the
 * back-filled `$uuid`. `mappedCount` lets a caller tell "no `model:` collections
 * declared" (0) from "declared but empty". Throws on an unresolvable Model or a
 * duplicate ($model, $id) within the submission.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.foundationDir]   - explicit local foundation root
 * @param {(name: string) => Promise<object|null>} [opts.resolveModel] - async
 *        resolver for a Model NOT defined by the local foundation; returns the
 *        `@uniweb/data-schema` declaration (or null). The verb wires this to the
 *        backend's Model-read route. Without it, the local foundation is required.
 * @param {string} [opts.sourceLocale]    - localized-field wrap locale
 * @returns {Promise<{ entities: object[], index: object[], warnings: string[], schemaless: Array<{name: string}>, mappedCount: number }>}
 *   `schemaless` lists collections that resolved no data schema (the convention-
 *   default soft-skip) — not synced as entities; the composite deploy delivers
 *   them statically via the data ball.
 */
export async function buildRecordEntities(siteRoot, opts = {}) {
  // Merged collections config (collections.yml over site.yml::collections). Reused
  // from the caller when provided (sync-package shares it with the folder builder).
  // ⭐ `records.yml` IS THE FOLDER, AND IT DECIDES WHAT SYNCS. Listing an entity
  // is what makes it a record; an entity nothing references exists but cannot be
  // publicly fetched — so it is a draft, for free, with no flag to set. This is
  // why `collections.yml::sync` is deleted rather than ported: "do not sync" is
  // now "reference nothing", which is the actual round trip.
  //
  // ⛔ AND `missing` IS NOT `empty`. Missing means do not sync at all and leave
  // the server's folder untouched; empty means sync an empty folder, REMOVING
  // what is there. The safe state is the absence of a file, so a live folder
  // cannot be wiped by deleting one — the destructive act requires affirmatively
  // creating one, and the CLI asks before it happens.
  //
  // ⚠️ READ FIRST, ABOVE EVERY EARLY RETURN. `recordsState` has to ride out of
  // this function on every path, because its ABSENCE reads as "not missing" to a
  // caller — measured: a site with no queries returned no state, the folder
  // builder took that for `declared`, and a site with no `records.yml` at all
  // emitted an empty folder that would have removed everything.
  const recordsCfg = await readRecordsConfig(siteRoot)
  if (recordsCfg.error) throw new Error(`uwx/records: ${recordsCfg.error}`)
  const recordsState = recordsCfg.state

  const colConfig = opts.queriesConfig || (await resolveQueriesConfig(siteRoot))
  if (!colConfig.folderSync) {
    return { entities: [], index: [], warnings: [], schemaless: [], mappedCount: 0, colConfig, recordsState, folder: null }
  }
  const mapped = syncableQueries(colConfig.declarations)
  if (mapped.length === 0) return { entities: [], index: [], warnings: [], schemaless: [], mappedCount: 0, colConfig, recordsState, folder: null }

  // A Model declaration comes from a LOCAL foundation (offline) or, for a
  // non-local Model, from the injected async `resolveModel(name)` — the verb wires
  // that to the backend's Model-read route (declaration form). The local
  // foundation is required ONLY when no resolver is provided.
  const resolveModel = typeof opts.resolveModel === 'function' ? opts.resolveModel : null
  // The local foundation is REQUIRED only when at least one collection asked for a
  // schema EXPLICITLY (and there's no remote resolver). Collections that only got a
  // schema from the subfolder-name convention soft-skip when nothing resolves, so a
  // delivery-only site with no foundation must not be forced to have one.
  const hasExplicit = mapped.some((m) => m.decl.schemaExplicit)
  const localSchema = loadLocalFoundationSchema(siteRoot, opts, {
    required: !resolveModel && hasExplicit,
  })

  const declCache = new Map()
  const declarationFor = async (modelName) => {
    if (declCache.has(modelName)) return declCache.get(modelName)
    let declaration = localSchema ? resolveDeclaration(localSchema, modelName) : null
    if (!declaration && resolveModel) declaration = await resolveModel(modelName)
    declaration = declaration || null
    declCache.set(modelName, declaration)
    return declaration
  }

  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale

  // Target locales for wrapping localized record fields per-locale: those with a
  // structural-translation file (locales/records/{locale}.json) UNIONED with
  // those that only have a free-form override dir (locales/freeform/{locale}/) — a
  // record localized solely by a free-form body would otherwise go undiscovered.
  const targetLocales = [
    ...new Set([...discoverLocales(siteRoot, 'records'), ...discoverFreeformLocales(siteRoot)]),
  ].filter((l) => l !== sourceLocale)
  const translations =
    targetLocales.length > 0 ? loadLocaleTranslations(siteRoot, targetLocales, 'records') : null

  const entities = []
  const index = []
  const warnings = []

  // ⭐ THE POOL, READ ONCE. A query names a `schema:` and the entities of that
  // schema are its records — so the pool is walked once here rather than a
  // directory per declaration, and two queries over one schema read one set of
  // files instead of two.
  const pool = await readEntityPool(siteRoot)
  const poolBySchema = groupPoolBySchema(pool.entities)

  const folder = resolveFolder(recordsCfg.entries, pool.entities)
  if (folder.errors.length) {
    throw new Error(`uwx/records: ${RECORDS_YML_RELPATH} is invalid —\n  ${folder.errors.join('\n  ')}`)
  }

  // ⛔ `@/x` IS A FOUNDATION-RELATIVE ALIAS AND MUST BE RESOLVED BEFORE IT SHIPS.
  //
  // `register` resolves it (`uwx/registry-package.js` builds `scoped` from the
  // publish scope and applies it to BOTH the declaration's name and its refs), so
  // a foundation's `@/member` is stored as `@org/member`. This path did NOT, and
  // carried the alias verbatim into `$model` and `models_required.name_at_export`.
  //
  // ⚠️ The backend resolves Models BY NAME and never mints, so an unresolved alias
  // is refused at restore with a message about a missing Model — which reads as a
  // registration problem rather than a producer one. Measured 2026-08-27 on a live
  // manor: `register` had already stored `@proximify/member` from the same alias,
  // and the push then named `@/member`. One CLI, two paths, one resolver.
  //
  // ⭐ Resolving BEFORE `declarationFor` is what keeps this to one line of behaviour:
  // `resolveDeclaration` already matches a fully-qualified name against the
  // foundation's `@/`-keyed `dataSchemas`, so a resolved name looks up correctly and
  // `declaration.name` — the value that becomes `$model` — is the resolved one.
  const selfScopeOrg =
    typeof opts.org === 'string' ? opts.org.replace(/^@/, '').replace(/\/.*$/, '') : ''
  const resolveSelfScope = (ref) =>
    typeof ref === 'string' && ref.startsWith('@/') && selfScopeOrg
      ? `@${selfScopeOrg}/${ref.slice(2)}`
      : ref
  // Collections that resolved no data schema (the convention-default soft-skip
  // below) — not synced as folder entities. The composite deploy delivers these
  // statically (the "data ball") instead, so the caller can route them there.
  const schemaless = []
  // The sync response is keyed per ($model, $id), so the pair must be unique
  // within one submission (two queries over the same Model could otherwise
  // reuse a slug).
  const seen = new Set()
  for (const { name, decl } of mapped) {
    const declaredModel = decl.schema || decl.model
    const modelName = resolveSelfScope(declaredModel)
    // Unresolvable `@/` — no org is known. Ship it rather than throwing (a `status`
    // probe on a never-pushed site has no org and must still count), but say so:
    // the backend's refusal names a missing Model and cannot name this cause.
    if (modelName === declaredModel && typeof declaredModel === 'string' && declaredModel.startsWith('@/')) {
      warnings.push(
        `query "${name}": \`${declaredModel}\` is foundation-relative and no org is known, ` +
          `so it ships unresolved. The backend resolves Models by name and will refuse it. ` +
          `Pass \`--org @handle\`, or push once so the site records its org.`
      )
    }
    const declaration = await declarationFor(modelName)
    if (!declaration) {
      // A convention-defaulted schema (subfolder-name) that doesn't resolve is a
      // soft skip — the collection is delivery-only, not a sync target. Only an
      // EXPLICIT schema/model the author asked for is a hard error.
      if (!decl.schemaExplicit) {
        // ⛔ Deliberately NOT a `warnings` string. This is a product decision the
        // author is making — entities or static files — and it needs to be
        // reported at a prominence a prose warning cannot carry. Callers get the
        // structured entry and say it themselves (`cli/src/commands/{publish,push}.js`).
        //
        // It used to push `"… — not synced"`, printed dim among everything else.
        // That was misleading in the expensive direction: the data IS delivered,
        // as static files. An author read "not synced" as "my data did not
        // upload" — or skimmed it — and either way could not act on it.
        schemaless.push({ name, model: modelName })
        continue
      }
      // ⚠️ NAME BOTH READINGS OF A DEPTH-2 POOL PATH. `entities/person/2024/ada.md`
      // resolves as `@person/2024` — the rule is total, so it is not ambiguous —
      // but an author who meant "records organised by year inside the `person`
      // schema" needs to be told what the build actually read, not only that
      // something failed to resolve. The wrong reading is the plausible one.
      const dirs = poolDirsForSchema(modelName)
      const { alternative } = dirs ? poolPathReadings(dirs) : { alternative: null }
      throw new Error(
        `uwx/records: Model "${modelName}" (query "${name}") could not be ` +
          'resolved — not defined by a local foundation' +
          (resolveModel
            ? ', and the backend has no such Model (register it first).'
            : '. Run via `uniweb sync` (which fetches non-local Models from the ' +
              'registry), or provide a local foundation that defines it.') +
          (alternative
            ? ` If you meant \`entities/${dirs[0]}/\` (${alternative}) organised by ` +
              `\`${dirs[1]}\`, note that a folder inside a schema folder is read as an ` +
              `org scope. Organise records in records.yml, not on disk.`
            : '')
      )
    }
    const poolEntities = loadSourceRecordsFromPool(poolBySchema, decl, folder.placements)
    if (poolEntities == null) {
      // No entities of this schema on disk. A remote (`url:`) query has none by
      // definition; a file-based one with an empty pool is an author state worth
      // naming, because "nothing synced" and "nothing there" look identical.
      warnings.push(
        decl.url
          ? `${name}: a remote (\`url:\`) query has no local entities — skipped`
          : `${name}: no entities of ${decl.schema} in the pool — nothing to sync`
      )
      continue
    }
    // Flatten source records into the mapper's flat shape; the markdown body
    // rides under `$body` (the mapper maps it to the brief's content body field).
    // Keep a per-slug pointer back to the source file for `$uuid` write-back —
    // null for array-form / BibTeX (multi-record) files, whose write-back is
    // deferred (no single-record file to rewrite in place).
    const flat = []
    const sourceBySlug = new Map()
    for (const pooled of poolEntities) {
      for (const r of await readEntityFile(pooled.absPath)) {
        if (!r.slug) {
          warnings.push(`${name}: a record without a slug was skipped`)
          continue
        }
        const rec = { ...r.data, slug: r.slug }
        if (r.body !== undefined) rec.$body = r.body
        // ⭐ THE RECORD'S IDENTITY IS ITS POOL POSITION, not `<query>/<slug>`. It
        // has to be: the folder places entities and must reference the very ones
        // the payload carries, and two queries over one schema would otherwise
        // mint two identities for one file. `<dirs>/<slug>` is unique by
        // construction and derivable on both sides.
        //
        // ⚠️ A multi-record file (array YAML, BibTeX) contributes several records
        // from one path, so the slug — not the file stem — completes the id.
        rec.$id = rec.$id || [...pooled.dirs, r.slug].join('/')
        flat.push(rec)
        sourceBySlug.set(r.slug, r)
      }
    }

    const mappedOut = recordsToEntities({
      queryName: name,
      records: flat,
      declaration,
      sourceLocale,
      translations,
    })
    // Free-form per-locale body overrides (a full localized doc beats the structural
    // map) — only meaningful for a multi-locale site with a prosemirror content field.
    if (targetLocales.length > 0) {
      await applyFreeformRecordOverrides({
        entities: mappedOut.entities,
        queryName: name,
        declaration,
        sourceLocale,
        targetLocales,
        localesBase: localesDir(siteRoot),
      })
    }
    for (const e of mappedOut.entities) {
      const dupKey = `${e.model} ${e.id}`
      if (seen.has(dupKey)) {
        throw new Error(
          `uwx/records: duplicate ($model, $id) in one sync — "${e.id}" of ` +
            `${e.model} appears in more than one query. Each ($model, $id) ` +
            'must be unique within a sync; make the slugs unique.'
        )
      }
      seen.add(dupKey)
      // The verb back-fills the minted `$uuid` into this source file, matched
      // back from the finalized response by ($model, $id).
      const src = sourceBySlug.get(e.slug)
      index.push({
        id: e.id,
        model: e.model,
        slug: e.slug,
        // Single-record files render whole; multi-record YAML/JSON files get a
        // per-entry `$uuid` write keyed by slug (see backfill.js). `format` lets
        // the writer route (array-form vs BibTeX, the latter still deferred).
        sourceFile: src ? src.sourceFile : null,
        format: src ? src.format : null,
        multiRecord: src ? src.multiRecord : false,
        // The Model declaration, so the back-fill can render the finalized
        // document → authoring shape (variant A): unwrap localized fields, route
        // the content body field to the md body, drop the brief record `$uuid`.
        declaration,
      })
    }
    entities.push(...mappedOut.entities)
    warnings.push(...mappedOut.warnings)
  }

  return { entities, index, warnings, schemaless, mappedCount: mapped.length, colConfig, folder, recordsState }
}

/**
 * "Send only changed" filter, shared by the collection and combined sync paths.
 * Hashes each entity's content (identity-independent — `$uuid`/`$id` stripped,
 * `$children` kept) and drops those whose hash matches `priorHashes`. The sent
 * subset stays parallel (sendEntities[i] ↔ sendIndex[i]) so the backend's `index`
 * correlation holds for a partial send. `hashes` is the FULL current map (the
 * caller persists it to the sync-cache).
 *
 * @returns {{ sendEntities: object[], sendIndex: object[], hashes: Object<string,string>, skipped: number }}
 */
export function filterChanged(entities, index, { priorHashes = {}, sendAll = false } = {}) {
  const hashes = {}
  const sendEntities = []
  const sendIndex = []
  let skipped = 0
  for (let k = 0; k < entities.length; k++) {
    const e = entities[k]
    const key = `${e.model} ${e.id}`
    const h = entityContentHash(e.document)
    hashes[key] = h
    if (!sendAll && priorHashes[key] === h) {
      skipped++
      continue
    }
    sendEntities.push(e)
    sendIndex.push(index[k])
  }
  return { sendEntities, sendIndex, hashes, skipped }
}

/**
 * Build a collection-only sync package. Thin composition over
 * `buildRecordEntities` + `filterChanged` + `emitEntitySyncPackage`, kept for
 * the collection-only callers/tests. The combined site+collections path is
 * `emitSyncPackage` (sync-package.js).
 *
 * @param {string} siteRoot
 * @param {object} [opts] - buildRecordEntities opts, plus `priorHashes`,
 *        `sendAll`, `exporter`, `exportedAt`.
 * @returns {Promise<{ buffer: Buffer|null, models: string[], entityCount: number,
 *        warnings: string[], index: object[], hashes: Object<string,string>,
 *        skipped: number }>}
 */
export async function emitRecordSyncPackage(siteRoot, opts = {}) {
  const { entities, index, warnings, mappedCount } = await buildRecordEntities(siteRoot, opts)
  if (mappedCount === 0) {
    throw new Error(
      'uwx/records: no query declares a schema — nothing to export. ' +
        'Add a query to queries.yml naming the schema its records use, e.g.\n' +
        "  articles:\n    schema: '@/article'"
    )
  }
  if (entities.length === 0) {
    throw new Error(
      'uwx/records: no records to export. Either records.yml references ' +
        'nothing, or every query matched an empty pool — an entity is only a ' +
        'record once records.yml lists it.'
    )
  }

  const { sendEntities, sendIndex, hashes, skipped } = filterChanged(entities, index, {
    priorHashes: opts.priorHashes,
    sendAll: opts.sendAll,
  })

  const sentModels = [...new Set(sendEntities.map((e) => e.model))]
  if (sendEntities.length === 0) {
    return { buffer: null, models: sentModels, entityCount: 0, warnings, index: [], hashes, skipped }
  }

  const buffer = emitEntitySyncPackage({
    entities: sendEntities,
    // names-only: the importer resolves each Model by name (no uuids).
    modelsRequired: sentModels.map((name) => ({ name_at_export: name })),
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })

  return { buffer, models: sentModels, entityCount: sendEntities.length, warnings, index: sendIndex, hashes, skipped }
}
