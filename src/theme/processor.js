/**
 * Theme Processor
 *
 * Reads, validates, and processes theme configuration from theme.yml,
 * merges with foundation defaults, and produces a complete theme config
 * ready for CSS generation.
 *
 * @module @uniweb/build/theme/processor
 */

import { isValidColor, generatePalettes } from './shade-generator.js'
import { getDefaultColors, getDefaultContextTokens } from './css-generator.js'

/**
 * Default appearance configuration
 */
const DEFAULT_APPEARANCE = {
  default: 'light',        // Default color scheme
  allowToggle: false,      // Whether to show scheme toggle
  respectSystemPreference: true, // Honor prefers-color-scheme
}

/**
 * Default font configuration
 */
const DEFAULT_FONTS = {
  body: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  heading: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
}

/**
 * Validate color configuration
 *
 * @param {Object} colors - Color configuration object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateColors(colors) {
  const errors = []

  if (!colors || typeof colors !== 'object') {
    return { valid: true, errors } // No colors is valid (use defaults)
  }

  for (const [name, value] of Object.entries(colors)) {
    // Skip pre-defined palette objects
    if (typeof value === 'object' && value !== null) {
      continue
    }

    if (typeof value !== 'string') {
      errors.push(`Color "${name}" must be a string or shade object, got ${typeof value}`)
      continue
    }

    if (!isValidColor(value)) {
      errors.push(`Color "${name}" has invalid value: ${value}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate context configuration
 *
 * @param {Object} contexts - Context configuration object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateContexts(contexts) {
  const errors = []

  if (!contexts || typeof contexts !== 'object') {
    return { valid: true, errors }
  }

  const validContexts = ['light', 'medium', 'dark']

  for (const [context, tokens] of Object.entries(contexts)) {
    if (!validContexts.includes(context)) {
      errors.push(`Unknown context "${context}". Valid contexts: ${validContexts.join(', ')}`)
      continue
    }

    if (typeof tokens !== 'object' || tokens === null) {
      errors.push(`Context "${context}" must be an object`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate font configuration
 *
 * @param {Object} fonts - Font configuration object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFonts(fonts) {
  const errors = []

  if (!fonts || typeof fonts !== 'object') {
    return { valid: true, errors }
  }

  // Validate imports
  if (fonts.import !== undefined) {
    if (!Array.isArray(fonts.import)) {
      errors.push('fonts.import must be an array')
    } else {
      for (const [index, item] of fonts.import.entries()) {
        if (typeof item !== 'object' || !item.url) {
          errors.push(`fonts.import[${index}] must have a "url" property`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate appearance configuration
 *
 * @param {Object} appearance - Appearance configuration
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAppearance(appearance) {
  const errors = []

  if (!appearance || typeof appearance !== 'object') {
    // Simple string value (e.g., appearance: light)
    if (typeof appearance === 'string') {
      if (!['light', 'dark', 'system'].includes(appearance)) {
        errors.push(`Invalid appearance value: ${appearance}. Must be "light", "dark", or "system"`)
      }
    }
    return { valid: errors.length === 0, errors }
  }

  if (appearance.default && !['light', 'dark', 'system'].includes(appearance.default)) {
    errors.push(`Invalid appearance.default: ${appearance.default}`)
  }

  if (appearance.schemes !== undefined) {
    if (!Array.isArray(appearance.schemes)) {
      errors.push('appearance.schemes must be an array')
    } else {
      const validSchemes = ['light', 'dark']
      for (const scheme of appearance.schemes) {
        if (!validSchemes.includes(scheme)) {
          errors.push(`Invalid scheme: ${scheme}. Valid schemes: ${validSchemes.join(', ')}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate foundation variables configuration
 *
 * @param {Object} vars - Foundation variables
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFoundationVars(vars) {
  const errors = []

  if (!vars || typeof vars !== 'object') {
    return { valid: true, errors }
  }

  for (const [name, config] of Object.entries(vars)) {
    // Variable name validation
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
      errors.push(`Invalid variable name "${name}". Use lowercase letters, numbers, and hyphens.`)
    }

    // Config validation
    if (typeof config !== 'object' && typeof config !== 'string' && typeof config !== 'number') {
      errors.push(`Variable "${name}" must have a string, number, or config object value`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate complete theme configuration
 *
 * @param {Object} config - Raw theme configuration
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateThemeConfig(config) {
  const allErrors = []

  if (!config || typeof config !== 'object') {
    return { valid: true, errors: [] } // Empty config is valid (use all defaults)
  }

  const colorValidation = validateColors(config.colors)
  const contextValidation = validateContexts(config.contexts)
  const fontValidation = validateFonts(config.fonts)
  const appearanceValidation = validateAppearance(config.appearance)

  allErrors.push(...colorValidation.errors)
  allErrors.push(...contextValidation.errors)
  allErrors.push(...fontValidation.errors)
  allErrors.push(...appearanceValidation.errors)

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
  }
}

/**
 * Normalize appearance configuration
 *
 * @param {string|Object} appearance - Raw appearance config
 * @returns {Object} Normalized appearance config
 */
function normalizeAppearance(appearance) {
  if (!appearance) {
    return { ...DEFAULT_APPEARANCE }
  }

  // Simple string value: "light", "dark", or "system"
  if (typeof appearance === 'string') {
    return {
      default: appearance,
      allowToggle: false,
      respectSystemPreference: appearance === 'system',
    }
  }

  return {
    ...DEFAULT_APPEARANCE,
    ...appearance,
  }
}

/**
 * Merge foundation variables with site overrides
 *
 * @param {Object} foundationVars - Variables from foundation vars.js
 * @param {Object} siteVars - Site-level variable overrides
 * @returns {Object} Merged variables
 */
function mergeFoundationVars(foundationVars = {}, siteVars = {}) {
  const merged = {}

  // Start with foundation defaults
  for (const [name, config] of Object.entries(foundationVars)) {
    merged[name] = typeof config === 'object' ? { ...config } : { default: config }
  }

  // Apply site overrides
  for (const [name, value] of Object.entries(siteVars)) {
    if (merged[name]) {
      // Override the default value
      merged[name].default = value
    } else {
      // New variable from site
      merged[name] = { default: value }
    }
  }

  return merged
}

/**
 * Process raw theme configuration into a complete, validated config
 *
 * @param {Object} rawConfig - Raw theme.yml content
 * @param {Object} options - Processing options
 * @param {Object} options.foundationVars - Foundation variables from vars.js
 * @param {boolean} options.strict - Throw on validation errors (default: false)
 * @returns {{ config: Object, errors: string[], warnings: string[] }}
 */
export function processTheme(rawConfig = {}, options = {}) {
  const { foundationVars = {}, strict = false } = options
  const errors = []
  const warnings = []

  // Validate raw config
  const validation = validateThemeConfig(rawConfig)
  if (!validation.valid) {
    errors.push(...validation.errors)
    if (strict) {
      throw new Error(`Theme configuration errors:\n${errors.join('\n')}`)
    }
  }

  // Process colors
  const defaultColors = getDefaultColors()
  const rawColors = rawConfig.colors || {}

  // Filter to only valid colors (skip invalid ones in non-strict mode)
  const validColors = {}
  for (const [name, value] of Object.entries({ ...defaultColors, ...rawColors })) {
    // Skip objects (pre-defined palettes) or invalid color strings
    if (typeof value === 'object' && value !== null) {
      validColors[name] = value
    } else if (isValidColor(value)) {
      validColors[name] = value
    }
    // Invalid colors are skipped (error already recorded during validation)
  }

  const colors = validColors

  // Generate color palettes (shades 50-950 for each color)
  // This is used by the Theme class for runtime color access
  const palettes = generatePalettes(colors)

  // Warn if required colors are missing
  if (!rawConfig.colors?.primary) {
    warnings.push('No primary color specified, using default blue (#3b82f6)')
  }
  if (!rawConfig.colors?.neutral) {
    warnings.push('No neutral color specified, using default zinc (#71717a)')
  }

  // Process contexts
  const defaultContexts = getDefaultContextTokens()
  const contexts = {
    light: { ...defaultContexts.light, ...(rawConfig.contexts?.light || {}) },
    medium: { ...defaultContexts.medium, ...(rawConfig.contexts?.medium || {}) },
    dark: { ...defaultContexts.dark, ...(rawConfig.contexts?.dark || {}) },
  }

  // Process fonts
  const fonts = {
    ...DEFAULT_FONTS,
    ...(rawConfig.fonts || {}),
  }

  // Normalize and process appearance
  const appearance = normalizeAppearance(rawConfig.appearance)

  // Merge foundation variables with site overrides
  const mergedFoundationVars = mergeFoundationVars(
    foundationVars,
    rawConfig.vars || rawConfig.foundationVars || {}
  )

  // Validate merged foundation vars
  const foundationValidation = validateFoundationVars(mergedFoundationVars)
  if (!foundationValidation.valid) {
    warnings.push(...foundationValidation.errors)
  }

  const config = {
    colors,      // Raw colors for CSS generator
    palettes,    // Generated palettes for Theme class
    contexts,
    fonts,
    appearance,
    foundationVars: mergedFoundationVars,
  }

  return { config, errors, warnings }
}

/**
 * Load foundation variables from vars.js export
 *
 * @param {Object} varsModule - Imported vars.js module
 * @returns {Object} Foundation variables
 */
export function extractFoundationVars(varsModule) {
  if (!varsModule) {
    return {}
  }

  // Handle default export
  const module = varsModule.default || varsModule

  // Extract vars property or use whole object
  return module.vars || module
}

/**
 * Check if a foundation has theme variables
 *
 * @param {Object} foundationSchema - Foundation schema.json content
 * @returns {boolean}
 */
export function foundationHasVars(foundationSchema) {
  // Check both _self.themeVars (new location) and root themeVars (backwards compat)
  return foundationSchema?._self?.themeVars != null || foundationSchema?.themeVars != null
}

export default {
  validateThemeConfig,
  processTheme,
  extractFoundationVars,
  foundationHasVars,
}
