/**
 * Theme CSS Generator
 *
 * Generates complete CSS for site theming including:
 * - Color palettes as CSS custom properties
 * - Context classes (light/medium/dark) with semantic tokens
 * - Foundation-specific variables
 * - Optional dark scheme support
 *
 * @module @uniweb/build/theme/css-generator
 */

import { generatePalettes, formatOklch } from './shade-generator.js'

// Default semantic tokens for each context
// These map abstract concepts to specific palette values
const DEFAULT_CONTEXT_TOKENS = {
  light: {
    'bg': 'var(--neutral-50)',
    'bg-subtle': 'var(--neutral-100)',
    'bg-muted': 'var(--neutral-200)',
    'text': 'var(--neutral-950)',
    'text-muted': 'var(--neutral-600)',
    'text-subtle': 'var(--neutral-500)',
    'heading': 'var(--neutral-900)',
    'link': 'var(--primary-600)',
    'link-hover': 'var(--primary-700)',
    'border': 'var(--neutral-200)',
    'border-muted': 'var(--neutral-100)',
    'ring': 'var(--primary-500)',
    'btn-primary-bg': 'var(--primary-600)',
    'btn-primary-text': 'white',
    'btn-primary-hover': 'var(--primary-700)',
    'btn-secondary-bg': 'var(--neutral-100)',
    'btn-secondary-text': 'var(--neutral-900)',
    'btn-secondary-hover': 'var(--neutral-200)',
  },
  medium: {
    'bg': 'var(--neutral-100)',
    'bg-subtle': 'var(--neutral-200)',
    'bg-muted': 'var(--neutral-300)',
    'text': 'var(--neutral-950)',
    'text-muted': 'var(--neutral-700)',
    'text-subtle': 'var(--neutral-600)',
    'heading': 'var(--neutral-900)',
    'link': 'var(--primary-600)',
    'link-hover': 'var(--primary-700)',
    'border': 'var(--neutral-300)',
    'border-muted': 'var(--neutral-200)',
    'ring': 'var(--primary-500)',
    'btn-primary-bg': 'var(--primary-600)',
    'btn-primary-text': 'white',
    'btn-primary-hover': 'var(--primary-700)',
    'btn-secondary-bg': 'var(--neutral-200)',
    'btn-secondary-text': 'var(--neutral-900)',
    'btn-secondary-hover': 'var(--neutral-300)',
  },
  dark: {
    'bg': 'var(--neutral-900)',
    'bg-subtle': 'var(--neutral-800)',
    'bg-muted': 'var(--neutral-700)',
    'text': 'var(--neutral-50)',
    'text-muted': 'var(--neutral-300)',
    'text-subtle': 'var(--neutral-400)',
    'heading': 'white',
    'link': 'var(--primary-400)',
    'link-hover': 'var(--primary-300)',
    'border': 'var(--neutral-700)',
    'border-muted': 'var(--neutral-800)',
    'ring': 'var(--primary-500)',
    'btn-primary-bg': 'var(--primary-500)',
    'btn-primary-text': 'white',
    'btn-primary-hover': 'var(--primary-400)',
    'btn-secondary-bg': 'var(--neutral-800)',
    'btn-secondary-text': 'var(--neutral-100)',
    'btn-secondary-hover': 'var(--neutral-700)',
  },
}

// Default color palette configuration
const DEFAULT_COLORS = {
  primary: '#3b82f6',   // Blue
  secondary: '#64748b', // Slate
  accent: '#8b5cf6',    // Purple
  neutral: '#71717a',   // Zinc
}

// Shade levels for CSS variable generation
const SHADE_LEVELS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

/**
 * Generate CSS variable declarations from an object
 *
 * @param {Object} vars - Object with variable names as keys
 * @param {string} indent - Indentation string
 * @returns {string} CSS variable declarations
 */
function generateVarDeclarations(vars, indent = '  ') {
  return Object.entries(vars)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join('\n')
}

/**
 * Generate color palette CSS variables
 *
 * @param {Object} palettes - Object with palette name → shades
 * @returns {string} CSS variable declarations for all palettes
 */
function generatePaletteVars(palettes) {
  const lines = []

  for (const [name, shades] of Object.entries(palettes)) {
    for (const level of SHADE_LEVELS) {
      if (shades[level]) {
        lines.push(`  --${name}-${level}: ${shades[level]};`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Generate context class CSS
 *
 * @param {string} context - Context name (light, medium, dark)
 * @param {Object} tokens - Token overrides
 * @returns {string} CSS for context class
 */
function generateContextCSS(context, tokens = {}) {
  const defaultTokens = DEFAULT_CONTEXT_TOKENS[context] || DEFAULT_CONTEXT_TOKENS.light
  const mergedTokens = { ...defaultTokens, ...tokens }

  const vars = generateVarDeclarations(mergedTokens)

  return `.context-${context} {\n${vars}\n  background-color: var(--bg);\n}`
}

/**
 * Generate dark scheme CSS (for site-wide dark mode toggle)
 *
 * @param {Object} config - Appearance configuration
 * @returns {string} CSS for dark scheme support
 */
function generateDarkSchemeCSS(config = {}) {
  const { respectSystemPreference = true } = config

  // Dark scheme tokens - similar to dark context but at root level
  const darkTokens = {
    'bg': 'var(--neutral-950)',
    'bg-subtle': 'var(--neutral-900)',
    'bg-muted': 'var(--neutral-800)',
    'text': 'var(--neutral-50)',
    'text-muted': 'var(--neutral-300)',
    'text-subtle': 'var(--neutral-400)',
    'heading': 'white',
    'link': 'var(--primary-400)',
    'link-hover': 'var(--primary-300)',
    'border': 'var(--neutral-800)',
    'border-muted': 'var(--neutral-900)',
  }

  const vars = generateVarDeclarations(darkTokens)

  let css = `/* Dark scheme (user preference) */\n`
  css += `.scheme-dark {\n${vars}\n}\n`

  if (respectSystemPreference) {
    css += `\n@media (prefers-color-scheme: dark) {\n`
    css += `  :root:not(.scheme-light) {\n`
    for (const [name, value] of Object.entries(darkTokens)) {
      css += `    --${name}: ${value};\n`
    }
    css += `  }\n`
    css += `}\n`
  }

  return css
}

/**
 * Generate font CSS
 *
 * @param {Object} fonts - Font configuration
 * @returns {string} CSS for fonts
 */
function generateFontCSS(fonts = {}) {
  const lines = []

  // Font imports
  if (fonts.import && Array.isArray(fonts.import)) {
    for (const font of fonts.import) {
      if (font.url) {
        lines.push(`@import url('${font.url}');`)
      }
    }
    if (lines.length > 0) {
      lines.push('') // Empty line after imports
    }
  }

  // Font family variables
  const fontVars = []
  if (fonts.body) {
    fontVars.push(`  --font-body: ${fonts.body};`)
  }
  if (fonts.heading) {
    fontVars.push(`  --font-heading: ${fonts.heading};`)
  }
  if (fonts.mono) {
    fontVars.push(`  --font-mono: ${fonts.mono};`)
  }

  if (fontVars.length > 0) {
    lines.push(':root {')
    lines.push(...fontVars)
    lines.push('}')
  }

  return lines.join('\n')
}

/**
 * Generate foundation-specific CSS variables
 *
 * @param {Object} vars - Foundation variables from vars.js
 * @returns {string} CSS variable declarations
 */
function generateFoundationVars(vars = {}) {
  if (!vars || Object.keys(vars).length === 0) {
    return ''
  }

  const declarations = []

  for (const [name, config] of Object.entries(vars)) {
    const value = typeof config === 'object' ? config.default : config
    if (value !== undefined) {
      declarations.push(`  --${name}: ${value};`)
    }
  }

  if (declarations.length === 0) {
    return ''
  }

  return `:root {\n${declarations.join('\n')}\n}`
}

/**
 * Generate complete theme CSS
 *
 * @param {Object} config - Processed theme configuration
 * @param {Object} config.colors - Color palette configuration
 * @param {Object} config.contexts - Context token overrides
 * @param {Object} config.fonts - Font configuration
 * @param {Object} config.appearance - Appearance settings (dark mode, etc.)
 * @param {Object} config.foundationVars - Foundation-specific variables
 * @returns {string} Complete CSS string
 */
export function generateThemeCSS(config = {}) {
  const {
    colors = DEFAULT_COLORS,
    contexts = {},
    fonts = {},
    appearance = {},
    foundationVars = {},
  } = config

  const sections = []

  // 1. Font imports and variables
  const fontCSS = generateFontCSS(fonts)
  if (fontCSS) {
    sections.push('/* Typography */\n' + fontCSS)
  }

  // 2. Color palettes
  const palettes = generatePalettes(colors)
  const paletteVars = generatePaletteVars(palettes)
  sections.push(`/* Color Palettes */\n:root {\n${paletteVars}\n}`)

  // 3. Default semantic tokens (applied to :root for global defaults)
  const defaultTokens = { ...DEFAULT_CONTEXT_TOKENS.light, ...(contexts.light || {}) }
  const defaultVars = generateVarDeclarations(defaultTokens)
  sections.push(`/* Default Semantic Tokens */\n:root {\n${defaultVars}\n}`)

  // 4. Context classes
  const contextCSS = [
    generateContextCSS('light', contexts.light),
    generateContextCSS('medium', contexts.medium),
    generateContextCSS('dark', contexts.dark),
  ]
  sections.push('/* Color Contexts */\n' + contextCSS.join('\n\n'))

  // 5. Foundation variables
  const foundationCSS = generateFoundationVars(foundationVars)
  if (foundationCSS) {
    sections.push('/* Foundation Variables */\n' + foundationCSS)
  }

  // 6. Dark scheme support (if enabled)
  if (appearance.allowToggle || appearance.schemes?.includes('dark')) {
    sections.push(generateDarkSchemeCSS(appearance))
  }

  // 7. Site background (if specified in theme.yml)
  if (config.background) {
    sections.push(`/* Site Background */\nbody {\n  background: ${config.background};\n}`)
  }

  return sections.join('\n\n')
}

/**
 * Generate CSS for a single context (useful for testing)
 */
export { generateContextCSS }

/**
 * Generate palette CSS variables (useful for testing)
 */
export { generatePaletteVars }

/**
 * Get default context tokens
 */
export function getDefaultContextTokens() {
  return JSON.parse(JSON.stringify(DEFAULT_CONTEXT_TOKENS))
}

/**
 * Get default colors
 */
export function getDefaultColors() {
  return { ...DEFAULT_COLORS }
}

export default {
  generateThemeCSS,
  generateContextCSS,
  generatePaletteVars,
  getDefaultContextTokens,
  getDefaultColors,
}
