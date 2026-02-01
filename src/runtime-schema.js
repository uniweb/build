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
 * - inheritData: boolean or array for cascaded data from page/site fetches
 *
 * Full metadata (titles, descriptions, hints, etc.) stays in schema.json
 * for the visual editor.
 */

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
 * Full format has: { name, version?, description?, fields: {...} }
 *
 * @param {Object} schema - Schema value to check
 * @returns {boolean}
 */
function isFullSchemaFormat(schema) {
  return (
    schema &&
    typeof schema === 'object' &&
    typeof schema.fields === 'object' &&
    schema.fields !== null
  )
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

  // Background opt-out: 'self' means the component renders its own background
  // layer (solid colors, insets, effects), so the runtime skips its Background.
  if (fullMeta.background) {
    runtime.background = fullMeta.background
  }

  // Data binding (CMS entities)
  // Supports both old format (data: 'person:6') and new consolidated format
  // (data: { entity: 'person:6', schemas: {...}, inherit: [...] })
  if (fullMeta.data) {
    if (typeof fullMeta.data === 'string') {
      // Old format: data: 'person:6'
      const parsed = parseDataString(fullMeta.data)
      if (parsed) {
        runtime.data = parsed
      }
    } else if (typeof fullMeta.data === 'object') {
      // New format: data: { entity, schemas, inherit }
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
      if (fullMeta.data.inherit !== undefined) {
        runtime.inheritData = fullMeta.data.inherit
      }
    }
  }

  // Param defaults - support both v2 'params' and v1 'properties'
  const paramsObj = fullMeta.params || fullMeta.properties
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

  // Data inheritance - component receives cascaded data from page/site level fetches
  // Can be: true (inherit all), false (inherit none), or ['schema1', 'schema2'] (selective)
  // Top-level inheritData supported for backwards compat (lower priority than data.inherit)
  if (fullMeta.inheritData !== undefined && runtime.inheritData === undefined) {
    runtime.inheritData = fullMeta.inheritData
  }

  // Auto-derive inheritData from entity type when no explicit inherit is set.
  // data: { entity: 'articles' } implies inheritData: ['articles']
  if (runtime.data && runtime.inheritData === undefined) {
    runtime.inheritData = [runtime.data.type]
  }

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
