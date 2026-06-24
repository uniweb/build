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
    sections[secName] = lowerSection(def, resolve, optResolve)
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
function lowerSection(def, resolve, optResolve) {
  const out = {}
  if ((def.kind || 'single') === 'multi') out.multiple = true
  if (def.brief === true) out.brief = true
  if (def.nestable) out.self_nesting = true
  if (def.append_only) out.append_only = true

  const fields = {}
  for (const [key, rawField] of Object.entries(def.fields || {})) {
    fields[key] = lowerField(rawField, resolve, optResolve)
  }
  // Explicit child sections (sections-form, e.g. under a binder) → `type: section`
  // fields, in the same ordered namespace as the leaves.
  for (const [childName, childDef] of Object.entries(def.sections || {})) {
    fields[childName] = { type: 'section', ...lowerSection(childDef, resolve, optResolve) }
  }
  if (Object.keys(fields).length) out.fields = fields
  if (Array.isArray(def.constraints) && def.constraints.length) out.constraints = def.constraints
  return out
}

// Lower one field to its declaration value. Leaves carry their kind + attributes;
// structural kinds become sections or multi-valued leaves:
//   object           → a single nested section
//   array of object   → a multi nested section
//   array of ref      → entity_ref + multiple
//   array of scalar   → the scalar kind + multiple
//   ref               → entity_ref (model by name)
function lowerField(rawField, resolve, optResolve) {
  const field = asField(rawField)
  const type = field.type

  if (type === 'object') {
    return { type: 'section', ...lowerSection({ kind: 'single', fields: field.fields }, resolve, optResolve) }
  }
  if (type === 'array') {
    const items = field.items ? asField(field.items) : null
    if (items && items.type === 'object') {
      return { type: 'section', ...lowerSection({ kind: 'multi', fields: items.fields }, resolve, optResolve) }
    }
    if (items && items.type === 'ref') {
      // Multi-valued reference — the per-field `multiple` flag (the `array` Kind
      // that once forced a child multi section is retired).
      const out = { type: 'entity_ref', multiple: true }
      if (items.ref) out.model = resolve(items.ref)
      return out
    }
    // Array of scalars → a multi-valued leaf.
    return { type: items ? items.type : 'string', multiple: true }
  }
  if (type === 'ref') {
    const out = { type: 'entity_ref' }
    if (field.ref) out.model = resolve(field.ref)
    return out
  }

  // A leaf (scalar) kind. `richtext` is retired (2026-06-02 / uwx-format.md): a
  // leftover `richtext` in the IR (e.g. a foundation built before the migration)
  // lowers to the file-based body shape — `text` + `format: markdown` — so the wire
  // never carries the kind the backend now rejects.
  let leafType = type
  let leafFormat = field.format
  if (leafType === 'richtext') {
    leafType = 'text'
    leafFormat = leafFormat ?? 'markdown'
  }

  const out = { type: leafType }
  if (field.label) out.label = field.label
  if (field.description) out.description = field.description
  if (field.required) out.required = true

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
