// Map a site's file-based collections to exchange (`.uwx`) ENTITIES of a Model
// referenced BY NAME, each keyed by a stable uuid. A sidecar-backed re-export
// reuses the same uuids so an idempotent import UPDATES rather than DUPLICATES.
//
// The exporter is names-only: an entity points at its Model by NAME
// (`model: "@acme/product"`), never a uuid — the importer resolves the name.
// Identity split: this exporter owns ENTITY identity (the sidecar uuids); the
// importer owns MODEL identity (resolved from the name).
//
// To shape each record, the mapper needs the Model's declaration — the brief
// section name and which fields are localized. The orchestrator reads that from
// the LOCAL foundation's built `dist/meta/schema.json` (lowered via
// `toDataSchemaDeclaration`, the same path `uniweb register` uses), so it stays
// offline.
//
// v1 scope: a FLAT record → the Model's brief `single` section. Deferred:
// multi / nested / non-brief sections, entity_ref / item_ref / file fields, a
// rename-survival id anchor (v1 is slug-keyed), and remote (non-local)
// foundations.

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readYamlFile } from '../site/content-collector.js'
import { processCollections } from '../site/collection-processor.js'
import { toDataSchemaDeclaration } from './data-schema.js'
import { emitEntityPackage } from './package.js'
import { mintResolver, sidecarResolver, SIDECAR_RELPATH } from './identity.js'
import { LOCALIZED_FIELD_ASSUMPTION, localize } from './localize.js'

const DATE_KINDS = new Set(['date', 'datetime'])
// Keys on a loaded record that are identity/transport, not Model field data.
const NON_FIELD_KEYS = new Set(['slug'])

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
 * Map one file-based collection's records to entities of `declaration`'s Model.
 * PURE — records + declaration in, entities out; no I/O, no foundation lookup.
 * (The orchestrator below supplies `declaration` from the local foundation.)
 *
 * @param {object} params
 * @param {string} params.collectionName       - the site.yml collection name
 * @param {object[]} params.records            - [{ slug, ...fields }]
 * @param {object} params.declaration          - the `@uniweb/data-schema`
 *        declaration (from toDataSchemaDeclaration): `{ name, brief, sections }`
 * @param {object} params.idResolver           - identity resolver (entity()/item())
 * @param {string} [params.sourceLocale]       - locale for localized-field wrap
 * @returns {{ entities: object[], warnings: string[] }}
 */
export function collectionRecordsToEntities({
  collectionName,
  records,
  declaration,
  idResolver,
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
  const fieldByKey = new Map((brief.fields || []).map((f) => [f.key, f]))

  const entities = []
  const warnings = []
  for (const record of records || []) {
    const slug = record.slug
    if (!slug) {
      warnings.push(`${collectionName}: a record without a slug was skipped`)
      continue
    }
    const entityKey = `col:${collectionName}:${slug}`
    const data = {}
    for (const [key, value] of Object.entries(record)) {
      if (NON_FIELD_KEYS.has(key)) continue
      const field = fieldByKey.get(key)
      if (!field) {
        warnings.push(
          `${collectionName}/${slug}: field "${key}" is not on ` +
            `${declaration.name}.${briefName} — not synced`
        )
        continue
      }
      const encoded = encodeFieldValue(value, field, sourceLocale)
      if (encoded !== undefined) data[key] = encoded
    }
    entities.push({
      uuid: idResolver.entity(entityKey),
      model: declaration.name, // reference the Model BY NAME — the importer resolves it
      owner_uuid: null, // the importer binds owner/unit on import; exporter leaves null
      unit_uuid: null,
      meta: {},
      items: [
        {
          uuid: idResolver.item(`${entityKey}::${briefName}`),
          section: briefName,
          parent_section: null,
          parent_path: null,
          data,
          order_number: null,
        },
      ],
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

// Load a collection's records for export: every record (no render-time
// filter/limit — export carries the whole collection). Only file-based (`path:`)
// collections export; remote (`url:`) data is not a local file collection.
async function loadRecords(siteRoot, name, decl) {
  if (!decl.path) return null // not file-based — caller warns + skips
  const loaded = await processCollections(siteRoot, { [name]: { path: decl.path } })
  return loaded[name] || []
}

/**
 * Build the collection-sync package: a site's `model:`-mapped file collections
 * as uuid-stable, model-by-name entities. Sidecar-backed by default so a
 * re-export updates rather than duplicates.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {boolean|string} [opts.sidecar]   - stable round trip. `true` →
 *        `<siteRoot>/.uniweb/uwx-ids.json`; a string → that path. Default off
 *        (mint); the CLI defaults it on.
 * @param {object} [opts.idResolver]         - explicit resolver (overrides sidecar)
 * @param {string} [opts.foundationDir]      - explicit local foundation root
 * @param {string} [opts.sourceLocale]       - localized-field wrap locale
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

  let id = opts.idResolver
  if (!id && opts.sidecar) {
    const path =
      typeof opts.sidecar === 'string'
        ? opts.sidecar
        : join(siteRoot, SIDECAR_RELPATH)
    id = sidecarResolver(path)
  }
  if (!id) id = mintResolver()

  const sourceLocale =
    opts.sourceLocale || LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale

  const entities = []
  const warnings = []
  const models = new Set()
  for (const { name, decl } of mapped) {
    const declaration = resolveDeclaration(schema, decl.model)
    if (!declaration) {
      throw new Error(
        `uwx/collections: Model "${decl.model}" (collection "${name}") is not ` +
          'defined by the local foundation. v1 needs the Model declared ' +
          'locally; shared/registry-only Models are not yet supported.'
      )
    }
    const records = await loadRecords(siteRoot, name, decl)
    if (records == null) {
      warnings.push(
        `${name}: not a file-based (\`path:\`) collection — skipped`
      )
      continue
    }
    const mappedOut = collectionRecordsToEntities({
      collectionName: name,
      records,
      declaration,
      idResolver: id,
      sourceLocale,
    })
    entities.push(...mappedOut.entities)
    warnings.push(...mappedOut.warnings)
    models.add(decl.model)
  }

  if (entities.length === 0) {
    throw new Error(
      'uwx/collections: no records to export (mapped collections were empty or skipped)'
    )
  }

  id.flush()

  const buffer = emitEntityPackage({
    entities,
    // names-only: the importer resolves each Model by name (no uuids).
    modelsRequired: [...models].map((name) => ({ name_at_export: name })),
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })

  return { buffer, models: [...models], entityCount: entities.length, warnings }
}
