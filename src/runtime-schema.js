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
 * Keeps runtime fields (type, default, options, of, schema)
 *
 * @param {string|Object} field - Schema field definition
 * @returns {string|Object} - Lean field definition
 */
function extractSchemaField(field) {
  // Shorthand: 'string', 'number', 'boolean'
  if (typeof field === 'string') {
    return field
  }

  if (!field || typeof field !== 'object') {
    return field
  }

  const lean = {}

  // Keep runtime-relevant fields
  if (field.type) lean.type = field.type
  if (field.default !== undefined) lean.default = field.default
  if (field.options) lean.options = field.options

  // Handle array 'of' - can be string, schema name, or inline object
  if (field.of !== undefined) {
    if (typeof field.of === 'string') {
      lean.of = field.of
    } else if (typeof field.of === 'object') {
      // Inline schema definition
      lean.of = extractSchemaFields(field.of)
    }
  }

  // Handle nested object 'schema'
  if (field.schema && typeof field.schema === 'object') {
    lean.schema = extractSchemaFields(field.schema)
  }

  // If we only have 'type' and it's a simple type, use shorthand
  const keys = Object.keys(lean)
  if (keys.length === 1 && keys[0] === 'type' && ['string', 'number', 'boolean'].includes(lean.type)) {
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
 * Extract lean schemas from meta.js schemas object
 * Strips editor-only fields while preserving structure
 *
 * Supports two formats:
 * 1. Full @uniweb/schemas format: { name, version, fields: {...} }
 * 2. Inline fields format: { fieldName: fieldDef, ... }
 *
 * @param {Object} schemas - The schemas object from meta.js
 * @returns {Object|null} - Lean schemas or null if empty
 */
function extractSchemas(schemas) {
  if (!schemas || typeof schemas !== 'object') {
    return null
  }

  const lean = {}
  for (const [schemaName, schemaValue] of Object.entries(schemas)) {
    // Rich form schemas: pass through (with normalization). They drive both
    // the FormBlock editor UI and the runtime default application.
    if (isRichSchema(schemaValue)) {
      lean[schemaName] = normalizeRichSchema(schemaValue)
      continue
    }

    // Handle full schema format (from @uniweb/schemas or npm packages)
    // Extract just the fields, discard name/version/description metadata
    const schemaFields = isFullSchemaFormat(schemaValue)
      ? schemaValue.fields
      : schemaValue

    const leanSchema = extractSchemaFields(schemaFields)
    if (Object.keys(leanSchema).length > 0) {
      lean[schemaName] = leanSchema
    }
  }

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
 * @returns {Object|null} - Lean runtime schema or null if empty
 */
export function extractRuntimeSchema(fullMeta) {
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

  // Data binding (CMS entities)
  //
  // Supported forms:
  //   data: false                            → explicit opt-out
  //   data: { entity: 'person:6' }           → declaration + shape hints
  //   data: { schemas: {...} }               → validation / default shapes
  //   data: 'person:6'                       → legacy string form (declaration only)
  //
  // Deprecated forms (accepted with dev-mode warning, removed in next release):
  //   data: { inherit: true | false | [...] }  — component-side gating is gone;
  //                                              delivery is default-on
  //   data: { detail, limit }                   — moved to block-level fetch
  if (fullMeta.data === false) {
    // Explicit opt-out — deliver nothing to this component.
    runtime.inheritData = false
  } else if (typeof fullMeta.data === 'string') {
    // Legacy string form: data: 'person:6'
    const parsed = parseDataString(fullMeta.data)
    if (parsed) {
      runtime.data = parsed
    }
  } else if (fullMeta.data && typeof fullMeta.data === 'object') {
    if (fullMeta.data.entity) {
      const parsed = parseDataString(fullMeta.data.entity)
      if (parsed) {
        runtime.data = parsed
      }
    }
    if (fullMeta.data.schemas) {
      const schemas = extractSchemas(fullMeta.data.schemas)
      if (schemas) {
        runtime.schemas = schemas
      }
    }
    // Deprecated: data.inherit is a no-op under default-on delivery. The
    // only behavior we still honor is `inherit: false` → treat as opt-out,
    // so existing foundations that wrote "don't deliver" still don't.
    // Array and `true` forms are ignored — delivery happens regardless.
    if (fullMeta.data.inherit === false) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(
          '[uniweb] `data: { inherit: false }` is deprecated; use `data: false` instead.'
        )
      }
      runtime.inheritData = false
    } else if (fullMeta.data.inherit !== undefined) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(
          '[uniweb] `data: { inherit: ... }` is deprecated; delivery is default-on. Remove the `inherit` field.'
        )
      }
    }
    // Deprecated: detail/limit on the component side. Block-level
    // `fetch: { inherit: true, detail, limit }` is where these belong now.
    if (fullMeta.data.detail !== undefined || fullMeta.data.limit !== undefined) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(
          '[uniweb] `data: { detail, limit }` on the component side is deprecated; set these on a block-level `fetch: { inherit: true, ... }` instead.'
        )
      }
    }
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

  // Schemas - lean version for runtime validation/defaults
  // Strips editor-only fields (label, hint, description)
  // Top-level schemas supported for backwards compat (lower priority than data.schemas)
  if (fullMeta.schemas && !runtime.schemas) {
    const schemas = extractSchemas(fullMeta.schemas)
    if (schemas) {
      runtime.schemas = schemas
    }
  }

  // Top-level inheritData (legacy, pre-`data.*` format) — honored only as opt-out.
  // Truthy values and arrays are ignored; delivery is default-on.
  if (fullMeta.inheritData === false && runtime.inheritData === undefined) {
    runtime.inheritData = false
  }

  // Data delivery is default-on. `runtime.inheritData` stays undefined unless
  // the component explicitly opts out (runtime.inheritData === false), in
  // which case EntityStore delivers nothing. The declaration `data.entity`
  // no longer implies a gate — it's a hint consumed by prepare-props and
  // the editor.

  return Object.keys(runtime).length > 0 ? runtime : null
}

/**
 * Extract runtime schemas for all components
 *
 * @param {Object} componentsMeta - Map of componentName -> meta.js content
 * @returns {Object} - Map of componentName -> runtime schema (excludes null entries)
 */
export function extractAllRuntimeSchemas(componentsMeta) {
  const schemas = {}

  for (const [name, meta] of Object.entries(componentsMeta)) {
    const schema = extractRuntimeSchema(meta)
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
 * - transitions: View transition name mapping (stored but not acted on yet)
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
