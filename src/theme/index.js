/**
 * Theme Module
 *
 * Exports all theme-related utilities for the build process.
 *
 * @module @uniweb/build/theme
 */

// Shade generation
export {
  parseColor,
  formatOklch,
  formatHex,
  generateShades,
  generatePalettes,
  isValidColor,
  getShadeLevels,
} from './shade-generator.js'

// CSS generation
export {
  generateThemeCSS,
  generateContextCSS,
  generatePaletteVars,
  getDefaultContextTokens,
  getDefaultColors,
} from './css-generator.js'

// Theme processing
export {
  validateThemeConfig,
  processTheme,
  extractFoundationVars,
  foundationHasVars,
} from './processor.js'

// Default export for convenience
import { processTheme } from './processor.js'
import { generateThemeCSS } from './css-generator.js'

/**
 * Process theme configuration and generate CSS in one step
 *
 * @param {Object} themeYml - Raw theme.yml content
 * @param {Object} options - Processing options
 * @param {Object} options.foundationVars - Foundation variables
 * @returns {{ css: string, config: Object, errors: string[], warnings: string[] }}
 */
export function buildTheme(themeYml = {}, options = {}) {
  const { config, errors, warnings } = processTheme(themeYml, options)
  const css = generateThemeCSS(config)

  return {
    css,
    config,
    errors,
    warnings,
  }
}

export default {
  buildTheme,
  processTheme,
  generateThemeCSS,
}
