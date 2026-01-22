/**
 * Runtime Schema Extractor
 *
 * Extracts lean runtime-relevant metadata from full meta.js files.
 * The runtime schema is optimized for size and contains only what's
 * needed at render time:
 *
 * - background: boolean for engine-level background handling
 * - data: { type, limit } for CMS entity binding
 * - defaults: param default values
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

  // Background handling (boolean or 'auto'/'manual')
  if (fullMeta.background) {
    runtime.background = fullMeta.background
  }

  // Data binding (CMS entities)
  if (fullMeta.data) {
    const parsed = parseDataString(fullMeta.data)
    if (parsed) {
      runtime.data = parsed
    }
  }

  // Param defaults - support both v2 'params' and v1 'properties'
  const paramsObj = fullMeta.params || fullMeta.properties
  const defaults = extractParamDefaults(paramsObj)
  if (defaults) {
    runtime.defaults = defaults
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

/**
 * Extract lean foundation runtime config from foundation meta.js
 *
 * @param {Object} foundationMeta - The foundation-level meta.js content
 * @returns {Object} - Foundation runtime config
 */
export function extractFoundationRuntime(foundationMeta) {
  if (!foundationMeta || typeof foundationMeta !== 'object') {
    return {}
  }

  const foundation = {}

  // Name (required for identification)
  if (foundationMeta.name) {
    foundation.name = foundationMeta.name
  }

  // Title (display name)
  if (foundationMeta.title) {
    foundation.title = foundationMeta.title
  }

  // Runtime props (available to all components)
  // Support both 'runtime' (v2) and 'props' (v1) field names
  const runtimeProps = foundationMeta.runtime || foundationMeta.props
  if (runtimeProps && typeof runtimeProps === 'object') {
    foundation.runtime = runtimeProps
  }

  return foundation
}
