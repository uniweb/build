/**
 * The submission translation: framework IR → `@uniweb/data-schema` declaration.
 *
 * The framework owns a DX-optimized authoring format (resolve-data-schema.js's
 * normalized output — the IR). At publish time it **translates** that to the
 * registry's `@uniweb/data-schema` declaration — the `sections:`-tree language the
 * registry ingests and materializes into a model. Keeping the translation in this
 * one isolated module means coupling to the registry's shape can't leak elsewhere.
 *
 * The declaration shape: a Model's root is a MAP of `sections:`; within a section
 * `fields:` is a MAP of leaves and nested sections (a nested section is a
 * `type: section` field; root sections omit the implied marker). Cardinality is the
 * one attribute `multiple:` — there is no `kind`, and the `array` meta-type is
 * retired (a multi-valued field is `multiple: true`). `binder` is derived (a single
 * section whose fields are all `type: section`). The brief and sort axis are inline
 * (`brief: true` on a section, `sort_date: true` on a date field). Field-narrowing
 * `enum`/`format` ride on the field; cross-cutting constraints stay a section-level
 * `constraints:` array. `entity_ref` targets by `model:` (scalar or array); a
 * curated picklist is `item_ref` via `options:`. No uuids; names only.
 *
 * Pure — IR in, declaration out; no I/O, no uuids.
 */

import { parseOptionsRef, FIELD_RULES } from '@uniweb/schemas/format'
import { qualifyRef } from '@uniweb/schemas/refs'

// Text kinds carry per-locale values when localized.
const TEXT_KINDS = new Set(['string', 'text'])

// Rich-content `format` markers on a `text` field — the file-based body shape that
// replaced the retired `richtext` kind (2026-06-02 / uwx-format.md). A `text` field
// carrying one round-trips as the RAW source string (no ProseMirror conversion).
// ⛔ `html` was one until 2026-10-14; `@uniweb/schemas` refuses it by name since.
const CONTENT_TEXT_FORMATS = new Set(['markdown'])

// The field an open map's key lowers into. `name` matches the idiom already in use
// for this shape (the backend's site-content `collections` section), so an open map
// and a hand-authored row set produce the same wire shape rather than two spellings
// of one thing. Not configurable on purpose: a second way to spell it would be a
// vocabulary addition for a collision that does not exist yet — a value schema that
// declares its own `name` is an error instead, which names the problem precisely.
const OPEN_MAP_KEY = 'name'

/**
 * ⭐ AN OPEN MAP'S LOWERED SECTION. `values:` lowers to rows (`lowerField`): a `multiple` section
 * whose required string `name` — the map's key — is made each row's identity by a `unique_field`
 * rule. A record FILE holds it as the author wrote it, a map from key to value; the WIRE holds the
 * rows. This is the one test, read off the declaration alone, because a pull into a clone has
 * nothing else: the push turns a file's map into rows by it, and the pull the rows back into a map.
 */
export function isOpenMapSection(def) {
  if (def?.multiple !== true || def.self_nesting === true) return false
  const key = def.fields?.[OPEN_MAP_KEY]
  if (key?.type !== 'string' || key.required !== true || key.localized === true) return false
  return (def.constraints || []).some((c) => c?.kind === 'unique_field' && c.field === OPEN_MAP_KEY && c.scope === 'section')
}

/** A file's open map as the rows it lowers to, in the map's key order: each key is its row's `name`. */
export function openMapEntries(map) {
  return Object.entries(map).map(([key, value]) => ({ key, value, row: { ...value, [OPEN_MAP_KEY]: key } }))
}

/**
 * Rows back as the map a file holds, or null when they cannot be one — a row with no key, or a key
 * two rows share — so a caller keeps them a list, which a push reads too, and nothing is lost.
 */
export function openMapFromRows(rows) {
  const map = {}
  for (const row of rows || []) {
    const key = row?.[OPEN_MAP_KEY]
    if (typeof key !== 'string' || key === '' || Object.hasOwn(map, key)) return null
    const { [OPEN_MAP_KEY]: _key, ...value } = row
    map[key] = value
  }
  return map
}

/**
 * A `text` field marked as rich content (`format: markdown` or `html`): the
 * file-based body target. Round-trips as the raw source string — what the retired
 * `richtext` kind used to be.
 */
export function isMarkupTextField(field) {
  return field?.type === 'text' && CONTENT_TEXT_FORMATS.has(field?.format)
}

/**
 * A `json` field holding rich text (`format: richtext`, a ProseMirror document):
 * authored as markdown on the file side, carried as a ProseMirror document on the
 * sync wire (the common language with the visual app). The single predicate the
 * sync producer/projector use to decide md⇄ProseMirror conversion + structural-map
 * localization.
 */
export function isProseMirrorField(field) {
  return field?.type === 'json' && field?.format === 'richtext'
}

/**
 * A content BODY field — the markdown-body target of a `.md` record: a markup
 * `text` field (raw source string on the wire) or a `format: richtext` json
 * field (a ProseMirror doc on the wire). Replaced the old `richtext`-kind-or-format
 * test when `richtext` stopped being a kind (2026-06-02); it is the format's name
 * since 2026-10-18.
 */
export function isContentBodyField(field) {
  return isMarkupTextField(field) || isProseMirrorField(field)
}

/**
 * Lower a normalized data schema to its `@uniweb/data-schema` declaration.
 *
 * @param {Object} normalized - the IR from `validateAndNormalizeSchema`.
 * @param {Object} opts
 * @param {string} opts.name - the schema's registry name (`@org/x` or `@/x`).
 * @param {(ref: string) => string} [opts.resolveName] - maps a `ref` target name.
 *   Defaults to resolving `@/x` into the schema's own org, passing others through.
 * @param {(options: string, fieldPath: string) => string} [opts.resolveOptions] - maps an
 *   `options` (item_ref) value to the `@org/model/<section-path>` the registry takes — a
 *   register supplies it (`registry-package.js`), naming the section a short `'@/x'` means.
 *   Falls back to `resolveName`, which resolves the scope and keeps the rest as written.
 * @returns {Object} the declaration (`{ name, label?, plural?, icon?, description?,
 *          source_locale?, linkable?, grantable?, sections }`).
 */
export function toDataSchemaDeclaration(normalized, { name, resolveName, resolveOptions } = {}) {
  if (!name) throw new Error('toDataSchemaDeclaration: a registry name is required')
  if (!normalized || typeof normalized !== 'object') {
    throw new Error('toDataSchemaDeclaration: a normalized schema is required')
  }
  const resolve = resolveName || defaultResolver(name)
  const resolveChoices = resolveOptions || resolve
  // A picklist that names no list is refused naming the schema and the field — and so is one
  // that picks from a section of its own schema (`OWN_SECTION`).
  const optResolve = (options, fieldPath) => {
    let resolved
    try {
      resolved = resolveChoices(options, fieldPath)
    } catch (err) {
      throw new Error(`Data schema '${name}': field '${fieldPath}' ${err.message}`)
    }
    if (typeof resolved === 'string' && resolved.startsWith(`${name}/`)) {
      throw new Error(`Data schema '${name}': field '${fieldPath}' ${OWN_SECTION}`)
    }
    return resolved
  }

  let lowered
  try {
    lowered = normalized.sections
      ? lowerSectionsForm(normalized.sections, resolve, optResolve)
      : lowerFieldsForm(normalized.fields || {}, resolve, optResolve, normalized.constraints)
  } catch (err) {
    // A field the lowering refuses is named with its schema.
    if (err.fieldPath !== undefined) throw new Error(`Data schema '${name}': ${err.message}`)
    throw err
  }
  const { sections, brief } = lowered

  // The model-level sort axis is inline: `sort_date: true` on the brief's named
  // date field (replaces the old schema-level `sort_date_field` back-reference).
  if (normalized.sortDate && brief) {
    const f = sections[brief]?.fields?.[normalized.sortDate]
    if (f) f.sort_date = true
  }

  const decl = { name }
  if (normalized.label) decl.label = normalized.label
  if (normalized.plural) decl.plural = normalized.plural
  // The type's icon — a framework icon name (`lu-user`), sent as written; the registry
  // stores it verbatim and a consumer resolves it. Since 2026-10-05 [Diego].
  if (normalized.icon) decl.icon = normalized.icon
  if (normalized.description) decl.description = normalized.description
  if (normalized.sourceLocale) decl.source_locale = normalized.sourceLocale
  // ⛔ No `creatable_by`: retired 2026-09-23 — Models are open, and `@uniweb/schemas`
  // refuses the key. (It was emitted here when authored.)

  // `linkable` — AUTHORED ONLY (2026-09-27 [Diego]). A model is linkable unless it says
  // `linkable: false` (omitted ⇒ true), with or without a brief. `linkable: false` keeps
  // its entries out of references and out of a site's folder, and nothing else keeps them
  // out of a folder. Whether a reference field may point at a model with no brief — no
  // card to show — is the host's to decide, and nothing here derives it.
  //
  // ⛔ Until then a brief-less model was emitted `linkable: false` and `linkable: true`
  // on one was refused, on the reasoning that a reference would have no card to show —
  // which kept its records out of every site's folder.
  // ⛔ And until 2026-09-30 this said a missing card "is not a reason to refuse" a
  // reference, which read as a promise that one is accepted. A backend refuses it.
  if (normalized.linkable === false) decl.linkable = false

  // `grantable` — AUTHORED ONLY, like `linkable`: a model's entries may be shared one at a
  // time unless it says `grantable: false` (omitted ⇒ true) [Diego, 2026-10-14].
  if (normalized.grantable === false) decl.grantable = false

  decl.sections = sections
  return decl
}

// --- shapes ------------------------------------------------------------------

// The `fields:` shorthand: a flat field set is ONE single section, named `brief` and
// marked `brief: true` — exactly `sections: { brief: { brief: true, fields } }`. Our
// producer-side sugar — the registry's root is always `sections:`; this expands to it.
//
// ⭐ THE NAME IS FIXED, NOT DERIVED (2026-09-22 [Diego]: "We assume it is single section,
// `brief: true` and named `brief`"). It was the schema's short name until then —
// `@std/person` → `person` — a name nobody wrote, stored on every entity and in every
// `item_ref` path, that a schema growing into the `sections:` form had to reuse exactly
// with nothing to say so. A `sections:` schema still names its own sections; `brief` is
// only the recommended name for its card.
export const SHORTHAND_SECTION = 'brief'

// A `fields:` schema's top-level `constraints:` are its one section's rules (2026-10-15).
function lowerFieldsForm(fields, resolve, optResolve, constraints) {
  return {
    sections: { [SHORTHAND_SECTION]: lowerSection({ kind: 'single', brief: true, fields, constraints }, resolve, optResolve) },
    brief: SHORTHAND_SECTION,
  }
}

// The explicit `sections:` map → a map of lowered section bodies. The brief is the
// section marked `brief: true`, else the first `single` (the framework's inference).
function lowerSectionsForm(sectionsMap, resolve, optResolve) {
  const sections = {}
  let explicit = null
  let firstSingle = null
  for (const [secName, def] of Object.entries(sectionsMap)) {
    sections[secName] = lowerSection(def, resolve, optResolve, secName)
    if (def.brief === true) explicit = secName
    if (!firstSingle && (def.kind || 'single') === 'single') firstSingle = secName
  }
  // The brief is the section marked `brief: true`, else the first `single` (the
  // framework's inference). Stamp it inline so the wire and the producer's own
  // consumers (entity-shaping, back-fill render) find it the same way — the
  // sections-tree has no schema-level `brief:` back-reference.
  const brief = explicit || firstSingle
  if (brief && sections[brief] && !sections[brief].brief) sections[brief].brief = true
  return { sections, brief }
}

// Lower one section to its declaration body (the caller keys it by name; a nested
// section gets a `type: section` marker prepended in lowerField). `kind: multi` →
// `multiple: true`; `binder` is derived (no marker — it falls out of "all fields
// are type: section"); `nestable` → `self_nesting`; `append_only` (insert-only
// records) passes through; authored cross-cutting `constraints` pass through as a
// bare array. Leaves and nested sections share one ordered `fields:` namespace.
function lowerSection(def, resolve, optResolve, path = '') {
  const out = {}
  if ((def.kind || 'single') === 'multi') out.multiple = true
  if (def.brief === true) out.brief = true
  // Display prose IS a section key — the registry stores it and keys it for
  // translation as `section.<name>.label` / `.description` (confirmed 2026-08-05).
  // A LEAF is stored differently: its `label`/`description` are accepted by the
  // registry's parser and then dropped FROM THE FIELD DECLARATION, because a
  // field declaration has no slot for prose — field labels live in translation
  // rows keyed `section.<name>.field.<key>.label`. Whether the parser relocates
  // our inline values into those rows (as it relocates `enum` into a `one_of`
  // constraint) or discards them is not stated, and it is the difference between
  // authored field prose reaching the app and not. We keep emitting it either
  // way: it is accepted, so there is no failure mode, and relocation needs no
  // producer change. Do not restate this as "leaf prose is lost" — that reading
  // was asserted here once on the strength of the word "dropped" alone.
  if (def.label) out.label = def.label
  if (def.description) out.description = def.description
  if (def.nestable) out.self_nesting = true
  if (def.append_only) out.append_only = true

  const fields = {}
  for (const [key, rawField] of Object.entries(def.fields || {})) {
    fields[key] = lowerField(rawField, resolve, optResolve, path ? `${path}/${key}` : key)
  }
  // Explicit child sections (sections-form, e.g. under a binder) → `type: section`
  // fields, in the same ordered namespace as the leaves.
  for (const [childName, childDef] of Object.entries(def.sections || {})) {
    const childPath = path ? `${path}/${childName}` : childName
    fields[childName] = {
      type: 'section',
      ...lowerSection(childDef, resolve, optResolve, childPath)
    }
  }
  // A section with neither leaves nor sub-sections carries nothing, and is not a
  // valid section on this wire by either party's reckoning. Refusing here fails at
  // the schema author's screen; emitting it fails in a consumer's restore, which is
  // the last possible moment and the wrong screen (2026-08-04: `@std/form` shipped
  // exactly this, because `values:` had no lowering and silently produced no fields).
  if (!Object.keys(fields).length) {
    throw new Error(
      `Data schema: section '${path || '(root)'}' declares no fields and no sub-sections. ` +
        `A section must carry at least one leaf or child section.`
    )
  }
  out.fields = fields
  if (Array.isArray(def.constraints) && def.constraints.length) out.constraints = def.constraints
  return out
}

// Lower one field to its declaration value:
//   object            → a single nested section
//   array of object   → a multi nested section
//   array of ref      → entity_ref + multiple      ┐
//   array of scalar   → the scalar kind + multiple ├─ leaf-shaped: lowerLeaf
//   ref               → entity_ref (model by name) │
//   scalar            → the kind + its attributes  ┘
//
// Every LEAF-SHAPED output goes through `lowerLeaf`, which is the whole point of
// the split: the field attributes (`label` / `description` / `required`, plus
// `enum` / `format` / `localized`) are emitted in exactly one place, so a kind
// cannot quietly miss them. They used to be emitted inline at the end of this
// function, which each structural branch returned before reaching — so a
// multi-valued leaf reached the wire as a bare `{ type, multiple }`, losing its
// closed set, its format validation and its localization, and an `entity_ref`
// lost its label/description/required while `item_ref` (which fell through)
// kept them. That asymmetry between the two reference kinds is what gave the
// bug away: nothing had decided it, the control flow had.
//
// SECTION-shaped outputs (`object`, `array of object`) still carry none of
// those attributes. That is NOT settled — a section body's documented shape is
// `multiple` / `brief` / `self_nesting` / `append_only` / `constraints` /
// `fields`, so whether the wire accepts `label` / `description` / `required` on
// a section is the consumer's contract to state, not ours to assume. Until it
// does, an authored `required: true` on a nested object or a list of records is
// still dropped here. `@std/publication`'s `authors` is exactly that case.
function lowerField(rawField, resolve, optResolve, path = '') {
  const field = asField(rawField)
  const type = field.type

  if (type === 'object') {
    // An OPEN MAP (`values:`) is ROWS, not a singleton. Its keys belong to the
    // author, which makes them data — so the map lowers to a `multi` section whose
    // key field carries what was the object key, with a section-scoped uniqueness
    // rule making that key the row's identity. This is the same shape `array of
    // object` already lowers to, and the idiom the backend's own site-content
    // `collections` section uses; no new wire construct is involved.
    //
    // Identity is the KEY, never row position — a round-trip that rebuilds the map
    // from order looks correct and drifts the first time rows are reordered.
    // Authoring order is still preserved into row order, because for a form the
    // field order is what the visitor sees.
    if (field.values !== undefined) {
      const value = asField(field.values)
      if (value.type !== 'object' || !value.fields) {
        throw new Error(
          `Data schema: open map at '${path}' declares 'values' that is not an object with ` +
            `'fields'. An open map lowers to rows, and a row needs declared columns.`
        )
      }
      if (value.fields[OPEN_MAP_KEY]) {
        throw new Error(
          `Data schema: open map at '${path}' has a value field named '${OPEN_MAP_KEY}', which ` +
            `is the field the map's key lowers into. Rename that field.`
        )
      }
      return {
        type: 'section',
        ...lowerSection(
          {
            kind: 'multi',
            ...sectionAttrsFromField(field),
            // `translatable: false` is load-bearing, not tidiness: a string field is
            // localized by default, and a localized key could differ per locale —
            // which would destroy the identity the key exists to carry. The key is an
            // identifier, never content.
            fields: {
              [OPEN_MAP_KEY]: { type: 'string', required: true, translatable: false },
              ...value.fields
            },
            // The uniqueness rule is STRUCTURAL — it is what makes the map's key the
            // row's identity — so it is prepended rather than assigned: an author's
            // own constraints on this field add to it and can never replace it.
            constraints: [
              { kind: 'unique_field', field: OPEN_MAP_KEY, scope: 'section' },
              ...(sectionAttrsFromField(field).constraints || [])
            ]
          },
          resolve,
          optResolve,
          path
        )
      }
    }
    return {
      type: 'section',
      ...lowerSection({ kind: 'single', ...sectionAttrsFromField(field), fields: field.fields }, resolve, optResolve, path)
    }
  }
  if (type === 'array') {
    const items = field.items ? asField(field.items) : null
    if (items && items.type === 'object') {
      return {
        type: 'section',
        ...lowerSection({ kind: 'multi', ...sectionAttrsFromField(field), fields: items.fields }, resolve, optResolve, path)
      }
    }
    // A multi-valued LEAF or REFERENCE. `normalizeField` split this field in two
    // when it expanded `many: true` — collection-level metadata (`required`,
    // `label`, `description`, `translatable`) stayed on the array, the
    // type-bearing attributes (`type`, `ref`, `options`, `enum`, `format`) moved
    // to `items` — so rejoin the halves and lower them as one leaf carrying
    // `multiple: true`. Reading only `items.type` here is what silently dropped
    // both halves' attributes; the rejoin is the exact inverse of the split.
    //
    // An UNTYPED array (`items` omitted — the authoring format allows it) becomes
    // `json`, not `string`. It used to invent `string`, which is a claim about the
    // elements that the author never made and that is wrong the moment the list
    // holds anything else: `@std/form`'s `enum` is documented as "bare strings
    // AND/OR { value, label }", and it was reaching the registry declared as a
    // list of strings. `json` is this vocabulary's word for an opaque structured
    // value, which is exactly what an undeclared element type is. Declaring
    // `items:` remains the way to say something stronger.
    //
    // Note the local checker is unaffected and still stricter: `validateItem`
    // works on the IR, where the field is `type: array`, so it verifies the value
    // IS a list. Only what the registry is told changes.
    const { items: _items, ...rest } = field
    return lowerLeaf(
      { ...rest, ...items, type: items ? items.type : 'json' },
      resolve,
      optResolve,
      { multiple: true, path }
    )
  }

  return lowerLeaf(field, resolve, optResolve, { path })
}

// Lower a LEAF-SHAPED field — a scalar, a reference (`entity_ref`), or a curated
// picklist (`item_ref`) — with or without `multiple`. The single place field
// attributes are emitted, so every leaf-shaped kind carries the same set.
function lowerLeaf(field, resolve, optResolve, { multiple = false, path = '' } = {}) {
  const leafType = field.type

  // `richtext` is NOT a kind — it is the author alias for a ProseMirror document
  // (`json` + `format: richtext`), normalized upstream in resolve-data-schema.js,
  // so normalized IR never carries a raw `richtext` kind. The only way one reaches
  // here is a STALE prebuilt schema.json (a foundation built before the 2026-06-02
  // kind retirement and loaded from dist/meta/schema.json without re-resolving).
  // Fail locally — rebuild the foundation — rather than ship a kind the backend
  // rejects. (Routing multi-valued leaves through here closes a hole: the old
  // array branch never consulted this guard, so `richtext` could reach the wire
  // as long as it was a list.)
  if (leafType === 'richtext') {
    throw new Error(
      'This foundation carries the retired `richtext` kind in its built schema — ' +
        'rebuild it (`type: richtext` is now json + format: richtext).'
    )
  }
  const leafFormat = field.format

  // A section's rules on a value have nowhere to go: the wire's `constraints` is a section key.
  // A named schema refuses them before this (`resolve-data-schema.js`); refused here too, rather
  // than dropped, which they were until 2026-10-15.
  if (field.constraints !== undefined) {
    throw Object.assign(
      new Error(
        `field '${path}' declares \`constraints\` on a value — they are a section's rules: declare them ` +
          `in the \`constraints:\` of the section that holds it.`
      ),
      { fieldPath: path }
    )
  }

  const out = { type: leafType }
  if (multiple) out.multiple = true
  if (field.label) out.label = field.label
  if (field.description) out.description = field.description
  if (field.required) out.required = true
  // A field's rules, as written — `max_length`, `min`, `max`, `mime_types`, `max_size`,
  // `pattern` (`FIELD_RULES`): a registry keeps each as the field's own key and checks it on
  // every write. ⛔ Until 2026-10-15 the normalizer dropped them before this saw them.
  for (const key of Object.keys(FIELD_RULES)) {
    if (field[key] !== undefined) out[key] = field[key]
  }

  // A reference to a whole entity, hydrating to the target's brief. It is a
  // FIELD, so it carries field attributes — the same ones `item_ref` below has
  // always carried. Never localized: the text a reader sees belongs to the
  // referenced entity, which localizes on its own.
  if (leafType === 'ref') {
    out.type = 'entity_ref'
    if (field.ref) out.model = resolve(field.ref)
    // The level on the entry it points to that opens this entry, for `read` — by link
    // [Diego, 2026-10-14]. `@uniweb/schemas` admits it only here, as read, edit or admin.
    if (field.readable_with) out.readable_with = field.readable_with
    // A reference a purchase travels along, to what it names [backend, 2026-10-21]. Only `true`
    // is sent: `@uniweb/schemas` drops `false`, which says what leaving it out says.
    if (field.sold_with === true) out.sold_with = true
    return out
  }

  // A curated picklist is an item_ref (machine-ish — never localized), naming the section whose
  // items are its choices (`optionsSectionPath`).
  if (field.options !== undefined) {
    out.type = 'item_ref'
    out.options = optResolve(field.options, path)
    return out
  }

  // A CONTENT field — a markup `text` (format markdown) or a `format:
  // richtext` json — is rich CONTENT (authored as markdown; carried as a raw
  // source string or a ProseMirror doc on sync). Localizable like a text kind, NOT
  // a machine-ish value-validator format-string (email/url).
  const isContent = isContentBodyField({ type: leafType, format: leafFormat })
  // `localized` = human-readable content — not enum tokens or value-validator formats.
  const machineish = field.enum !== undefined || (leafFormat !== undefined && !isContent)
  if ((TEXT_KINDS.has(leafType) || isContent) && field.translatable !== false && !machineish) {
    out.localized = true
  }

  // Field-narrowing attributes ride on the field. The backend treats them by kind:
  // `enum` and a value-validator string `format` (email/url) it relocates to the
  // owning section's constraint records at ingest; a content format (`markdown` on
  // text, `richtext` on json) it carries as a durable type marker surfaced in schema
  // reads (NOT relocated — it tells the app to render a rich-text editor, and a
  // `richtext` value is held to the rich-text vocabulary).
  if (Array.isArray(field.enum)) out.enum = field.enum
  if (leafFormat) out.format = leafFormat

  // No `default`: a named schema declares none (`resolve-data-schema.js` refuses one, since
  // 2026-10-05). ⛔ This said it "rides in the foundation-schema blob (render / editor
  // pre-fill)" until then — but that blob leaves `dataSchemas` out, so a named schema's
  // default reached the runtime alone, and no editor.
  return out
}

// --- picklists ----------------------------------------------------------------

// ⛔ A picklist cannot take its choices from a section of its own schema: a registry refuses it on
// every register, whatever order the package lists its schemas in (measured 2026-10-15). Refused
// here, at the author's screen, until a registry takes it.
const OWN_SECTION =
  'takes its choices from a section of its own schema, which a registry does not take — keep the list in a Model of its own.'

/**
 * ⭐ THE SECTION A PICKLIST'S CHOICES ARE IN — its path in the options Model, as the registry
 * names it (2026-10-15). A field that picks from a list names the section holding the list:
 * `options: '@/lists/countries'`, a nested one by its path (`'@/lists/countries/subdivisions'`).
 * A Model whose top holds ONE list may be named alone — `'@/country'`, the `fields:` shorthand's
 * one section, is the common case — and that list is the one meant.
 *
 * A register sends `@scope/name/<this path>` (`registry-package.js`): a registry takes an
 * `item_ref`'s `options` as `@org/model/section-path` and refuses one that names no section
 * (2026-10-15).
 *
 * ⛔ A Model with several lists at its top is refused when named alone: which one the author meant
 * is not ours to guess. Until 2026-10-15 the first single-or-multi section was taken, and a path
 * could not be written at all, so a Model's second list could never be a field's choices.
 *
 * @param {string} options - the field's `options:` as authored (`@/lists/countries`)
 * @param {Object} target - the options Model, normalized
 * @returns {string} the section's path in the Model (`countries`, `brief` for the shorthand)
 * @throws when the path names no section, or a section that holds only sections, or is left out
 *   of a Model whose top holds more than one list — naming the lists it has
 */
export function optionsSectionPath(options, target) {
  const { model, path } = parseOptionsRef(options)
  const sections = sectionPathsOf(target)
  const lists = sections.filter((s) => s.holdsItems).map((s) => s.path)
  const named = (paths) => paths.map((p) => `'${model}/${p}'`).join(', ')
  if (path == null) {
    const top = lists.filter((p) => !p.includes('/'))
    if (top.length === 1) return top[0]
    throw new Error(
      top.length === 0
        ? `takes its choices from '${options}', which holds no list at its top — name the section that holds them: ${named(lists) || '(it has none)'}.`
        : `takes its choices from '${options}', which holds ${top.length} lists at its top — name the one: ${named(top)}.`
    )
  }
  const found = sections.find((s) => s.path === path)
  if (!found) {
    throw new Error(`takes its choices from '${options}', but '${model}' has no section '${path}' — its lists: ${named(lists) || '(none)'}.`)
  }
  if (!found.holdsItems) {
    const under = lists.filter((p) => p.startsWith(`${path}/`))
    throw new Error(
      `takes its choices from '${options}', a section that holds only sections, so it has no items to choose — ` +
        `name a list under it: ${named(under) || '(it has none)'}.`
    )
  }
  return path
}

/**
 * Check every picklist in a closed map of normalized schemas against the Model it names, throwing
 * for the first whose `options:` names no list (`optionsSectionPath`). A Model the map does not
 * hold is skipped: resolving the graph fails on it first.
 *
 * @param {Object<string, Object>} dataSchemas - `{ [ref]: normalized }`, closed under references
 */
export function assertOptionsTargets(dataSchemas) {
  for (const [ref, schema] of Object.entries(dataSchemas || {})) {
    forEachOptionsField(schema, (fieldPath, options) => {
      const { model } = parseOptionsRef(options)
      if (model === ref) throw new Error(`Data schema '${ref}': field '${fieldPath}' ${OWN_SECTION}`)
      const target = dataSchemas[model]
      if (!target) return
      try {
        optionsSectionPath(options, target)
      } catch (err) {
        throw new Error(`Data schema '${ref}': field '${fieldPath}' ${err.message}`)
      }
    })
  }
}

// Every field of a normalized schema that declares `options:`, with its dotted path — in any
// section, nested object, list of records or open map.
function forEachOptionsField(schema, fn) {
  const visitField = (raw, path) => {
    const field = asField(raw)
    if (typeof field.options === 'string') fn(path, field.options)
    if (field.items) visitField(field.items, path)
    if (field.values) visitField(field.values, path)
    for (const [key, child] of Object.entries(field.fields || {})) visitField(child, `${path}.${key}`)
  }
  const visitSection = (section, prefix) => {
    for (const [key, field] of Object.entries(section?.fields || {})) visitField(field, `${prefix}${key}`)
    for (const [name, child] of Object.entries(section?.sections || {})) visitSection(child, `${prefix}${name}.`)
  }
  if (schema?.fields) visitSection(schema, '')
  for (const [name, section] of Object.entries(schema?.sections || {})) visitSection(section, `${name}.`)
}

// The sections of a normalized Model by the path the registry names each one by, and whether each
// holds items — the lowering's own shapes (`lowerField`): a child in `sections:`, a nested object
// (one record), a list of records, an open map (rows). A section holding only sections — a binder —
// holds none.
function sectionPathsOf(normalized) {
  const out = []
  const visit = (path, node) => {
    out.push({ path, holdsItems: holdsItems(node) })
    for (const [name, child] of Object.entries(node.sections || {})) visit(`${path}/${name}`, child)
    for (const [name, field] of Object.entries(node.fields || {})) {
      const nested = sectionOfField(field)
      if (nested) visit(`${path}/${name}`, nested)
    }
  }
  if (normalized?.fields) visit(SHORTHAND_SECTION, { kind: 'single', fields: normalized.fields })
  for (const [name, section] of Object.entries(normalized?.sections || {})) visit(name, section)
  return out
}

// The section a section-shaped FIELD lowers into (`lowerField`), or null for a leaf.
function sectionOfField(raw) {
  const field = asField(raw)
  if (field.type === 'object') {
    if (field.values !== undefined) return { kind: 'multi', fields: { [OPEN_MAP_KEY]: { type: 'string' }, ...asField(field.values).fields } }
    return { kind: 'single', fields: field.fields }
  }
  if (field.type === 'array' && field.items && asField(field.items).type === 'object') {
    return { kind: 'multi', fields: asField(field.items).fields }
  }
  return null
}

function holdsItems(section) {
  if ((section.kind || 'single') === 'multi') return true
  if (section.kind === 'binder') return false
  return Object.values(section.fields || {}).some((field) => !sectionOfField(field))
}

// --- helpers -----------------------------------------------------------------

function asField(def) {
  return typeof def === 'string' ? { type: def } : (def && typeof def === 'object' ? def : {})
}

// A nested section is authored as a FIELD (`{ type: object, description: … }`),
// but arrives on the wire as a section — so the attributes that belong to a
// SECTION have to travel from the field declaration onto the section body, where
// the registry has a slot for them. Without this an authored `description:` on a
// nested object was dropped twice over (once by the normalizer, then again here),
// and `constraints:` never arrived at all.
//
// `constraints` is the load-bearing one. A list of records is normally authored
// as a field — `authors: { type: object, many: true }` — so until this existed,
// section rules were declarable only in the `sections:` form and unreachable in
// the shape that usually needs them. `min_items` is the motivating rule; note it
// is a WRITE guarantee ("a delete may not take the section below N"), never a
// render guarantee — a component still handles an empty list, because the same
// Model is renderable by a foundation that never saw the constraint.
function sectionAttrsFromField(field) {
  const out = {}
  if (field.label) out.label = field.label
  if (field.description) out.description = field.description
  if (Array.isArray(field.constraints) && field.constraints.length) out.constraints = field.constraints
  // `tree` (→ `self_nesting`) and `append_only` describe how a list of records
  // behaves, so they belong to the section too. Same silent-drop as `constraints`
  // had: a list authored as a FIELD could not be a tree or append-only, while the
  // identical thing in `sections:` form could. `self_nesting` is valid on a nested
  // section, not only a top-level one (backend, 2026-08-05).
  if (field.nestable) out.nestable = true
  if (field.append_only) out.append_only = true
  return out
}

// `@/x` resolves into the schema's own org; other scopes pass through.
function defaultResolver(ownName) {
  const slash = ownName.indexOf('/')
  const org = ownName[0] === '@' && slash > 1 ? ownName.slice(1, slash) : ''
  return (ref) => qualifyRef(ref, org)
}
