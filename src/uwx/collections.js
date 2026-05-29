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

import { readYamlFile } from '../site/content-collector.js'
import { readCollectionRecords } from './collection-source.js'
import { toDataSchemaDeclaration } from './data-schema.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { LOCALIZED_FIELD_ASSUMPTION, localize } from './localize.js'

const DATE_KINDS = new Set(['date', 'datetime'])
const RICHTEXT_TYPE = 'richtext'
// Identity/transport keys on a source record — never Model fields, never warned.
// `$body` carries the markdown body (mapped to the brief's richtext field below).
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

function encodeFieldValue(value, field, sourceLocale) {
  if (value == null) return value
  if (field.localized) return localize(value, sourceLocale)
  // ISO-8601 for date kinds; a YAML date may parse to a Date.
  if (DATE_KINDS.has(field.type) && value instanceof Date) {
    return value.toISOString()
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
 * @returns {{ entities: object[], warnings: string[] }} each entity is
 *   `{ id, uuid, model, file, document }` — `document` is the section-keyed body.
 */
export function collectionRecordsToEntities({
  collectionName,
  records,
  declaration,
  sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale,
}) {
  if (!declaration || !declaration.name) {
    throw new Error('uwx/collections: a declaration with a name is required')
  }
  const briefName = declaration.brief
  if (!briefName) {
    throw new Error(
      `uwx/collections: Model ${declaration.name} has no brief section — ` +
        'v1 maps flat records to the brief single section only'
    )
  }
  const brief = (declaration.sections || []).find((s) => s.name === briefName)
  if (!brief) {
    throw new Error(
      `uwx/collections: brief section "${briefName}" not found on ${declaration.name}`
    )
  }
  const briefFields = brief.fields || []
  const fieldByKey = new Map(briefFields.map((f) => [f.key, f]))

  // The markdown body of a `.md` collection record is the value of the brief's
  // `richtext` field (docs/reference/entity-content.md). One richtext field is the
  // body target; zero means a `.md` body has nowhere to go (warn per record).
  const richtextFields = briefFields.filter((f) => f.type === RICHTEXT_TYPE)
  const bodyField = richtextFields[0] || null

  const entities = []
  const warnings = []
  if (richtextFields.length > 1) {
    warnings.push(
      `${collectionName}: ${declaration.name}.${briefName} has more than one richtext ` +
        `field — the markdown body maps to "${bodyField.key}"`
    )
  }
  for (const record of records || []) {
    const slug = record.slug
    if (!slug) {
      warnings.push(`${collectionName}: a record without a slug was skipped`)
      continue
    }
    const id = record.$id || slug
    const uuid = record.$uuid || null
    const hasBody = typeof record.$body === 'string' && record.$body.trim() !== ''

    // Brief section data in schema-declared field order (the wire's canonical
    // order). An absent field is simply omitted — an incomplete entity is a
    // valid stored state; the foundation copes at render time. The markdown body
    // fills the richtext field unless the frontmatter already set it explicitly.
    const data = {}
    for (const field of briefFields) {
      let value = record[field.key]
      if (value === undefined && field === bodyField && hasBody) value = record.$body
      if (value === undefined) continue
      const encoded = encodeFieldValue(value, field, sourceLocale)
      if (encoded !== undefined) data[field.key] = encoded
    }
    // Warn for author keys that aren't on the Model. A real unknown key means the
    // frontmatter doesn't match the collection's data schema — that SHOULD warn
    // (only identity/transport keys in SKIP_KEYS are silent).
    for (const key of Object.keys(record)) {
      if (SKIP_KEYS.has(key) || fieldByKey.has(key)) continue
      warnings.push(
        `${collectionName}/${slug}: field "${key}" is not on ` +
          `${declaration.name}.${briefName} — not synced`
      )
    }
    if (hasBody && !bodyField) {
      warnings.push(
        `${collectionName}/${slug}: markdown body present but ` +
          `${declaration.name}.${briefName} has no richtext field — body not synced`
      )
    }

    // The `$`-document body, in canonical key order: `$uuid?`, `$id`, `$model`,
    // then the brief section. `$owner`/`$unit`/`$meta` are omitted — the backend
    // binds owner + unit on its side.
    const document = {}
    if (uuid) document.$uuid = uuid
    document.$id = id
    document.$model = declaration.name
    document[briefName] = data

    entities.push({
      id,
      uuid,
      slug,
      model: declaration.name, // reference the Model BY NAME — importer resolves it
      file: `entities/${collectionName}/${slug}.json`,
      document,
    })
  }
  return { entities, warnings }
}

// --- orchestration (file I/O) ------------------------------------------------

// The collections in site.yml that opt into export (an object decl with `model:`).
function syncableCollections(siteYml) {
  const col = siteYml.collections
  if (!col || typeof col !== 'object' || Array.isArray(col)) return []
  const out = []
  for (const [name, decl] of Object.entries(col)) {
    if (decl && typeof decl === 'object' && decl.model) out.push({ name, decl })
  }
  return out
}

// v1: the Model's schema must be available from a LOCAL foundation. Resolve the
// foundation dir from an explicit opt, else the site's `file:` foundation dep.
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
 * Build the collection-sync package: a site's `model:`-mapped file collections
 * as model-by-name entity-content `$`-documents. First sync sends no `$uuid`
 * (the backend mints); re-sync round-trips the back-filled `$uuid` for
 * restore-in-place.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.foundationDir]   - explicit local foundation root
 * @param {string} [opts.sourceLocale]    - localized-field wrap locale
 * @param {object} [opts.exporter] @param {string} [opts.exportedAt]
 * @returns {Promise<{ buffer: Buffer, models: string[], entityCount: number,
 *        warnings: string[] }>}
 */
export async function emitCollectionSyncPackage(siteRoot, opts = {}) {
  const siteYml = await readYamlFile(join(siteRoot, 'site.yml'))
  const mapped = syncableCollections(siteYml)
  if (mapped.length === 0) {
    throw new Error(
      'uwx/collections: no collection declares `model:` — nothing to export. ' +
        'Add `model: "@org/name"` to a collection in site.yml.'
    )
  }

  const foundationDir = resolveFoundationDir(siteRoot, opts)
  if (!foundationDir) {
    throw new Error(
      'uwx/collections: could not locate a local foundation. v1 needs the ' +
        "Model's schema locally — pass foundationDir, or use a `file:` foundation " +
        'dependency. Remote foundations are not yet supported.'
    )
  }
  const schemaPath = join(foundationDir, 'dist', 'meta', 'schema.json')
  if (!existsSync(schemaPath)) {
    throw new Error(
      `uwx/collections: ${schemaPath} not found — build the foundation first ` +
        '(`uniweb build`).'
    )
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale

  const entities = []
  const index = []
  const warnings = []
  const models = new Set()
  // The sync response is keyed per ($model, $id), so the pair must be unique
  // within one submission (two collections on the same Model could otherwise
  // reuse a slug).
  const seen = new Set()
  for (const { name, decl } of mapped) {
    const declaration = resolveDeclaration(schema, decl.model)
    if (!declaration) {
      throw new Error(
        `uwx/collections: Model "${decl.model}" (collection "${name}") is not ` +
          'defined by the local foundation. v1 needs the Model declared ' +
          'locally; shared/registry-only Models are not yet supported.'
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
    // rides under `$body` (the mapper maps it to the brief's richtext field).
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
    })
    for (const e of mappedOut.entities) {
      const dupKey = `${e.model} ${e.id}`
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
      })
    }
    entities.push(...mappedOut.entities)
    warnings.push(...mappedOut.warnings)
    models.add(decl.model)
  }

  if (entities.length === 0) {
    throw new Error(
      'uwx/collections: no records to export (mapped collections were empty or skipped)'
    )
  }

  const buffer = emitEntitySyncPackage({
    entities,
    // names-only: the importer resolves each Model by name (no uuids).
    modelsRequired: [...models].map((name) => ({ name_at_export: name })),
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })

  return { buffer, models: [...models], entityCount: entities.length, warnings, index }
}
