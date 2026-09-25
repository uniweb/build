// Map a site's file-based collections to exchange (`.uwx`) ENTITIES of a Model
// referenced BY NAME, on the entity-content SYNC lane.
//
// Each record becomes a section-keyed `$`-document (docs/reference/entity-content.md):
// `$id` (the producer-local handle), `$schema` (its data schema, by scoped name), and
// each section the record holds, keyed by its name — the brief, the other single
// sections, and `many` sections as lists of records. The backend MINTS `$uuid` on first
// sync and returns it in the finalized response; the verb back-fills it into the source
// file. A record that already carries `$uuid` (a prior back-fill) round-trips it
// for restore-in-place. No id sidecar — identity is the file-embedded `$uuid` plus
// the back-fill round-trip.
//
// To shape each record, the mapper needs the Model's declaration — its sections, their
// field order, and which fields are localized. The orchestrator reads that from the
// LOCAL foundation's built `dist/meta/schema.json` (lowered via
// `toDataSchemaDeclaration`, the same path `uniweb register` uses), so it stays offline,
// or, for a Model no local foundation defines, through the injected `opts.resolveModel`.
//
// ⭐ A RECORD FILE IS READ BY ITS SCHEMA'S LAYOUT (`./record-layout.js`): flat when the
// schema has one top-level section holding one record, by section otherwise — which is
// also the only way a `many` section, a self-nesting list (`children:` in the file,
// `$children` on the wire) or a schema whose root is a list (`@std/nav`) is written.
// Nested sections are encoded by their own declaration, so a localized field inside one
// is wrapped per locale like any other.
//
// ⭐ A REFERENCE (`entity_ref`) NAMES ITS RECORD BY HANDLE in a file — `speaker: ada`,
// the target's file name or its `slug:` — and is sent as the uuid THIS backend minted for
// that record (`refResolver`). A target this backend has not minted yet is new, so this
// push creates it, and the reference names it by its `$id` in the package —
// `speaker: { $ref: "speaker/ada" }` — which the backend resolves to the uuid it mints.
// One push creates both. ⛔ Until 2026-09-25 such a referrer WAITED, sent without the
// reference or held back, and the CLI pushed again to complete it.
// ⚠️ item_ref and file fields are still sent as the file writes them.
//
// ⭐ A record of a `many` section — an ITEM of a record's list — carries the `$uuid` the backend
// gave it once the backend holds it, from a bank the CLI keeps per record (`record-items.js`,
// stamped in `sync-package.js`). Sent without it, a record whose list the backend holds is
// REFUSED, whole (`identity_required`): applied, it would re-identify every stored item —
// measured 2026-09-25 on an edit of a talk, before the bank existed.

import { readBackendState } from './sync-store.js'
import { dataKeyTypes, keyOfDefaultRef } from './data-key-types.js'
import { readFileSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { detectFoundationType } from '../site/foundation-ref.js'
import { join, resolve } from 'node:path'

import { resolveQueriesConfig } from './queries-config.js'
import { readEntityFile } from './entity-source.js'
import { readRecordsConfig, resolveFolder } from '../site/records-config.js'
import {
  readEntityPool,
  groupPoolBySchema,
  poolPathReadings,
  poolDirsForSchema,
} from '../site/entity-pool.js'
import { toDataSchemaDeclaration, isProseMirrorField, isMarkupTextField } from './data-schema.js'
import { recordFileLayout, contentBodyTarget } from './record-layout.js'
import { emitEntitySyncPackage } from './entity-document.js'
import { resolveSelfScope, siteSelfScope, refuseOrgOption } from './self-scope.js'
import { sha256Hex, toJsonBuffer } from './manifest.js'
import { isUuid } from './uuid.js'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { LOCALIZED_FIELD_ASSUMPTION, localize } from './localize.js'
import { localizeScalar, localizeScalarList, localizeContentDoc, loadLocaleTranslations, discoverLocales, discoverFreeformLocales, localesDir, isLocalizedContent } from './locale-sync.js'
import { loadFreeformRecord } from '../i18n/freeform.js'
import { isDraftRecord } from '../site/record-draft.js'

const DATE_KINDS = new Set(['date', 'datetime'])
// The record's OWN keys — identity and transport, never a field of any section, never
// warned. `$body` carries the markdown body (mapped to the schema's content body field,
// wherever a single section declares it).
// Note: there is NO delivery-derived ignore list (route/excerpt/image/content) —
// the source reader never produces those, and a real unknown key SHOULD warn (it
// means the frontmatter doesn't match the collection's data schema).
const RECORD_KEYS = new Set([
  'slug',
  '$id',
  '$uuid',
  '$schema',
  '$owner',
  '$unit',
  '$meta',
  '$body',
  // The draft flag (`site/record-draft.js`) — framework's, never a Model field. It
  // travels as the entity's `$disabled` (see the document below).
  'draft',
])

// Recursively drop IDENTITY `$`-sigil keys (`$uuid`/`$id`/`$schema`/… — never
// field data; the sigil-exclusivity invariant guarantees this) at every level,
// so a back-filled `$uuid` doesn't change the hash. Three are exceptions, because
// they are content rather than identity:
//   - `$children` is STRUCTURAL content (a self-nesting record's subtree, e.g.
//     site-content's nested pages/sections), so it is KEPT and recursed into —
//     otherwise a nesting change would be invisible to "send only changed". A record
//     of a self-nesting list (`children:` in its file) carries them too.
//   - `$disabled` is a record's delivery STATE (`draft: true` on the file side). It
//     is KEPT so that drafting or un-drafting a record with nothing else changed is
//     still sent; stripped, "send only changed" would never send the toggle.
//   - `$ref` is a REFERENCE to a record the same push creates (`speaker: { $ref:
//     "speaker/ada" }`), and which record it names is content. Once the backend has
//     minted that record the next push names it by uuid instead — so the CLI re-banks a
//     record that sent a `$ref` after its push (`namesNew`, `sync-package.js`). The
//     folder's ref leaf is not this case: see below.
function stripSigils(value) {
  if (Array.isArray(value)) return value.map(stripSigils)
  if (value && typeof value === 'object') {
    // ⛔ A `@uniweb/folder` REF LEAF ENCODES ONE REFERENCE TWO WAYS, and hashing the
    // encoding rather than the reference made the folder's hash unreproducible.
    //
    // `refLeaf` (uwx/folder.js) emits `entry: { $ref: <the record's $id> }` — the pool
    // position `<dirs>/<slug>` — while the record is brand-new, and `entry: { schema,
    // entity: <uuid> }` once it has been minted. (`$ref` was a key of the leaf itself
    // until 2026-09-25, when the backend made it a reference's value.)
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
    // `name` (the record's handle) at its position inside the branch that holds it.
    // Two siblings may share a name — records of different schemas can — and position
    // still tells them apart; a leaf that comes to reference another record arrives
    // with that record changed, which re-sends the folder anyway. `entry` carries a
    // payload-local handle or an identity, and both are exactly what `$uuid` is
    // stripped for.
    //
    // ⚖️ The previous rule kept `$ref` "so a reference change is visible". It still
    // is: point a leaf at a different record and its `name` moves with it.
    const isFolderRefLeaf = value.kind === 'ref'
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (isFolderRefLeaf && k === 'entry') continue
      // `$children` (a self-nesting subtree), `$disabled` (a delivery state) and `$ref`
      // (a reference to a record of the same push) are CONTENT, not identity sigils —
      // kept, so a change to any of them stays visible.
      if (k === '$children' || k === '$disabled' || k === '$ref') {
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
    // A list of localized values rides as a list of `{ lang: value }` maps, one per
    // element — the shape page `keywords` already take. ⛔ It went up as a bare list
    // until 2026-09-24: `localizeScalar` passes any object through, arrays included.
    if (Array.isArray(value) && !isMarkupTextField(field)) {
      return localizeScalarList(value, sourceLocale, translations)
    }
    // A markup `text` BODY (format markdown|html) rides as a RAW string, wrapped
    // per-locale wholesale (its per-string translations live in the i18n manifest /
    // free-form, not the scalar map). Other localized scalars wrap per-string from
    // locales/records/{locale}.json.
    return isMarkupTextField(field)
      ? localize(value, sourceLocale)
      : localizeScalar(value, sourceLocale, translations)
  }
  // A Date handed in by a caller. The backend validates `date` as `YYYY-MM-DD` and
  // `datetime` as RFC3339 — emitting full ISO for a `date` field is rejected before
  // storage, so split by kind. ⚠️ A record READ from a file never carries one: the
  // build's YAML resolves no timestamps (`utils/yaml-schema.js`), so an unquoted
  // `2026-03-01` is the string as written, the same value a quoted one always was.
  if (DATE_KINDS.has(field.type) && value instanceof Date) {
    return field.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value
}

/**
 * Map records of one schema to entity-content `$`-documents of
 * `declaration`'s Model. PURE — records + declaration in, entity descriptors out;
 * no I/O, no minting. The backend mints `$uuid` on first sync; a record that
 * already carries `$uuid` (back-filled from a prior sync) round-trips it.
 *
 * A record is read by its schema's layout (`./record-layout.js`): FLAT when the schema
 * has one top-level section holding one record, its keys that section's fields; BY
 * SECTION otherwise, each top-level section under its own name. Either way the document
 * is the same section-keyed shape, so a pull writes the record back as it was written.
 *
 * @param {object} params
 * @param {string} params.label  - what the records are, for messages and the path
 *        inside the package — the schema folder they came from (`article`,
 *        `std/person`)
 * @param {object[]} params.records        - [{ slug, ...the file's keys }], a
 *        markdown body under `$body`
 * @param {object} params.declaration      - the `@uniweb/data-schema` declaration
 *        (from toDataSchemaDeclaration): `{ name, sections }`
 * @param {string} [params.sourceLocale]   - locale for localized-field wrap
 * @param {object} [params.translations]   - `{ locale: { hash: tgt } }` for wrapping
 *        localized scalar fields per-locale (from loadLocaleTranslations)
 * @param {{ resolve: (model: string, value: *) => object }} [params.refs] - what a
 *        reference sends (`refResolver`). Without it a reference is sent as written.
 * @returns {{ entities: object[], warnings: string[], refusals: string[] }} each
 *   entity is `{ id, uuid, slug, model, file, document, namesNew }` — `document` is the
 *   section-keyed body, and `namesNew` how many of its references name a record this
 *   push creates, by `$ref`. `refusals` names the records that cannot be sent as
 *   written, one line each; a caller that sends must not send while any is present.
 */
export function recordsToEntities({
  label,
  records,
  declaration,
  sourceLocale = LOCALIZED_FIELD_ASSUMPTION.defaultSourceLocale,
  translations,
  refs = null,
}) {
  if (!declaration || !declaration.name) {
    throw new Error('uwx/records: a declaration with a name is required')
  }
  const layout = recordFileLayout(declaration)
  if (layout.sections.length === 0) {
    throw new Error(`uwx/records: ${declaration.name} declares no sections`)
  }
  // The markdown body of a `.md` record is the value of the schema's CONTENT body field,
  // wherever a top-level single section declares it — the brief, or a body section like
  // `article_body.content`. One field is the target; zero means a body has nowhere to go.
  const { target: bodyTarget, count: bodyFields } = contentBodyTarget(declaration)

  const entities = []
  const warnings = []
  // Records that cannot be sent as written — see the ⛔ below.
  const refusals = []
  if (bodyFields > 1) {
    warnings.push(
      `${label}: ${declaration.name} has more than one content ` +
        `(markdown / html / prosemirror) field — the markdown body maps to ` +
        `"${bodyTarget.section}.${bodyTarget.key}"`
    )
  }
  for (const record of records || []) {
    const slug = record.slug
    if (!slug) {
      warnings.push(`${label}: a record without a slug was skipped`)
      continue
    }
    const where = `${label}/${slug}`
    // ⛔ `$id` IS NOT THE SLUG. It is the payload-local, PATH-QUALIFIED handle, so
    // the @uniweb/folder entity can point a leaf at it via `$ref`. An explicit
    // frontmatter `$id` wins.
    //
    // ⚠️ The authoritative value is the record's POOL POSITION — `<dirs>/<slug>` —
    // and it is set upstream, where the records directory is walked; see the ⭐
    // comment there, which is where the reasoning lives. `<label>/<slug>` below is
    // only the fallback for a record that did not arrive that way.
    //
    // The qualification is a CONSTRAINT, not a style: the sync response is keyed per
    // (`$schema`, `$id`), so a bare slug would collide whenever two schema folders
    // resolving to one Model reuse one (see the duplicate check). ⇒ Do not describe this
    // value as "the slug" — the folder leaf's `name` is the bare segment, and
    // conflating the two has already misdirected a naming decision.
    const id = record.$id || `${label}/${slug}`
    const uuid = record.$uuid || null
    const hasBody = typeof record.$body === 'string' && record.$body.trim() !== ''

    const enc = encoder(sourceLocale, translations, refs)
    const sections = layout.flat ? readFlat(layout, record, enc) : readBySection(layout, record, enc)
    // The markdown body fills the content body field, in whatever section declares it,
    // unless the file already sets that field.
    if (hasBody && bodyTarget) {
      const data = (sections[bodyTarget.section] ??= {})
      if (data[bodyTarget.key] == null) {
        data[bodyTarget.key] = encodeFieldValue(record.$body, bodyTarget.field, sourceLocale, translations)
      }
    }
    // The brief is the card, and is always sent — an empty one included, so a required
    // field it lacks is refused here rather than stored empty.
    if (layout.brief && !sections[layout.brief]) sections[layout.brief] = {}

    // ⛔ A RECORD THE BACKEND WOULD REFUSE — OR WOULD STORE EMPTY — IS REFUSED HERE,
    // before anything is sent: a key written where the schema has no place for it
    // (flat in a schema written by section, or declared nowhere), a value of the wrong
    // shape for its section, a markdown body with no field to hold it, and a `required`
    // field the send would lack. Measured 2026-09-23: a record the backend refused
    // left the folder's entries with no data behind them, and every later push of the
    // site's records was refused. The backend's push has been one transaction since
    // 2026-09-24, so a refusal now writes nothing — but what a push cannot carry is
    // still lost twice over: the backend never receives it, and the next pull writes
    // the file without it.
    if (enc.misplaced.length) refusals.push(bySectionRefusal(where, declaration.name, layout, enc.misplaced))
    if (enc.undeclared.length) {
      const one = enc.undeclared.length === 1
      refusals.push(
        `${where}: ${quoted(enc.undeclared)} ${one ? 'is not a field' : 'are not fields'} of ` +
          `${declaration.name} — a push cannot carry ${one ? 'it' : 'them'}, and the next pull would ` +
          `drop ${one ? 'it' : 'them'} from the file. Declare ${one ? 'it' : 'them'} in the schema, ` +
          `or remove ${one ? 'it' : 'them'}.`
      )
    }
    for (const problem of enc.shape) refusals.push(`${where}: ${problem}`)
    for (const bad of enc.unresolved) refusals.push(`${where}: ${describeUnresolved(bad)}`)
    if (hasBody && !bodyTarget) {
      refusals.push(
        `${where}: the file has a markdown body, and ${declaration.name} has no field for ` +
          'it (a `markdown` or `richtext` field) — a push cannot carry it. Add one to the schema, ' +
          'or move the text into a field.'
      )
    }
    if (!enc.misplaced.length && !enc.shape.length) {
      const missing = missingRequired(layout, sections)
      if (missing.length) {
        refusals.push(
          `${where}: ${declaration.name} requires ${listOf(missing)}, and this record ` +
            `has no value for ${missing.length === 1 ? 'it' : 'them'}.`
        )
      }
    }

    // The `$`-document, in canonical key order: `$uuid?`, `$id`, `$schema`, `$disabled?`,
    // then the brief (the card) and every other section the record holds, in declared
    // order. `$owner`/`$unit`/`$meta` are omitted — the backend binds owner + unit on
    // its side.
    const document = {}
    if (uuid) document.$uuid = uuid
    document.$id = id
    document.$schema = declaration.name
    // ⭐ A DRAFT IS SENT AS A DISABLED ENTITY: it stays in the folder and is never
    // publicly delivered. Only `true` travels. An absent key means enabled [Diego,
    // 2026-09-21], so a record whose `draft: true` is removed is sent without the key
    // and is delivered again.
    if (isDraftRecord(record, where)) document.$disabled = true
    if (layout.brief) document[layout.brief] = sections[layout.brief]
    for (const [name] of layout.sections) {
      if (name !== layout.brief && sections[name] !== undefined) document[name] = sections[name]
    }

    entities.push({
      id,
      uuid,
      slug,
      model: declaration.name, // reference the Model BY NAME — importer resolves it
      // The file's place inside the package — opaque to the reader, which follows
      // `entries[].file` (`entity-document.js`). Label + slug, not `$id`: a slug is
      // unique within its schema folder, and an authored `$id` need not be.
      file: `entities/${label}/${slug}.json`,
      document,
      namesNew: enc.namesNew,
    })
  }
  return { entities, warnings, refusals }
}

// What one record's read collects beside the values: the keys with no place in the
// schema, the keys written flat in a schema written by section, and values of the
// wrong shape for their section.
function encoder(sourceLocale, translations, refs = null) {
  return { sourceLocale, translations, refs, undeclared: [], misplaced: [], shape: [], unresolved: [], namesNew: 0 }
}

// A flat record: its keys, minus the record's own, are the one section's fields.
function readFlat(layout, record, enc) {
  const [name, def] = layout.sections[0]
  const values = {}
  for (const [key, value] of Object.entries(record)) {
    if (!RECORD_KEYS.has(key)) values[key] = value
  }
  // The record's handle fills a `slug` field the section declares, as the flat form
  // always has (`@std/article`'s brief has one). Written by section, the field is
  // written under its section like any other.
  if (record.slug !== undefined && Object.hasOwn(def.fields || {}, 'slug') && values.slug === undefined) {
    values.slug = record.slug
  }
  return { [name]: encodeRecord(def.fields, values, enc, '', null) }
}

// A record written by section: each top-level key names a section of the schema. A key
// that is instead a FIELD of one is the retired flat form — refused, naming the section
// it belongs under — and a key that is neither is undeclared.
function readBySection(layout, record, enc) {
  const byName = new Map(layout.sections)
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    if (RECORD_KEYS.has(key)) continue
    const def = byName.get(key)
    if (def) {
      const encoded = encodeSection(def, value, enc, key)
      if (encoded !== undefined) out[key] = encoded
      continue
    }
    const owners = layout.sections.filter(([, s]) => s.fields && Object.hasOwn(s.fields, key)).map(([n]) => n)
    if (owners.length) enc.misplaced.push({ key, owners })
    else enc.undeclared.push(key)
  }
  return out
}

// A section's value: one record for a single section (a binder included — its fields
// are its child sections), a list of records for a `many` one.
function encodeSection(def, value, enc, path) {
  if (def.multiple === true) {
    if (!Array.isArray(value)) {
      enc.shape.push(`"${path}" holds a list of records — write it as a list ("- …" under "${path}:").`)
      return undefined
    }
    return value.map((item, i) => encodeItem(def, item, enc, `${path}[${i}]`))
  }
  if (!isPlainObject(value)) {
    enc.shape.push(`"${path}" is a section — write its fields under it ("${path}:" then each field indented).`)
    return undefined
  }
  return encodeRecord(def.fields, value, enc, `${path}.`, null)
}

// One record of a `many` section. A self-nesting section's records nest under the
// reserved `children:` key in a file (as `@std/nav` documents it) and under
// `$children` on the wire, where the backend derives each one's parent.
function encodeItem(def, item, enc, path) {
  if (!isPlainObject(item)) {
    enc.shape.push(`"${path}" is one record of a list — write it as a map of its fields.`)
    return {}
  }
  const nests = def.self_nesting === true
  const out = encodeRecord(def.fields, item, enc, `${path}.`, nests ? 'children' : null)
  if (nests && item.children !== undefined) {
    if (!Array.isArray(item.children)) {
      enc.shape.push(`"${path}.children" nests records under this one — write it as a list.`)
    } else {
      out.$children = item.children.map((child, j) => encodeItem(def, child, enc, `${path}.children[${j}]`))
    }
  }
  return out
}

// Encode one record's fields in declared order — a nested section by its own
// declaration, a leaf by its kind. A key the fields do not declare is recorded as
// undeclared; `$`-keys (identity a pull may have left on a record) are not content, and
// `reserved` is the one extra key a caller allows (`children`, on a self-nesting list).
function encodeRecord(fields, value, enc, prefix, reserved) {
  const out = {}
  for (const [key, field] of Object.entries(fields || {})) {
    const v = value[key]
    if (v === undefined) continue
    const encoded =
      field?.type === 'section'
        ? encodeSection(field, v, enc, `${prefix}${key}`)
        : field?.type === 'entity_ref'
          ? encodeReference(v, field, enc, `${prefix}${key}`)
          : encodeFieldValue(v, field, enc.sourceLocale, enc.translations)
    if (encoded !== undefined) out[key] = encoded
  }
  for (const key of Object.keys(value)) {
    if (key === reserved || key.startsWith('$') || Object.hasOwn(fields || {}, key)) continue
    enc.undeclared.push(`${prefix}${key}`)
  }
  return out
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A reference, as a push sends it: the uuid this backend minted for the record the file
// names (`refResolver`) — or, for a record it has not minted, which this push creates,
// `{ $ref: <that record's $id> }`, the backend's name for a record of the same package.
// A list of them is each of those. Without a resolver, and for a reference open to
// several Models (which our schemas do not author), the value is sent as written.
function encodeReference(value, field, enc, path) {
  if (!enc.refs || typeof field.model !== 'string') return value
  if (field.multiple === true) {
    if (!Array.isArray(value)) {
      enc.shape.push(`"${path}" is a list of references — write it as a list of record names.`)
      return undefined
    }
    const sent = []
    value.forEach((one, i) => {
      const ref = resolveReference(one, field, enc, `${path}[${i}]`)
      if (ref !== undefined) sent.push(ref)
    })
    return sent
  }
  return resolveReference(value, field, enc, path)
}

function resolveReference(value, field, enc, path) {
  const answer = enc.refs.resolve(field.model, value)
  if (answer.uuid) return answer.uuid
  if (answer.ref) {
    enc.namesNew++
    return { $ref: answer.ref }
  }
  enc.unresolved.push({ path, model: field.model, value, ...answer })
  return undefined
}

// Why a reference names no record the push can send.
function describeUnresolved({ path, model, value, invalid, ambiguous }) {
  if (invalid) return `"${path}" is a reference — write the name of the ${model} record it points at.`
  if (ambiguous) return `"${path}" names "${value}", and more than one record of ${model} is called that — give them distinct names.`
  return `"${path}" names "${value}", and no record of ${model} is called that — write the name of one, or remove the reference.`
}

// Which record a reference names, and what a push sends for it: the uuid THIS backend
// minted for that record. A record is named by its handle — its file's name, or its
// `slug:` — among the records of its Model. A uuid is taken as written too: the record's
// own id (mapped like a handle's), or the backend's id of a record the project does not
// hold, which is what a pull writes for one.
//
// ⭐ A record this backend has not minted yet — never pushed there — answers with its
// `$id` (`ref`): it is new, so this push creates it, and the backend takes
// `{ $ref: <$id> }` for a record of the same package. A uuid it did not mint is never
// sent (see `buildRecordEntities`).
const AMBIGUOUS = Symbol('ambiguous')
function refResolver(readSchemas, recordMap) {
  const byModel = new Map() // Model → handle → the record: its own id (null before its first push) and `$id`
  const byOwnId = new Map() // the record's own id → the record
  for (const { declaration, flat } of readSchemas) {
    let names = byModel.get(declaration.name)
    if (!names) byModel.set(declaration.name, (names = new Map()))
    for (const rec of flat) {
      const own = typeof rec.$uuid === 'string' && rec.$uuid ? rec.$uuid : null
      const record = { own, id: rec.$id }
      names.set(rec.slug, names.has(rec.slug) ? AMBIGUOUS : record)
      if (own) byOwnId.set(own, record)
    }
  }
  const sent = ({ own, id }) => (own && recordMap[own] ? { uuid: recordMap[own] } : { ref: id })
  return {
    resolve(model, value) {
      if (typeof value !== 'string' || value === '') return { invalid: true }
      const names = byModel.get(model)
      if (names?.has(value)) {
        const record = names.get(value)
        return record === AMBIGUOUS ? { ambiguous: true } : sent(record)
      }
      if (isUuid(value)) return byOwnId.has(value) ? sent(byOwnId.get(value)) : { uuid: value }
      return { missing: true }
    },
  }
}

// "a", "a and b", "a, b and c" — items are already formatted.
function listOf(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const quoted = (keys) => listOf(keys.map((k) => `"${k}"`))

// A schema written by section — more than one section, or a list at its root — takes no
// field at the top of the file: say where each one written there belongs. A field that
// single sections declare belongs under one of them (named with every candidate, since
// sections are namespaces and only the author knows which one they meant); a field only
// a list declares goes into one of the list's records.
function bySectionRefusal(where, modelName, layout, misplaced) {
  const multiple = new Map(layout.sections.map(([n, s]) => [n, s.multiple === true]))
  const moves = []
  const bySection = new Map()
  for (const { key, owners } of misplaced) {
    const singles = owners.filter((o) => !multiple.get(o))
    if (singles.length === 1) {
      if (!bySection.has(singles[0])) bySection.set(singles[0], [])
      bySection.get(singles[0]).push(key)
    } else if (singles.length > 1) {
      moves.push(`"${key}" under ${listOf(singles.map((o) => `"${o}:"`)).replace(/ and ([^ ]+)$/, ' or $1')}`)
    } else {
      moves.push(`"${key}" into a record of ${listOf(owners.map((o) => `"${o}:"`)).replace(/ and ([^ ]+)$/, ' or $1')}`)
    }
  }
  const grouped = [...bySection].map(([section, keys]) => `${quoted(keys)} under "${section}:"`)
  const names = layout.sections.map(([n]) => n)
  return (
    `${where}: ${modelName} is written by section, each section under its own name ` +
    `(${quoted(names)}) — move ${listOf([...grouped, ...moves])}.`
  )
}

// The `required` fields the send would lack — checked in every record the send holds:
// the brief (always sent), each other single section the record fills, each record of a
// list, and the records nested in them. Each is named by its path in the file —
// `"title"` in a flat record, `"details.title"` or `"sessions[0].title"` in one written
// by section. A field counts as present when the send carries a value for it (`null`
// is none).
function missingRequired(layout, sections) {
  const missing = []
  for (const [name, def] of layout.sections) {
    const value = sections[name]
    if (value === undefined) continue
    const base = layout.flat ? '' : name
    if (def.multiple === true) {
      value.forEach((item, i) => missingIn(def, item, `${base}[${i}]`, missing))
    } else {
      missingIn(def, value, base, missing)
    }
  }
  return missing
}

// `def` is the section (or nested section field) `record` is one record of.
function missingIn(def, record, path, missing) {
  if (!isPlainObject(record)) return
  const at = (key) => (path ? `${path}.${key}` : key)
  for (const [key, field] of Object.entries(def.fields || {})) {
    const value = record[key]
    if (field?.type === 'section') {
      if (field.multiple === true && Array.isArray(value)) {
        value.forEach((item, i) => missingIn(field, item, `${at(key)}[${i}]`, missing))
      } else if (field.multiple !== true && isPlainObject(value)) {
        missingIn(field, value, at(key), missing)
      }
      continue
    }
    if (field?.required === true && value == null) missing.push(`"${at(key)}"`)
  }
  if (def.self_nesting === true && Array.isArray(record.$children)) {
    record.$children.forEach((child, j) => missingIn(def, child, `${path}.children[${j}]`, missing))
  }
}
// Post-pass: override a collection record's localized CONTENT body with a per-locale
// FREE-FORM body when `locales/freeform/{locale}/records/<schema>/<slug>.md` exists
// — the override wins over the structural map, exactly like site-content sections
// (site.js localizeContentTree). Only a `format: prosemirror` localized field can
// take it (it is a PM doc on the wire; a markup `text` body stays a raw string).
// Mutates the entity documents in place. Async — the free-form read hits the disk.
async function applyFreeformRecordOverrides({
  entities,
  declaration,
  sourceLocale,
  targetLocales,
  localesBase,
}) {
  // The body target for a free-form override is the schema's CONTENT body field, wherever
  // a single section declares it — only a localized prosemirror one can take a per-locale
  // doc. ⛔ It looked in the brief alone until 2026-09-24, so `@std/article`'s
  // `article_body.content` never took its translation.
  const { target } = contentBodyTarget(declaration)
  if (!target || !isProseMirrorField(target.field) || !target.field.localized) return
  const { section: sectionName, key: contentKey } = target

  for (const entity of entities) {
    const data = entity.document?.[sectionName]
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

// The queries over the SITE'S records — every declaration with a schema, which is
// every one without `url:` (an external query's records are its address's).
//
// ⛔ They do not decide what is pushed: the records directory does. A query matters
// here for two things only — whether its schema was ASKED FOR (an explicit schema
// that resolves to nothing is an error, a defaulted one is not), and which queries
// ship as static files because their schema resolved to nothing.
function siteQueries(declarations) {
  const out = []
  for (const decl of Object.values(declarations)) {
    if (decl.schema || decl.model) out.push({ name: decl.name, decl })
  }
  return out
}

// Replace each folder leaf — which names a FILE — with one leaf per record that file
// produced, and drop a leaf whose file produced none.
//
// ⭐ A FILE IS NOT ALWAYS ONE RECORD, and a record's `$id` is not always its file's
// stem. A BibTeX or array-form file holds several; a `.md` whose frontmatter sets
// `slug:` is one record named for that slug. The folder placed files and the payload
// carries records, so until 2026-09-21 every such leaf pointed at an id nothing
// produced and was dropped with a warning — harmless while `records.yml` rarely listed
// those files, and on every push once every file in the directory is placed.
//
// ⚠️ A file that produced nothing is dropped WITHOUT a warning here: its schema did
// not resolve (reported as schemaless), or its records were skipped (reported while
// reading them). Saying it a second time, as a folder problem, names the wrong cause.
function placeProducedRecords(nodes, producedBy) {
  const out = []
  for (const node of nodes || []) {
    if (node?.kind === 'branch') {
      out.push({ ...node, $children: placeProducedRecords(node.$children, producedBy) })
      continue
    }
    for (const r of producedBy.get(node?.$entityId) || []) {
      out.push({ kind: 'ref', name: r.slug, $entityId: r.id })
    }
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
    const siteYml = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
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

/**
 * Build the record entity descriptors + back-fill index for a site's records —
 * PURE assembly (no hashing, no emit), so it composes with other entity sources
 * (e.g. site-content) into one sync package. First sync sends no `$uuid` (the
 * backend mints); re-sync round-trips the back-filled `$uuid`. Throws on an
 * unresolvable EXPLICIT Model, an invalid `records/folder.yml`, or a duplicate
 * ($schema, $id) within the submission.
 *
 * @param {string} siteRoot - directory containing site.yml
 * @param {object} [opts]
 * @param {string} [opts.foundationDir]   - explicit local foundation root
 * @param {(name: string) => Promise<object|null>} [opts.resolveModel] - async
 *        resolver for a Model NOT defined by the local foundation; returns the
 *        `@uniweb/data-schema` declaration (or null). The verb wires this to the
 *        backend's Model-read route. Without it, the local foundation is required.
 * @param {string} [opts.sourceLocale]    - localized-field wrap locale
 * @param {string|null} [opts.scope] - the scope a record's `@/x` Model resolves into.
 *        Defaults to the site's foundation's (`siteSelfScope`); a caller that has it
 *        already passes it, so one emit reads it once.
 * @returns {Promise<{ entities: object[], index: object[], warnings: string[],
 *   refusals: string[], schemaless: Array<{name: string, model: string}>,
 *   colConfig: object, folder: object, recordsDirExists: boolean }>}
 *   `refusals` — records that cannot be sent as written (`recordsToEntities`).
 *   `schemaless` lists the QUERIES whose schema resolved to nothing (the
 *   convention-default soft-skip) — their records are not pushed as entities, and
 *   the composite deploy delivers those queries statically instead.
 *   `recordsDirExists` is false for a site with no records directory at all.
 *   `sendFolder` is whether a push sends the folder — see `sendsFolder`.
 */
export async function buildRecordEntities(siteRoot, opts = {}) {
  // ⭐ EVERY FILE IN `records/` IS A RECORD, AND EVERY RECORD IS PUSHED (ruled
  // 2026-09-21 [Diego]). Placing a file in the directory is what makes it one —
  // the file-side counterpart of placing a ref in the backend's folder — so nothing
  // lists it and nothing leaves it out. `records/folder.yml` only sorts records into
  // sub-folders. A file named with a leading `_` is not read, so it is not a record.
  //
  // ⛔ A PUSHED RECORD IS NOT LIVE. It sits in the site's folder on the backend and
  // is served once the SITE is published — publishing the site publishes its folder
  // and what is in it. Nothing here decides that for a record.
  //
  // ⛔ UNTIL 2026-09-21 THE SET WAS `records.yml`'s: an unlisted entity was not
  // pushed, and a missing `records.yml` pushed nothing. The inert state moved with
  // the membership: a site with NO RECORDS DIRECTORY sends no folder and leaves the
  // backend's untouched (`recordsDirExists`), so a site whose records live only on
  // the backend is not emptied by a push of its pages.
  //
  // ⛔ AND THE SET IS NOT A QUERY'S. This walked the queries until 2026-09-21 and
  // mapped each query's records, so two queries over one schema mapped every record
  // twice and the duplicate check refused the push (measured: "appears in more than
  // one query"), and a record no query read was never pushed. Records are walked
  // once, by the schema their folder declares.
  refuseOrgOption(opts, 'uwx/records')
  const pool = await readEntityPool(siteRoot)
  const recordsCfg = await readRecordsConfig(siteRoot, { dir: pool.dir })
  if (recordsCfg.error) throw new Error(`uwx/records: ${recordsCfg.error}`)
  const folder = resolveFolder(recordsCfg.entries, pool.entities, { dir: pool.dir })
  if (folder.errors.length) {
    throw new Error(`uwx/records: ${recordsCfg.file} is invalid —\n  ${folder.errors.join('\n  ')}`)
  }
  const warnings = [...pool.errors, ...folder.warnings]
  const refusals = []

  const colConfig = opts.queriesConfig || (await resolveQueriesConfig(siteRoot))
  const queries = siteQueries(colConfig.declarations)
  const poolBySchema = groupPoolBySchema(pool.entities)
  if (poolBySchema.size === 0 && queries.length === 0) {
    return {
      entities: [],
      index: [],
      warnings,
      refusals,
      schemaless: [],
      colConfig,
      folder: { ...folder, nodes: [] },
      recordsDirExists: pool.exists,
      sendFolder: sendsFolder(pool, []),
      declarations: new Map(),
      keyTyped: new Map(),
    }
  }

  // A Model declaration comes from a LOCAL foundation (offline) or, for a
  // non-local Model, from the injected async `resolveModel(name)` — the verb wires
  // that to the backend's Model-read route (declaration form). The local
  // foundation is required ONLY when no resolver is provided.
  const resolveModel = typeof opts.resolveModel === 'function' ? opts.resolveModel : null
  // The local foundation is REQUIRED only when a query asked for a schema
  // EXPLICITLY (and there's no remote resolver). A schema that only a folder name
  // or a query name supplied soft-skips when nothing resolves, so a delivery-only
  // site with no foundation must not be forced to have one.
  const explicitBy = new Map() // schema (as written) → the first query that asked for it
  for (const { name, decl } of queries) {
    if (decl.schemaExplicit && !explicitBy.has(decl.schema)) explicitBy.set(decl.schema, name)
  }
  const localSchema = loadLocalFoundationSchema(siteRoot, opts, {
    required: !resolveModel && explicitBy.size > 0,
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
  // `declaration.name` — the value that becomes `$schema` — is the resolved one.
  //
  // ⛔ The rule lives in `./self-scope.js`, shared with the `queries` Section
  // (`site.js::queriesNested`): a query's `schema` must name exactly the Model
  // these records are stored under, so both go through one function with one scope.
  //
  // ⭐ THE SCOPE IS THE FOUNDATION'S — the one `register` stored these Models under —
  // never the site owner's (2026-09-22; `self-scope.js` has the record).
  const scope =
    opts.scope !== undefined ? opts.scope : await siteSelfScope(siteRoot, { foundationDir: opts.foundationDir })
  const warnedUnscoped = new Set()
  const modelFor = (schema, where) => {
    const modelName = resolveSelfScope(schema, scope)
    // Unresolvable `@/` — the foundation has no scope yet. Ship it rather than
    // throwing (a `status` probe on a never-registered foundation must still count),
    // but say so: the backend's refusal names a missing Model and cannot name this cause.
    if (modelName === schema && typeof schema === 'string' && schema.startsWith('@/') && !warnedUnscoped.has(schema)) {
      warnedUnscoped.add(schema)
      warnings.push(
        `${where}: \`${schema}\` is foundation-relative and the foundation has no scope yet, ` +
          `so it ships unresolved. The backend resolves Models by name and will refuse it. ` +
          `A foundation's scope is part of its name — \`name: '@org/<name>'\` in its main.js, ` +
          `which \`uniweb register\` writes.`
      )
    }
    return modelName
  }

  // ⚠️ AN EXPLICIT SCHEMA THAT RESOLVES TO NOTHING IS THE AUTHOR'S ERROR — and a
  // depth-2 folder has two readings worth naming. `records/person/2024/ada.md`
  // resolves as `@person/2024` — the rule is total, so it is not ambiguous — but an
  // author who meant "records organised by year inside the `person` schema" needs to
  // be told what the build actually read, not only that something failed to resolve.
  const unresolvedExplicit = (modelName, queryName) => {
    const dirs = poolDirsForSchema(modelName)
    const { alternative } = dirs ? poolPathReadings(dirs) : { alternative: null }
    return new Error(
      `uwx/records: Model "${modelName}" (query "${queryName}") could not be ` +
        'resolved — not defined by a local foundation' +
        (resolveModel
          ? ', and the backend has no such Model (register it first).'
          : '. Run via `uniweb sync` (which fetches non-local Models from the ' +
            'registry), or provide a local foundation that defines it.') +
        (alternative
          ? ` If you meant \`${pool.dir}/${dirs[0]}/\` (${alternative}) organised by ` +
            `\`${dirs[1]}\`, note that a folder inside a schema folder is read as an ` +
            `org scope. Organise records in records/folder.yml, not on disk.`
          : '')
    )
  }

  // ⭐ A NAME THAT IS A DATA KEY, NOT A DATA SCHEMA [Diego, 2026-09-25] (`data-key-types.js`):
  // a records folder or a query whose name-defaulted schema (`@/team`) resolves to nothing,
  // while the foundation's section types type the data key of that name (`team: '@/member'`),
  // holds records of that type. `keyTyped` records each such name for the `queries` Section,
  // which must name the same data schema (`sync-package.js` hands it on). ⛔ Never for a schema
  // a query asked for explicitly: that one is the author's, and fails loudly.
  const keyTypes = dataKeyTypes(localSchema)
  const keyTyped = new Map()
  const typedFor = async (schema) => {
    const key = keyOfDefaultRef(schema)
    const type = key ? keyTypes.get(key) : null
    if (!type || explicitBy.has(schema)) return null
    const declaration = await declarationFor(modelFor(type, `data key "${key}"`))
    if (!declaration) return null
    keyTyped.set(schema, type)
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

  // ⭐ THE FILE'S `$uuid` IS OURS; THE WIRE'S IS THE BACKEND'S (2026-09-20).
  //
  // A record's `$uuid` is its stable identity and travels with the file, so moving
  // or renaming it changes nothing. What goes on the WIRE to backend B is the uuid B
  // minted for it — looked up in `sync.json::backends.<B>.records` — or none, so B
  // mints one. ⛔ Never send a backend a uuid it did not mint: whether it would
  // accept one is the backend's to say, and this is correct either way.
  //
  // For the FIRST backend a record reaches, B's minted uuid is written into the
  // file and the map is identity — exactly what happened before this change, so a
  // single-backend project behaves as it always did.
  const recordMap = opts.backend ? readBackendState(siteRoot, opts.backend).records || {} : {}

  const entities = []
  const index = []
  // pool id (the FILE) → the records it produced, so the folder places records.
  const producedBy = new Map()
  // Schemas (as written) whose Model resolved to nothing — soft-skipped.
  const unresolved = new Set()
  // The sync response is keyed per ($schema, $id), so the pair must be unique
  // within one submission.
  const seen = new Set()

  // ⭐ EVERY MODEL'S RECORDS ARE READ BEFORE ANY IS MAPPED: a reference names a record
  // of another Model by its handle (`speaker: ada`), and the push sends that record's
  // uuid in its place — or its `$id`, while it is new (`refResolver`).
  const readSchemas = []
  // ⛔ ONE RECORD IN TWO FILES — the same own id, its `$uuid`, twice — is refused, naming
  // both. It is not two records, and sent, both would claim one entity. A pull could write
  // one until 2026-09-25: under a foundation in `@std`, a standard `@std/person` record was
  // written again into `records/person/`, beside the author's `records/std/person/`
  // (`self-scope.js::unresolveSelfScope`), and a push then reported only a name two
  // records share.
  const fileByOwnId = new Map()
  for (const [schema, poolEntities] of poolBySchema) {
    const label = poolEntities[0].dirs.join('/')
    const modelName = modelFor(schema, `${pool.dir}/${label}/`)
    const declaration = (await declarationFor(modelName)) || (await typedFor(schema))
    if (!declaration) {
      // An explicit schema the author asked for is a hard error; one only the
      // folder's name supplied is a soft skip, reported below.
      if (explicitBy.has(schema)) throw unresolvedExplicit(modelName, explicitBy.get(schema))
      unresolved.add(schema)
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
      const produced = []
      for (const r of await readEntityFile(pooled.absPath)) {
        if (!r.slug) {
          warnings.push(`${pooled.relPath}: a record without a slug was skipped`)
          continue
        }
        // A draft is a record like any other, placed in the folder; the mapper sends it
        // disabled. Checked here too so that a malformed `draft:`, or the retired
        // `published: false`, is refused naming the FILE rather than the record.
        isDraftRecord(r.data, r.multiRecord ? `${pooled.relPath} (${r.slug})` : pooled.relPath)
        const rec = { ...r.data, slug: r.slug }
        if (r.body !== undefined) rec.$body = r.body
        // ⭐ THE RECORD'S IDENTITY IS ITS POSITION IN THE DIRECTORY — `<dirs>/<slug>`,
        // unique by construction and derivable on both sides. The folder must
        // reference the very records the payload carries.
        //
        // ⚠️ A multi-record file (array YAML, BibTeX) contributes several records
        // from one path, so the slug — not the file stem — completes the id.
        rec.$id = rec.$id || [...pooled.dirs, r.slug].join('/')
        const ownId = typeof rec.$uuid === 'string' && rec.$uuid ? rec.$uuid : null
        const firstFile = ownId ? fileByOwnId.get(ownId) : undefined
        if (firstFile && firstFile !== pooled.relPath) {
          refusals.push(
            `${pooled.relPath}: holds the same record as ${firstFile} — both carry ` +
              `\`$uuid: ${ownId}\` — so a push would send one record twice. Keep one of them.`
          )
        } else if (ownId) {
          fileByOwnId.set(ownId, pooled.relPath)
        }
        flat.push(rec)
        sourceBySlug.set(r.slug, r)
        produced.push({ id: rec.$id, slug: r.slug })
      }
      producedBy.set(pooled.id, produced)
    }
    readSchemas.push({ label, declaration, flat, sourceBySlug })
  }
  const refs = refResolver(readSchemas, recordMap)

  for (const { label, declaration, flat, sourceBySlug } of readSchemas) {
    const ownIds = new Map()
    const onWire = flat.map((rec) => {
      const own = typeof rec.$uuid === 'string' && rec.$uuid ? rec.$uuid : null
      ownIds.set(rec.slug, own)
      const minted = own ? recordMap[own] : undefined
      const { $uuid: _own, ...rest } = rec
      return minted ? { ...rest, $uuid: minted } : rest
    })

    const mappedOut = recordsToEntities({
      label,
      records: onWire,
      declaration,
      sourceLocale,
      translations,
      refs,
    })
    // Free-form per-locale body overrides (a full localized doc beats the structural
    // map) — only meaningful for a multi-locale site with a prosemirror content field.
    if (targetLocales.length > 0) {
      await applyFreeformRecordOverrides({
        entities: mappedOut.entities,
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
          `uwx/records: duplicate ($schema, $id) in one sync — "${e.id}" of ` +
            `${e.model} comes from more than one record. Each record in a schema ` +
            'folder needs its own slug; make the slugs unique.'
        )
      }
      seen.add(dupKey)
      // The verb back-fills the minted `$uuid` into this source file, matched
      // back from the finalized response by ($schema, $id).
      const src = sourceBySlug.get(e.slug)
      index.push({
        id: e.id,
        model: e.model,
        slug: e.slug,
        // Single-record files render whole; multi-record YAML/JSON files get a
        // per-entry `$uuid` write keyed by slug (see backfill.js). `format` lets
        // the writer route (array-form vs BibTeX, the latter still deferred).
        sourceFile: src ? src.sourceFile : null,
        // The record's OWN id (the file's `$uuid`), or null for one never synced.
        // The back-fill maps it to what the backend returns; see above.
        ownId: ownIds.get(e.slug) ?? null,
        format: src ? src.format : null,
        multiRecord: src ? src.multiRecord : false,
        // Sent disabled, so the back-fill can check that the backend kept it that way.
        draft: e.document.$disabled === true,
      })
    }
    entities.push(...mappedOut.entities)
    warnings.push(...mappedOut.warnings)
    refusals.push(...mappedOut.refusals)
  }

  // Queries whose schema resolved to nothing — not pushed as entities. The composite
  // deploy delivers these statically (the "data ball") instead, so the caller can
  // route them there.
  //
  // ⛔ Deliberately NOT a `warnings` string. This is a product decision the author
  // is making — entities or static files — and it needs to be reported at a
  // prominence a prose warning cannot carry. Callers get the structured entry and
  // say it themselves (`cli/src/commands/{publish,push}.js`). It used to push
  // `"… — not synced"`, printed dim among everything else, and an author read that
  // as "my data did not upload" when it is delivered, as static files.
  const schemaless = []
  for (const { name, decl } of queries) {
    const schema = decl.schema || decl.model
    const hasRecords = poolBySchema.has(schema)
    const resolved = hasRecords
      ? !unresolved.has(schema)
      : Boolean((await declarationFor(modelFor(schema, `query "${name}"`))) || (await typedFor(schema)))
    if (!resolved) {
      if (decl.schemaExplicit) throw unresolvedExplicit(resolveSelfScope(schema, scope), name)
      schemaless.push({ name, model: resolveSelfScope(schema, scope) })
      continue
    }
    if (!hasRecords) {
      // "Nothing pushed" and "nothing there" look identical, so say which.
      const dirs = poolDirsForSchema(schema)
      warnings.push(
        `query "${name}": ${dirs ? `${pool.dir}/${dirs.join('/')}/` : pool.dir + '/'} holds no records of ${schema} — ` +
          'nothing to push for it.'
      )
    }
  }
  // Records whose schema resolved to nothing and that no query reads: they are not
  // pushed, and no static file carries them either — say so, once per folder.
  for (const schema of unresolved) {
    if (queries.some(({ decl }) => (decl.schema || decl.model) === schema)) continue
    const n = poolBySchema.get(schema).length
    warnings.push(
      `${pool.dir}/${poolBySchema.get(schema)[0].dirs.join('/')}/: no data schema resolves for ${schema}, ` +
        `and no query reads ${n === 1 ? 'this record' : `these ${n} records`} — not pushed.`
    )
  }

  const nodes = placeProducedRecords(folder.nodes, producedBy)

  return {
    entities,
    index,
    warnings,
    refusals,
    schemaless,
    colConfig,
    folder: { ...folder, nodes },
    recordsDirExists: pool.exists,
    sendFolder: sendsFolder(pool, entities),
    // Each entity's declaration, by its Model — what walks a record's lists
    // (`record-items.js`).
    declarations: new Map(readSchemas.map(({ declaration }) => [declaration.name, declaration])),
    // A name-defaulted schema that stands for the type of the data key of its name
    // (`@/team` → `@/member`) — see `typedFor` above.
    keyTyped,
  }
}

// Whether this push sends the site's folder — which REPLACES the backend's.
//
// ⭐ Only when the file side has a folder to state: some record was produced, or
// the records directory is there and holds nothing at all (the deliberate empty,
// which removes what the backend has — the CLI asks first).
//
// ⛔ NOT when every record's schema resolved to nothing, nor when the directory
// holds only files that are not records (warned). Neither is an author emptying
// the folder, and sending one would remove the backend's records — including any
// authored there — for a state nobody chose. Inert instead, like no directory.
function sendsFolder(pool, entities) {
  if (!pool.exists) return false
  if (entities.length > 0) return true
  return pool.entities.length === 0 && pool.errors.length === 0
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
 *        warnings: string[], refusals: string[], index: object[],
 *        hashes: Object<string,string>, skipped: number }>}
 */
export async function emitRecordSyncPackage(siteRoot, opts = {}) {
  const { entities, index, warnings, refusals, recordsDirExists } = await buildRecordEntities(siteRoot, opts)
  if (entities.length === 0) {
    throw new Error(
      'uwx/records: no records to export — ' +
        (recordsDirExists
          ? 'the records directory holds none whose data schema resolves.'
          : 'the site has no records directory. Every file in `records/<schema>/` is a record.')
    )
  }

  const { sendEntities, sendIndex, hashes, skipped } = filterChanged(entities, index, {
    priorHashes: opts.priorHashes,
    sendAll: opts.sendAll,
  })

  const sentModels = [...new Set(sendEntities.map((e) => e.model))]
  if (sendEntities.length === 0) {
    return { buffer: null, models: sentModels, entityCount: 0, warnings, refusals, index: [], hashes, skipped }
  }

  const buffer = emitEntitySyncPackage({
    entities: sendEntities,
    // names-only: the importer resolves each Model by name (no uuids).
    modelsRequired: sentModels.map((name) => ({ name_at_export: name })),
    exporter: opts.exporter,
    exportedAt: opts.exportedAt,
  })

  return { buffer, models: sentModels, entityCount: sendEntities.length, warnings, refusals, index: sendIndex, hashes, skipped }
}
