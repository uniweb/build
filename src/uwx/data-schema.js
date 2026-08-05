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

// Text kinds carry per-locale values when localized.
const TEXT_KINDS = new Set(['string', 'text'])

// Rich-content `format` markers on a `text` field — the file-based body shape that
// replaced the retired `richtext` kind (2026-06-02 / uwx-format.md). A `text` field
// carrying one round-trips as the RAW source string (no ProseMirror conversion).
const CONTENT_TEXT_FORMATS = new Set(['markdown', 'html'])

// The field an open map's key lowers into. `name` matches the idiom already in use
// for this shape (the backend's site-content `collections` section), so an open map
// and a hand-authored row set produce the same wire shape rather than two spellings
// of one thing. Not configurable on purpose: a second way to spell it would be a
// vocabulary addition for a collision that does not exist yet — a value schema that
// declares its own `name` is an error instead, which names the problem precisely.
const OPEN_MAP_KEY = 'name'

/**
 * A `text` field marked as rich content (`format: markdown` or `html`): the
 * file-based body target. Round-trips as the raw source string — what the retired
 * `richtext` kind used to be. See framework/CLAUDE.md gotcha #21 and uwx-format.md.
 */
export function isMarkupTextField(field) {
  return field?.type === 'text' && CONTENT_TEXT_FORMATS.has(field?.format)
}

/**
 * A `json` field constrained to ProseMirror content (`format: prosemirror`):
 * authored as markdown on the file side, carried as a ProseMirror document on the
 * sync wire (the common language with the visual app). The single predicate the
 * sync producer/projector use to decide md⇄ProseMirror conversion + structural-map
 * localization. See framework/CLAUDE.md gotcha #21 and uwx-format.md.
 */
export function isProseMirrorField(field) {
  return field?.type === 'json' && field?.format === 'prosemirror'
}

/**
 * A content BODY field — the markdown-body target of a `.md` record: a markup
 * `text` field (raw source string on the wire) or a `format: prosemirror` json
 * field (a ProseMirror doc on the wire). Replaces the old `richtext`-or-prosemirror
 * test now that `richtext` is retired (2026-06-02).
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
 * @param {(ref: string) => string} [opts.resolveOptions] - maps an `options`
 *   (item_ref) ref to its full `@org/model/<section>` path. Falls back to
 *   `resolveName` (model only) when not supplied.
 * @returns {Object} the declaration (`{ name, description?, linkable?, sections }`).
 */
export function toDataSchemaDeclaration(normalized, { name, resolveName, resolveOptions } = {}) {
  if (!name) throw new Error('toDataSchemaDeclaration: a registry name is required')
  if (!normalized || typeof normalized !== 'object') {
    throw new Error('toDataSchemaDeclaration: a normalized schema is required')
  }
  const resolve = resolveName || defaultResolver(name)
  const optResolve = resolveOptions || resolve

  const { sections, brief } = normalized.sections
    ? lowerSectionsForm(normalized.sections, resolve, optResolve)
    : lowerFieldsForm(normalized.fields || {}, shortName(name), resolve, optResolve)

  // The model-level sort axis is inline: `sort_date: true` on the brief's named
  // date field (replaces the old schema-level `sort_date_field` back-reference).
  if (normalized.sortDate && brief) {
    const f = sections[brief]?.fields?.[normalized.sortDate]
    if (f) f.sort_date = true
  }

  const decl = { name }
  if (normalized.description) decl.description = normalized.description
  // A brief-less model has no card to hydrate as an entity_ref target, so it is
  // not linkable; a model with a brief defaults to linkable (omit ⇒ true).
  if (!brief) decl.linkable = false
  decl.sections = sections
  return decl
}

// --- shapes ------------------------------------------------------------------

// The `fields:` shorthand: a flat field set is ONE single brief section named the
// model short-name. Our producer-side sugar — the registry's root is always
// `sections:`; this expands to it.
function lowerFieldsForm(fields, sectionName, resolve, optResolve) {
  return {
    sections: { [sectionName]: lowerSection({ kind: 'single', brief: true, fields }, resolve, optResolve) },
    brief: sectionName,
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
    const { items: _items, ...collection } = field
    return lowerLeaf(
      { ...collection, ...items, type: items ? items.type : 'string' },
      resolve,
      optResolve,
      { multiple: true }
    )
  }

  return lowerLeaf(field, resolve, optResolve)
}

// Lower a LEAF-SHAPED field — a scalar, a reference (`entity_ref`), or a curated
// picklist (`item_ref`) — with or without `multiple`. The single place field
// attributes are emitted, so every leaf-shaped kind carries the same set.
function lowerLeaf(field, resolve, optResolve, { multiple = false } = {}) {
  const leafType = field.type

  // `richtext` is NOT a kind — it is the author alias for a ProseMirror document
  // (`json` + `format: prosemirror`), normalized upstream in resolve-data-schema.js,
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
        'rebuild it (`richtext` is now json + format: prosemirror).'
    )
  }
  const leafFormat = field.format

  const out = { type: leafType }
  if (multiple) out.multiple = true
  if (field.label) out.label = field.label
  if (field.description) out.description = field.description
  if (field.required) out.required = true

  // A reference to a whole entity, hydrating to the target's brief. It is a
  // FIELD, so it carries field attributes — the same ones `item_ref` below has
  // always carried. Never localized: the text a reader sees belongs to the
  // referenced entity, which localizes on its own.
  if (leafType === 'ref') {
    out.type = 'entity_ref'
    if (field.ref) out.model = resolve(field.ref)
    return out
  }

  // A curated picklist is an item_ref (machine-ish — never localized).
  if (field.options !== undefined) {
    out.type = 'item_ref'
    out.options = optResolve(field.options)
    return out
  }

  // A CONTENT field — a markup `text` (format markdown|html) or a `format:
  // prosemirror` json — is rich CONTENT (authored as markdown; carried as a raw
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
  // owning section's constraint records at ingest; a content format (`markdown`/
  // `html` on text, `prosemirror` on json) it carries as a durable type marker
  // surfaced in schema reads (NOT a validator, NOT relocated — it tells the app to
  // render a rich-text editor).
  if (Array.isArray(field.enum)) out.enum = field.enum
  if (leafFormat) out.format = leafFormat

  // `default` is intentionally NOT emitted — it rides in the foundation-schema
  // blob (render / editor pre-fill), not the content type.
  return out
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

function shortName(name) {
  return String(name).split('/').pop()
}

// `@/x` resolves into the schema's own org; other scopes pass through.
function defaultResolver(ownName) {
  const slash = ownName.indexOf('/')
  const org = ownName[0] === '@' && slash > 1 ? ownName.slice(1, slash) : ''
  return (ref) => {
    if (typeof ref !== 'string') return ref
    if (ref.startsWith('@/')) return `@${org}/${ref.slice(2)}`
    return ref
  }
}
