/**
 * Runtime Schema Extractor
 *
 * Extracts lean runtime-relevant metadata from full meta.js files.
 * The runtime schema is optimized for size and contains only what's
 * needed at render time:
 *
 * - background: 'self' when component handles its own background
 * - data: { type, limit } for CMS entity binding
 * - defaults: param default values
 * - context: static capabilities for cross-block coordination
 * - initialState: initial values for mutable block state
 * - inheritData: internal flag for cascaded data delivery
 *     true  → deliver all data available at ancestor levels (default)
 *     false → deliver nothing (component opted out with `data: false`)
 *
 * Data delivery is default-on: a component without any `data:` field
 * receives all data cascaded from its ancestor levels (block → page →
 * parent page → site) via `content.data.{schema}`. A component that
 * genuinely cannot tolerate ambient data declares `data: false`.
 *
 * `data: { entity: 'articles' }` is a **declaration**, not a gate. It
 * tells the editor and prepare-props what shape the component expects,
 * but does not restrict delivery.
 *
 * Full metadata (titles, descriptions, hints, etc.) stays in schema.json
 * for the visual editor.
 */

import { isRichSchema } from '@uniweb/core'

/**
 * Parse data string into structured object
 * 'events' -> { type: 'events', limit: null }
 * 'events:6' -> { type: 'events', limit: 6 }
 *
 * @param {string} dataString
 * @returns {{ type: string, limit: number|null }}
 */
function parseDataString(dataString) {
  if (!dataString || typeof dataString !== 'string') {
    return null
  }

  const [type, limitStr] = dataString.split(':')
  return {
    type: type.trim(),
    limit: limitStr ? parseInt(limitStr, 10) : null,
  }
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
  if (field.enum !== undefined) lean.enum = field.enum
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
 *   - `type: 'string'` → `type: 'text'` (legacy alias; warn in dev)
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
    if (key === 'type' && v === 'string') {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(
          "[uniweb] form schema field type 'string' is a legacy alias; use 'text' instead."
        )
      }
      out[key] = 'text'
    } else if (v && typeof v === 'object') {
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
  // Named ref → the resolved schema's fields.
  const ref = typeof value === 'string'
    ? value
    : (value && typeof value.schema === 'string' ? value.schema : null)
  if (ref) {
    const resolved = dataSchemaMap[ref]
    if (!resolved?.fields) return null
    const lean = extractSchemaFields(resolved.fields)
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

  // Data schemas. `data:` is the single declaration surface for a section's
  // structured data: it maps each `content.data` key to its schema. A value
  // is a named ref (`'@/member'`), an inline field map, or an inline rich-form
  // (`{ fields: [...] }`, an editor form). Source-agnostic — the data may
  // arrive by fetch, tagged code block, or editor form; the schema and its
  // defaults are identical. The schema is a hint (defaults + editor), not a
  // delivery gate; delivery is default-on. `data: false` opts the section out
  // of all ambient data.
  if (fullMeta.data === false) {
    runtime.inheritData = false
  } else if (fullMeta.data && typeof fullMeta.data === 'object' && !Array.isArray(fullMeta.data)) {
    for (const [key, value] of Object.entries(fullMeta.data)) {
      const lean = leanDataSchema(value, dataSchemaMap)
      if (lean) {
        runtime.schemas = runtime.schemas || {}
        runtime.schemas[key] = lean
      }
    }
  } else if (fullMeta.data !== undefined) {
    throw new Error(
      `[uniweb] Invalid 'data' in meta.js: expected false or { <key>: <schema> }, got ${JSON.stringify(fullMeta.data)}. ` +
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

  // Data delivery is default-on. `runtime.inheritData` stays undefined unless
  // the component opts out with `data: false`, in which case EntityStore
  // delivers nothing. A `data:` binding is a hint (schema for defaults +
  // editor), never a delivery gate.

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

  if (fullMeta.transitions && typeof fullMeta.transitions === 'object') {
    runtime.transitions = fullMeta.transitions
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
