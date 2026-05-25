/**
 * The submission translation: framework IR → `@uniweb/data-schema` declaration.
 *
 * The framework owns a DX-optimized authoring format (resolve-data-schema.js's
 * normalized output — the IR). At publish time it **translates** that to the
 * registry's `@uniweb/data-schema` declaration, the one the backend ingests and
 * materializes into a model. Keeping the translation in this one isolated module
 * means coupling to the backend's shape can't leak elsewhere.
 *
 * Contract: `kb/framework/build/data-schema-lowering.md` (producer view) and
 * `kb/framework/build/uwx-format.md` §3 (the declaration). Pure — IR in,
 * declaration out; no I/O, no uuids, names only.
 */

// Text kinds carry per-locale values. The framework marks machine fields
// `translatable: false`; everything else is translatable, which lowers to the
// model's `localized` (opt-in there), so we set it explicitly unless opted out.
const TEXT_KINDS = new Set(['string', 'text', 'richtext'])

/**
 * Lower a normalized data schema to its `@uniweb/data-schema` declaration.
 *
 * @param {Object} normalized - the IR from `validateAndNormalizeSchema`
 *   (`{ description?, sortDate?, fields? | sections? }`).
 * @param {Object} opts
 * @param {string} opts.name - the schema's resolved registry name (`@org/x`).
 *   The identity; the caller adds `@org` from the acting org.
 * @param {(ref: string) => string} [opts.resolveName] - maps an authoring ref
 *   (`@/x`, `@scope/x`) used by `ref`/`options` to a registry name. Defaults to
 *   resolving `@/x` into the schema's own org and passing other scopes through.
 * @returns {Object} the declaration (model attrs + `brief` + `sections` tree).
 */
export function toDataSchemaDeclaration(normalized, { name, resolveName } = {}) {
  if (!name) throw new Error('toDataSchemaDeclaration: a registry name is required')
  if (!normalized || typeof normalized !== 'object') {
    throw new Error('toDataSchemaDeclaration: a normalized schema is required')
  }
  const resolve = resolveName || defaultResolver(name)

  const decl = { name }
  if (normalized.description) decl.description = normalized.description
  if (normalized.sortDate) decl.sort_date_field = normalized.sortDate

  const { sections, brief } = normalized.sections
    ? lowerSectionsForm(normalized.sections, resolve)
    : lowerFieldsForm(normalized.fields || {}, shortName(name), resolve)

  if (brief) decl.brief = brief
  decl.sections = sections
  return decl
}

// --- shapes ------------------------------------------------------------------

// A flat `fields:` schema is one `single` section — the brief. Nested
// object/array-of-object fields within it become child sections (see lowerSection).
function lowerFieldsForm(fields, sectionName, resolve) {
  const section = lowerSection(sectionName, { kind: 'single', fields }, resolve)
  return { sections: [section], brief: sectionName }
}

// An explicit `sections:` map → an ordered list. The brief is the section marked
// `brief: true`, else the first top-level `single` (the framework's inference).
function lowerSectionsForm(sectionsMap, resolve) {
  const sections = []
  let brief = null
  let firstSingle = null
  for (const [secName, def] of Object.entries(sectionsMap)) {
    sections.push(lowerSection(secName, def, resolve))
    if (def.brief === true) brief = secName
    if (!firstSingle && (def.kind || 'single') === 'single') firstSingle = secName
  }
  return { sections, brief: brief || firstSingle }
}

function lowerSection(name, def, resolve) {
  const out = { name, kind: def.kind || 'single' }
  if (def.nestable) out.self_nesting = true

  const fields = []
  const childSections = []
  const constraints = []

  for (const [key, rawField] of Object.entries(def.fields || {})) {
    const field = asField(rawField)
    const items = field.type === 'array' && field.items ? asField(field.items) : null
    if (field.type === 'object') {
      // nested struct → a child single section (field name = section name)
      childSections.push(lowerSection(key, { kind: 'single', fields: field.fields }, resolve))
    } else if (items && items.type === 'object') {
      // array of records → a child multi section
      childSections.push(lowerSection(key, { kind: 'multi', fields: items.fields }, resolve))
    } else {
      fields.push(lowerField(key, field, resolve, constraints))
    }
  }

  // explicit child sections (sections-form), after the field-derived ones
  for (const [childName, childDef] of Object.entries(def.sections || {})) {
    childSections.push(lowerSection(childName, childDef, resolve))
  }

  if (fields.length) out.fields = fields
  if (childSections.length) out.sections = childSections
  const authored = Array.isArray(def.constraints) ? def.constraints : []
  const all = [...authored, ...constraints]
  if (all.length) out.constraints = all
  return out
}

function lowerField(key, field, resolve, constraints) {
  const out = { key, type: field.type }
  if (field.label) out.label = field.label
  if (field.required) out.required = true
  // `localized` = human-readable text only. A string that's an enum token, a
  // url/email format, or a curated picklist is machine-ish — not localized.
  const machineish = field.enum !== undefined || field.format !== undefined || field.options !== undefined
  if (TEXT_KINDS.has(field.type) && field.translatable !== false && !machineish) out.localized = true

  if (field.type === 'ref') {
    out.type = 'entity_ref'
    if (field.ref) out.models = [resolve(field.ref)]
  } else if (field.options !== undefined) {
    // curated picklist → item_ref. `options` names the model; the target section
    // granularity is resolved by convention/backend (see lowering doc §3 note).
    out.type = 'item_ref'
    out.options = resolve(field.options)
  } else if (field.type === 'array') {
    const items = field.items ? asField(field.items) : null
    if (items) {
      if (items.type === 'ref') {
        out.element_kind = 'entity_ref'
        if (items.ref) out.models = [resolve(items.ref)]
      } else {
        out.element_kind = items.type
      }
    }
  }

  // Closed value set → a section `one_of` constraint (the field keeps its base
  // type — there is no `enum` kind). Format → a section `format` constraint.
  // `default` is intentionally dropped: it rides in the foundation-schema blob
  // (render/editor pre-fill), not the backend content type.
  if (Array.isArray(field.enum)) constraints.push({ kind: 'one_of', field: key, values: field.enum })
  if (field.format) constraints.push({ kind: 'format', field: key, format: field.format })

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
