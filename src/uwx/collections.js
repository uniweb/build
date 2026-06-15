// Map a site's file-based collections to exchange (`.uwx`) ENTITIES of a Model
// referenced BY NAME, on the entity-content SYNC lane.
//
// Each record becomes a section-keyed `$`-document (docs/reference/entity-content.md):
// `$id` (the slug — the producer-local handle), `$model` (the Model by name), and
// the brief section keyed by its name. The backend MINTS `$uuid` on first sync and
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
// v1 scope: a FLAT record -> the Model's brief `single` section. Deferred:
// multi / nested / non-brief sections (`$children` self-nesting), entity_ref /
// item_ref / file fields, and remote (non-local) foundations.

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveCollectionsConfig } from './collections-config.js'
import { readCollectionRecords } from './collection-source.js'
import { toDataSchemaDeclaration, isProseMirrorField, isMarkupTextField, isContentBodyField } from './data-schema.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { sha256Hex, toJsonBuffer } from './manifest.js'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { LOCALIZED_FIELD_ASSUMPTION, localize } from './localize.js'
import { localizeScalar, localizeContentDoc, loadLocaleTranslations, discoverLocales, discoverFreeformLocales, localesDir, isLocalizedContent } from './locale-sync.js'
import { loadFreeformCollectionItem } from '../i18n/freeform.js'

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
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // `$children` (a self-nesting subtree) and `$ref` (the @uniweb/folder leaf's
      // reference target) are structural CONTENT, not identity sigils — keep them so
      // a nesting or reference change is visible to "send only changed".
      if (k === '$children' || k === '$ref') {
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
    // path, flushed to locales/collections/{locale}.json by the caller.
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
    // locales/collections/{locale}.json.
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
 * @param {string} params.collectionName  - the site.yml collection name
 * @param {object[]} params.records        - [{ slug, ...fields }]
 * @param {object} params.declaration      - the `@uniweb/data-schema` declaration
 *        (from toDataSchemaDeclaration): `{ name, brief, sections }`
 * @param {string} [params.sourceLocale]   - locale for localized-field wrap
 * @param {object} [params.translations]   - `{ locale: { hash: tgt } }` for wrapping
 *        localized scalar fields per-locale (from loadLocaleTranslations)
 * @returns {{ entities: object[], warnings: string[] }} each entity is
 *   `{ id, uuid, model, file, document }` — `document` is the section-keyed body.
 */
export function collectionRecordsToEntities({
  collectionName,
  records,
  declaration,
  sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale,
  translations,
}) {
  if (!declaration || !declaration.name) {
    throw new Error('uwx/collections: a declaration with a name is required')
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
    throw new Error(`uwx/collections: Model ${declaration.name} has no brief section`)
  }
  // The single sections a flat record can populate (the brief + sibling singles),
  // and a global field→section map across them — for distributing frontmatter and
  // flagging unknown keys. Field names are unique across a Model's sections (the
  // declaration's own convention); a collision keeps the first occurrence.
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
      `${collectionName}: ${declaration.name} has more than one content ` +
        `(markdown / html / prosemirror) field — the markdown body maps to ` +
        `"${bodyTarget.secName}.${bodyTarget.key}"`
    )
  }
  for (const record of records || []) {
    const slug = record.slug
    if (!slug) {
      warnings.push(`${collectionName}: a record without a slug was skipped`)
      continue
    }
    // `$id` is the payload-local handle = the record's path under collections/
    // (`<collection>/<slug>`), globally unique within one sync so the @uniweb/folder
    // entity can point a leaf at it via `$ref`. An explicit frontmatter `$id` wins.
    const id = record.$id || `${collectionName}/${slug}`
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
        `${collectionName}/${slug}: field "${key}" is not on ` +
          `${declaration.name} — not synced`
      )
    }
    if (hasBody && !bodyTarget) {
      warnings.push(
        `${collectionName}/${slug}: markdown body present but ` +
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
      collection: collectionName, // the @uniweb/folder groups leaves by this
      model: declaration.name, // reference the Model BY NAME — importer resolves it
      file: `entities/${collectionName}/${slug}.json`,
      document,
    })
  }
  return { entities, warnings }
}

// Post-pass: override a collection record's localized CONTENT body with a per-locale
// FREE-FORM body when `locales/freeform/{locale}/collections/<col>/<slug>.md` exists
// — the override wins over the structural map, exactly like site-content sections
// (site.js localizeContentTree). Only a `format: prosemirror` localized field can
// take it (it is a PM doc on the wire; a markup `text` body stays a raw string).
// Mutates the entity documents in place. Async — the free-form read hits the disk.
async function applyFreeformCollectionOverrides({
  entities,
  collectionName,
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
      // loadFreeformCollectionItem returns { content, frontmatter, … } — doc is `.content`.
      const body = (await loadFreeformCollectionItem({ slug: entity.slug }, collectionName, locale, localesBase))?.content
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
// merged declarations from resolveCollectionsConfig (collections.yml over
// site.yml::collections), so collections.yml is honored without re-reading.
function syncableCollections(declarations) {
  const out = []
  for (const decl of Object.values(declarations)) {
    if ((decl.schema || decl.model) && decl.sync !== false) out.push({ name: decl.name, decl })
  }
  return out
}

// Resolve the foundation dir from an explicit opt, else the site's `file:`
// foundation dep. A local foundation supplies locally-defined Model declarations
// offline; non-local Models are fetched via an injected resolver (see below).
function resolveFoundationDir(siteRoot, opts) {
  if (opts.foundationDir) return resolve(opts.foundationDir)
  const pkgPath = join(siteRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const dep = pkg.dependencies?.foundation || pkg.devDependencies?.foundation
      if (typeof dep === 'string' && dep.startsWith('file:')) {
        return resolve(siteRoot, dep.slice('file:'.length))
      }
    } catch {
      // fall through to the not-found error below
    }
  }
  return null
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
        'uwx/collections: could not locate a local foundation. Pass foundationDir, ' +
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
        `uwx/collections: ${schemaPath} not found — build the foundation first ` +
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

// Load a collection's ORIGINAL source records for export — the author's files,
// untouched (raw frontmatter + raw markdown body, raw YAML/JSON, raw BibTeX). This
// is deliberately NOT `processCollections` (the delivery pipeline that builds
// public/data, converts bodies to ProseMirror, and copies assets). Sync carries
// the source. Only file-based (`path:`) collections export; remote (`url:`) data
// is not a local file collection.
async function loadSourceRecords(siteRoot, decl) {
  if (!decl.path) return null // not file-based — caller warns + skips
  return readCollectionRecords(resolve(siteRoot, decl.path))
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
 * @returns {Promise<{ entities: object[], index: object[], warnings: string[], mappedCount: number }>}
 */
export async function buildCollectionEntities(siteRoot, opts = {}) {
  // Merged collections config (collections.yml over site.yml::collections). Reused
  // from the caller when provided (sync-package shares it with the folder builder).
  const colConfig = opts.collectionsConfig || (await resolveCollectionsConfig(siteRoot))
  if (!colConfig.folderSync) {
    return { entities: [], index: [], warnings: [], mappedCount: 0, colConfig }
  }
  const mapped = syncableCollections(colConfig.declarations)
  if (mapped.length === 0) return { entities: [], index: [], warnings: [], mappedCount: 0, colConfig }

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
  // structural-translation file (locales/collections/{locale}.json) UNIONED with
  // those that only have a free-form override dir (locales/freeform/{locale}/) — a
  // record localized solely by a free-form body would otherwise go undiscovered.
  const targetLocales = [
    ...new Set([...discoverLocales(siteRoot, 'collections'), ...discoverFreeformLocales(siteRoot)]),
  ].filter((l) => l !== sourceLocale)
  const translations =
    targetLocales.length > 0 ? loadLocaleTranslations(siteRoot, targetLocales, 'collections') : null

  const entities = []
  const index = []
  const warnings = []
  // The sync response is keyed per ($model, $id), so the pair must be unique
  // within one submission (two collections on the same Model could otherwise
  // reuse a slug).
  const seen = new Set()
  for (const { name, decl } of mapped) {
    const modelName = decl.schema || decl.model
    const declaration = await declarationFor(modelName)
    if (!declaration) {
      // A convention-defaulted schema (subfolder-name) that doesn't resolve is a
      // soft skip — the collection is delivery-only, not a sync target. Only an
      // EXPLICIT schema/model the author asked for is a hard error.
      if (!decl.schemaExplicit) {
        warnings.push(
          `${name}: no data schema "${modelName}" (subfolder-name default) — not synced`
        )
        continue
      }
      throw new Error(
        `uwx/collections: Model "${modelName}" (collection "${name}") could not be ` +
          'resolved — not defined by a local foundation' +
          (resolveModel
            ? ', and the backend has no such Model (register it first).'
            : '. Run via `uniweb sync` (which fetches non-local Models from the ' +
              'registry), or provide a local foundation that defines it.')
      )
    }
    const sourceRecords = await loadSourceRecords(siteRoot, decl)
    if (sourceRecords == null) {
      warnings.push(
        `${name}: not a file-based (\`path:\`) collection — skipped`
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
    for (const r of sourceRecords) {
      if (!r.slug) {
        warnings.push(`${name}: a record without a slug was skipped`)
        continue
      }
      const rec = { ...r.data, slug: r.slug }
      if (r.body !== undefined) rec.$body = r.body
      flat.push(rec)
      sourceBySlug.set(r.slug, r)
    }

    const mappedOut = collectionRecordsToEntities({
      collectionName: name,
      records: flat,
      declaration,
      sourceLocale,
      translations,
    })
    // Free-form per-locale body overrides (a full localized doc beats the structural
    // map) — only meaningful for a multi-locale site with a prosemirror content field.
    if (targetLocales.length > 0) {
      await applyFreeformCollectionOverrides({
        entities: mappedOut.entities,
        collectionName: name,
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
          `uwx/collections: duplicate ($model, $id) in one sync — "${e.id}" of ` +
            `${e.model} appears in more than one collection. Each ($model, $id) ` +
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

  return { entities, index, warnings, mappedCount: mapped.length, colConfig }
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
 * `buildCollectionEntities` + `filterChanged` + `emitEntitySyncPackage`, kept for
 * the collection-only callers/tests. The combined site+collections path is
 * `emitSyncPackage` (sync-package.js).
 *
 * @param {string} siteRoot
 * @param {object} [opts] - buildCollectionEntities opts, plus `priorHashes`,
 *        `sendAll`, `exporter`, `exportedAt`.
 * @returns {Promise<{ buffer: Buffer|null, models: string[], entityCount: number,
 *        warnings: string[], index: object[], hashes: Object<string,string>,
 *        skipped: number }>}
 */
export async function emitCollectionSyncPackage(siteRoot, opts = {}) {
  const { entities, index, warnings, mappedCount } = await buildCollectionEntities(siteRoot, opts)
  if (mappedCount === 0) {
    throw new Error(
      'uwx/collections: no collection declares `model:` — nothing to export. ' +
        'Add `model: "@org/name"` to a collection in site.yml.'
    )
  }
  if (entities.length === 0) {
    throw new Error(
      'uwx/collections: no records to export (mapped collections were empty or skipped)'
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
