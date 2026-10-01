/**
 * Runtime Schema Extractor
 *
 * Extracts lean runtime-relevant metadata from full meta.js files.
 * The runtime schema is optimized for size and contains only what's
 * needed at render time:
 *
 * - background: 'self' when component handles its own background
 * - data: { <key>: <schema ref> | null } — every `content.data` key the component
 *     declares, in order, with its schema ref (null for an inline shape)
 * - schemas: { <key>: <lean fields> } — field defaults for the declared keys that have any
 * - defaults: param default values
 * - context: static capabilities for cross-block coordination
 * - initialState: initial values for mutable block state
 *
 * ⭐ `data:` IS THE DELIVERY — ruled 2026-09-14 [Diego]: a section's `content.data` holds
 * the keys its component declares and nothing else, and which fetch fills each is worked
 * out at render from the keys and their schema refs (`@uniweb/core` `fillDeclaredKeys`).
 * A component with no `data:`, or `data: false`, receives none of its own. ⛔ Until then
 * delivery was default-on — every key that reached a section — and `data:` was a hint for
 * defaults and the editor; `data: false` was the opt-out, emitted as `inheritData: false`.
 *
 * Full metadata (titles, descriptions, hints, etc.) stays in schema.json
 * for the visual editor.
 */

import { isRichSchema } from '@uniweb/core'
import { dataRefOf } from '@uniweb/core/data-keys'
import { briefFieldMap, wholeFieldMap } from '@uniweb/schemas/conform'
import { enumValues } from '@uniweb/schemas/format'
import { lowerData } from '@uniweb/schemas/content'

/**
 * A `data:` entry's schema ref — a ref string, or `{ schema }` — or null for an inline
 * shape, which names no schema and is filled only under its own key.
 *
 * @param {string|Object} value
 * @returns {string|null}
 */
function dataRef(value) {
  if (typeof value === 'string') return value || null
  return value && typeof value === 'object' && typeof value.schema === 'string' && value.schema ? value.schema : null
}

/**
 * Extract lean schema field for runtime
 * Strips editor-only fields (label, hint, description)
 * Keeps runtime fields (type, default, enum, options, fields, items)
 *
 * Vocabulary is the data-schema format:
 * an `object` field nests via `fields:` (a field map); an `array` field nests
 * via `items:` (a single element field). This matches what
 * resolve-data-schema.js normalizes named refs to, so named-ref and inline
 * `data:` schemas share one shape.
 *
 * @param {string|Object} field - Schema field definition
 * @returns {string|Object} - Lean field definition
 */
function extractSchemaField(field) {
  // Shorthand: a bare type string ('string', 'decimal', …).
  if (typeof field === 'string') {
    return field
  }

  if (!field || typeof field !== 'object') {
    return field
  }

  const lean = {}

  // Keep runtime-relevant fields: the default, plus the inline picklist
  // (`enum`) used for value validation. `options` is a curated-ref string —
  // inert at runtime but carried through.
  if (field.type) lean.type = field.type
  if (field.default !== undefined) lean.default = field.default
  // The values only: an entry's label (`{ value, label }`) is an editor's, and the runtime compares.
  if (field.enum !== undefined) lean.enum = enumValues(field.enum)
  if (field.options) lean.options = field.options

  // Nested object → recurse into its field map.
  if (field.type === 'object' && field.fields && typeof field.fields === 'object') {
    lean.fields = extractSchemaFields(field.fields)
  }

  // Array → recurse into its single element field (which may itself be an
  // object carrying nested `fields`).
  if (field.type === 'array' && field.items !== undefined) {
    lean.items = extractSchemaField(field.items)
  }

  // If the only thing left is `type`, collapse to the bare type string.
  const keys = Object.keys(lean)
  if (keys.length === 1 && keys[0] === 'type') {
    return lean.type
  }

  return keys.length > 0 ? lean : null
}

/**
 * Extract lean schema fields for an entire schema object
 *
 * @param {Object} schemaFields - Map of fieldName -> field definition
 * @returns {Object} - Map of fieldName -> lean field definition
 */
function extractSchemaFields(schemaFields) {
  if (!schemaFields || typeof schemaFields !== 'object') {
    return {}
  }

  const lean = {}
  for (const [name, field] of Object.entries(schemaFields)) {
    const leanField = extractSchemaField(field)
    if (leanField !== null) {
      lean[name] = leanField
    }
  }
  return lean
}

/**
 * Check if a schema value is in the full @uniweb/schemas format
 * Full format has: { name, version?, description?, fields: { fieldName: fieldDef, ... } }
 *
 * The distinguishing feature is that `fields` is a *keyed object*, not an array.
 * (A rich form schema also has `fields`, but as an array.)
 *
 * @param {Object} schema - Schema value to check
 * @returns {boolean}
 */
function isFullSchemaFormat(schema) {
  return (
    schema &&
    typeof schema === 'object' &&
    typeof schema.fields === 'object' &&
    schema.fields !== null &&
    !Array.isArray(schema.fields)
  )
}

/**
 * Pass a rich form schema through with minimal normalization.
 *
 * Rich schemas are passed to the editor (for FormBlock UI rendering) and to
 * the runtime (for default application). We keep all authored metadata so the
 * editor has what it needs; we do not strip editor-only fields here because
 * the same schema feeds both audiences.
 *
 * Normalizations:
 *
 * @param {Object} schema - Rich schema as authored
 * @returns {Object} - Normalized rich schema
 */
function normalizeRichSchema(schema) {
  return normalizeRichSchemaValue(schema)
}

function normalizeRichSchemaValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeRichSchemaValue)
  }
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, v] of Object.entries(value)) {
    if (v && typeof v === 'object') {
      out[key] = normalizeRichSchemaValue(v)
    } else {
      out[key] = v
    }
  }
  return out
}

/**
 * Lean a single `data:` entry value into the runtime field structure that
 * prepare-props.applySchemas applies. A `data:` value is one of:
 *   - a named ref (`'@/member'`, or `{ schema: '@/member' }`) → resolved on
 *     disk by the build's data-schema resolver; its fields are lean-extracted.
 *   - an inline rich-form schema (`{ fields: [...] }`) → passed through
 *     normalized (drives the FormBlock editor UI + default application).
 *   - an inline full-format schema (`{ name, version, fields: {...} }`) or a
 *     bare field map (`{ field: {...} }`) → lean-extracted.
 *
 * Source-agnostic: the same `content.data` key may be filled by a fetched
 * collection, a tagged code block, or an editor form — the schema (and its
 * defaults) is identical, so there is one declaration surface. Returns the
 * lean structure, or null when there's nothing to apply.
 *
 * @param {string|Object} value - The `data:` entry value
 * @param {Object} dataSchemaMap - Resolved schemas keyed by ref
 * @returns {Object|null}
 */
function leanDataSchema(value, dataSchemaMap) {
  // Named ref → the resolved schema's fields. `'@std/article/*'` asks for whole records of it.
  const { ref, whole } = dataRefOf(value)
  if (ref) {
    const resolved = dataSchemaMap[ref]
    // ⭐ THE FIELDS OF WHAT THE COMPONENT RECEIVES (ruled 2026-09-27 [Diego]): a brief's fields at
    // the top (`briefFieldMap`), or, for `'@x/y/*'`, the whole record as stored — one field per
    // section, the brief's included (`wholeFieldMap`) — so a default lands where the record carries
    // its field: `@std/article`'s `status` inside `body`. A section is filled only when the record
    // holds it (`applySchemaToObject` recurses into what is there).
    //
    // ⛔ It was the merged `deliveredFields` until 2026-09-27 — the brief's fields beside the other
    // sections' names, one map for two shapes; `flatRecordFields`, the retired flat form, until
    // 2026-09-24; and before 2026-09-03 `resolved.fields`, which a sections-form schema does not
    // have. `dataSchemaMap` holds each schema normalized in its authored form (`fields:` or
    // `sections:`), and only these readers say what one record of it looks like.
    const fields = whole ? wholeFieldMap(resolved) : briefFieldMap(resolved)
    if (!fields) return null
    const lean = extractSchemaFields(fields)
    return Object.keys(lean).length > 0 ? lean : null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  // Inline rich-form schema (fields: array) — drives FormBlock + defaults.
  if (isRichSchema(value)) return normalizeRichSchema(value)

  // Inline full-format schema or a bare field map.
  const fields = isFullSchemaFormat(value) ? value.fields : value
  const lean = extractSchemaFields(fields)
  return Object.keys(lean).length > 0 ? lean : null
}


/**
 * Extract param defaults from params object
 *
 * @param {Object} params - The params object from meta.js
 * @returns {Object|null} - Object of { paramName: defaultValue } or null if empty
 */
function extractParamDefaults(params) {
  if (!params || typeof params !== 'object') {
    return null
  }

  const defaults = {}

  for (const [key, param] of Object.entries(params)) {
    if (param && typeof param === 'object' && param.default !== undefined) {
      defaults[key] = param.default
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : null
}

/**
 * Extract lean runtime schema from a full meta.js object
 *
 * @param {Object} fullMeta - The full meta.js default export
 * @param {Object} [dataSchemaMap] - Resolved data schemas keyed by ref (from
 *                 resolve-data-schema.js), used to lean-extract field defaults
 *                 for each `data:` binding.
 * @returns {Object|null} - Lean runtime schema or null if empty
 */
export function extractRuntimeSchema(fullMeta, dataSchemaMap = {}) {
  if (!fullMeta || typeof fullMeta !== 'object') {
    return null
  }

  const runtime = {}

  // Inset flag: signals this component is available for inline @ references
  if (fullMeta.inset) {
    runtime.inset = true
  }

  // Background opt-out: 'self' means the component renders its own background
  // layer (solid colors, insets, effects), so the runtime skips its Background.
  if (fullMeta.background) {
    runtime.background = fullMeta.background
  }

  // Data. `data:` is the single declaration surface for a section's structured
  // data: it maps each `content.data` key to its schema. A value is a named ref
  // (`'@/member'`), an inline field map, or an inline rich-form (`{ fields: [...] }`,
  // an editor form). Source-agnostic — the data may arrive by fetch, tagged code
  // block, or editor form; the schema and its defaults are identical.
  //
  // ⭐ Every key reaches the runtime, a key with no fields included — `data` lists them
  // with their refs, because the keys ARE what the section receives, and a key's ref is
  // what a fetch of another name fills it by. `schemas` carries field defaults for the
  // keys that have fields. `data: false` declares nothing, as no `data:` does.
  //
  // ⭐ A concept block's key is written as its fence is — `'md:faq': 'Questions and
  // answers'` — and lowered to the key a component reads, `faq`, with no schema: the value
  // is the author's label, never a ref (`lowerData`; ruled 2026-09-29). A built entry is
  // already lowered; this holds for a `meta.js` handed in as written.
  const data = lowerData(fullMeta.data)
  if (data === false) {
    // declares no key
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      // ⛔ A value that is no schema at all declares a key by accident — it would reach the
      // component as `null`, silently. `data: { inherit: [...] }` — the opt-in to cascaded
      // data from 2026-01-31 until declared keys replaced it — is the shape this refuses: it
      // declared a key named `inherit`.
      if (typeof value !== 'string' && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new Error(
          `[uniweb] Invalid 'data.${key}' in meta.js: expected a named ref ('@/x'), an inline field map, ` +
            `a rich-form { fields: [...] }, or {} for a key with no schema — got ${JSON.stringify(value)}.` +
            (key === 'inherit'
              ? " `data: { inherit: [...] }` is retired: declare each key the component reads, e.g. `data: { members: {} }`."
              : '')
        )
      }
      runtime.data = runtime.data || {}
      runtime.data[key] = dataRef(value)
      const lean = leanDataSchema(value, dataSchemaMap)
      if (lean) {
        runtime.schemas = runtime.schemas || {}
        runtime.schemas[key] = lean
      }
    }
  } else if (data !== undefined) {
    throw new Error(
      `[uniweb] Invalid 'data' in meta.js: expected false or { <key>: <schema> }, got ${JSON.stringify(data)}. ` +
        "A <schema> is a named ref ('@/x'), an inline field map, or a rich-form { fields: [...] }."
    )
  }

  const paramsObj = fullMeta.params
  const defaults = extractParamDefaults(paramsObj)
  if (defaults) {
    runtime.defaults = defaults
  }

  // Context - static capabilities for cross-block coordination
  // e.g., { allowTranslucentTop: true } for Hero components
  if (fullMeta.context && typeof fullMeta.context === 'object') {
    runtime.context = fullMeta.context
  }

  // Initial state - default values for mutable block state
  // e.g., { expanded: false } for accordion-like components
  if (fullMeta.initialState && typeof fullMeta.initialState === 'object') {
    runtime.initialState = fullMeta.initialState
  }

  // (Top-level `schemas:` is gone — inline field maps and rich-forms are now
  // just `data:` entries with an inline value. See leanDataSchema.)

  return Object.keys(runtime).length > 0 ? runtime : null
}

/**
 * Extract runtime schemas for all components
 *
 * @param {Object} componentsMeta - Map of componentName -> meta.js content
 * @returns {Object} - Map of componentName -> runtime schema (excludes null entries)
 */
export function extractAllRuntimeSchemas(componentsMeta, dataSchemaMap = {}) {
  const schemas = {}

  for (const [name, meta] of Object.entries(componentsMeta)) {
    const schema = extractRuntimeSchema(meta, dataSchemaMap)
    if (schema) {
      schemas[name] = schema
    }
  }

  return schemas
}

/**
 * Extract lean runtime schema for a layout from its full meta.js
 *
 * Layout runtime metadata:
 * - areas: Array of area names this layout supports
 * - transitions: View transition name overrides (the runtime auto-names areas;
 *   this overrides per region, or `false` opts the layout out)
 * - defaults: Param default values
 * - scroll: Scroll management mode ('self' or CSS selector)
 * - layers: Stacking order of the area wrappers (object, or false to opt out)
 *
 * @param {Object} fullMeta - The full meta.js default export for a layout
 * @returns {Object|null} - Lean layout runtime schema or null if empty
 */
export function extractLayoutRuntimeSchema(fullMeta) {
  if (!fullMeta || typeof fullMeta !== 'object') {
    return null
  }

  const runtime = {}

  if (fullMeta.areas && Array.isArray(fullMeta.areas)) {
    runtime.areas = fullMeta.areas
  }

  // `false` is a value, not an absence: it is the documented way a layout opts
  // out of per-area view transitions. The previous guard was
  // `fullMeta.transitions && typeof … === 'object'`, which is false for `false`
  // — so the opt-out was dropped here and never reached the runtime, even
  // though `resolveLayoutTransitions` has always handled it. Same for `layers`.
  if (fullMeta.transitions === false || (fullMeta.transitions && typeof fullMeta.transitions === 'object')) {
    runtime.transitions = fullMeta.transitions
  }

  // Stacking order of the area wrappers. Carried whether or not the layout
  // declares transitions, because an explicit layer is itself a reason to wrap.
  if (fullMeta.layers === false || (fullMeta.layers && typeof fullMeta.layers === 'object')) {
    runtime.layers = fullMeta.layers
  }

  if (fullMeta.scroll !== undefined) {
    runtime.scroll = fullMeta.scroll
  }

  const defaults = extractParamDefaults(fullMeta.params)
  if (defaults) {
    runtime.defaults = defaults
  }

  return Object.keys(runtime).length > 0 ? runtime : null
}

/**
 * Extract runtime schemas for all layouts
 *
 * @param {Object} layoutsMeta - Map of layoutName -> meta.js content
 * @returns {Object} - Map of layoutName -> layout runtime schema (excludes null entries)
 */
export function extractAllLayoutRuntimeSchemas(layoutsMeta) {
  const schemas = {}

  for (const [name, meta] of Object.entries(layoutsMeta)) {
    const schema = extractLayoutRuntimeSchema(meta)
    if (schema) {
      schemas[name] = schema
    }
  }

  return schemas
}

/**
 * ⭐ WHAT THE RUNTIME READS OF A FOUNDATION'S `main.js` — and nothing else of it. Ruled
 * 2026-10-01 [Diego]: *"Only what runtime really reads for rendering should reach it."*
 *
 * Read off every runtime reader of the entry's `capabilities` (2026-10-01): core's `Uniweb` and
 * `Website`, the runtime's wiring, navigation and scroll, `@uniweb/theming`, kit's xref, the
 * fetch dispatcher, and press. Two kinds:
 *
 *   code  `handlers`, `defaultInsets`, `xref`, `transports`, `outputs` — functions and
 *         components, so the entry REFERENCES each from the module and the bundler drops the rest
 *         of `main.js`'s default export.
 *   data  `defaultLayout`, `defaultSection`, `viewTransitions`, `scroll`; `vars`, each var's
 *         `default`, `type` and `applyTo` — all `@uniweb/theming` reads; `data`, each key's schema
 *         ref — all `declaredKeys` reads. Written as a literal, like a section type's lean schema.
 *
 * ⛔ Never: `name`, `description`, `extension`, a var's label or description, a data key's shape,
 * or any key the framework does not read. ⛔ Until 2026-10-01 the entry spread the whole default
 * export into `capabilities`, and a foundation's name and its vars' descriptions shipped in every
 * published bundle.
 *
 * A data key whose value is not plain data (a function, say) is referenced like code, so nothing
 * is lost to serialization.
 *
 * @param {Object} config - the foundation's `main.js`, as `loadFoundationConfig` reads it
 * @returns {{ code: string[], data: Object }} the code keys to reference, and the data to inline
 */
export function extractFoundationRuntime(config = {}) {
  const code = RUNTIME_CODE_CAPABILITIES.filter((key) => config?.[key] !== undefined)
  const data = {}
  for (const key of RUNTIME_DATA_CAPABILITIES) {
    const value = config?.[key]
    if (value === undefined) continue
    if (isPlainData(value)) data[key] = value
    else code.push(key)
  }
  const vars = leanVars(config?.vars)
  if (vars) data.vars = vars
  const keys = leanDataKeys(config?.data)
  if (keys) data.data = keys
  return { code, data }
}

/** The `main.js` capabilities the runtime calls or renders — referenced, never copied. */
export const RUNTIME_CODE_CAPABILITIES = ['handlers', 'defaultInsets', 'xref', 'transports', 'outputs']

/** The `main.js` values the runtime reads as data — written into the entry. */
const RUNTIME_DATA_CAPABILITIES = ['defaultLayout', 'defaultSection', 'viewTransitions', 'scroll']

/** What `@uniweb/theming` reads of a foundation var: its value, its kind, and a font role's selectors. */
const RUNTIME_VAR_FIELDS = ['default', 'type', 'applyTo']

function leanVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null
  const out = {}
  for (const [name, config] of Object.entries(vars)) {
    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const lean = {}
      for (const field of RUNTIME_VAR_FIELDS) if (config[field] !== undefined) lean[field] = config[field]
      out[name] = lean
    } else {
      out[name] = config
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A foundation's `data:` as a section type's lean `data` is: each key → its schema ref, or null. */
function leanDataKeys(data) {
  const lowered = lowerData(data)
  if (!lowered || typeof lowered !== 'object' || Array.isArray(lowered)) return null
  const out = {}
  for (const [key, value] of Object.entries(lowered)) out[key] = dataRef(value)
  return Object.keys(out).length > 0 ? out : null
}

function isPlainData(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isPlainData)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isPlainData)
  }
  return false
}
