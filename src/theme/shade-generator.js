/**
 * OKLCH Shade Generator
 *
 * Generates 11 color shades (50-950) from a single base color using
 * the OKLCH color space for perceptually uniform results.
 *
 * Supports multiple generation modes:
 * - 'fixed' (default): Predictable lightness values, constant hue
 * - 'natural': Temperature-aware hue shifts, curved chroma
 * - 'vivid': Higher saturation, more dramatic chroma curve
 *
 * @module @uniweb/build/theme/shade-generator
 */

// Standard shade levels matching Tailwind's scale
const SHADE_LEVELS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

// Lightness values for each shade (perceptually uniform steps)
// These are calibrated to match typical design system expectations
const LIGHTNESS_MAP = {
  50: 0.97,   // Very light - almost white
  100: 0.93,
  200: 0.87,
  300: 0.78,
  400: 0.68,
  500: 0.55,  // Base color - most vibrant
  600: 0.48,
  700: 0.40,
  800: 0.32,
  900: 0.24,
  950: 0.14,  // Very dark - almost black
}

// Chroma scaling - reduce saturation at extremes to avoid clipping
// Values represent percentage of original chroma to preserve
const CHROMA_SCALE = {
  50: 0.15,   // Very desaturated at light end
  100: 0.25,
  200: 0.40,
  300: 0.65,
  400: 0.85,
  500: 1.0,   // Full chroma at base
  600: 0.95,
  700: 0.85,
  800: 0.75,
  900: 0.60,
  950: 0.45,  // Reduced chroma at dark end
}

// Mode-specific configurations
const MODE_CONFIG = {
  // Fixed mode: predictable, consistent (current default behavior)
  fixed: {
    hueShift: { light: 0, dark: 0 },
    chromaBoost: 1.0,
    lightEndChroma: 0.15,
    darkEndChroma: 0.45,
  },
  // Natural mode: temperature-aware hue shifts, organic feel
  natural: {
    hueShift: { light: 5, dark: -15 },  // For warm colors (inverted for cool)
    chromaBoost: 1.1,
    lightEndChroma: 0.20,
    darkEndChroma: 0.40,
  },
  // Vivid mode: higher saturation, more dramatic
  vivid: {
    hueShift: { light: 3, dark: -10 },
    chromaBoost: 1.4,
    lightEndChroma: 0.35,
    darkEndChroma: 0.55,
  },
}

/**
 * Parse a color string into OKLCH components
 * Supports: hex (#fff, #ffffff), rgb(), hsl(), oklch()
 *
 * @param {string} color - Color string in any supported format
 * @returns {{ l: number, c: number, h: number }} OKLCH components
 */
export function parseColor(color) {
  if (!color || typeof color !== 'string') {
    throw new Error(`Invalid color: ${color}`)
  }

  const trimmed = color.trim().toLowerCase()

  // OKLCH format: oklch(0.55 0.2 250) or oklch(55% 0.2 250deg)
  if (trimmed.startsWith('oklch(')) {
    return parseOklch(trimmed)
  }

  // Hex format: #fff or #ffffff
  if (trimmed.startsWith('#')) {
    return hexToOklch(trimmed)
  }

  // RGB format: rgb(255, 100, 50) or rgb(255 100 50)
  if (trimmed.startsWith('rgb')) {
    return rgbToOklch(trimmed)
  }

  // HSL format: hsl(200, 80%, 50%) or hsl(200 80% 50%)
  if (trimmed.startsWith('hsl')) {
    return hslToOklch(trimmed)
  }

  // Try as hex without #
  if (/^[0-9a-f]{3,8}$/i.test(trimmed)) {
    return hexToOklch('#' + trimmed)
  }

  throw new Error(`Unsupported color format: ${color}`)
}

/**
 * Parse OKLCH string
 */
function parseOklch(str) {
  const match = str.match(/oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(deg)?\s*\)/)
  if (!match) {
    throw new Error(`Invalid oklch format: ${str}`)
  }

  let l = parseFloat(match[1])
  if (match[2] === '%') l /= 100

  const c = parseFloat(match[3])
  const h = parseFloat(match[4])

  return { l, c, h }
}

/**
 * Convert hex color to OKLCH
 */
function hexToOklch(hex) {
  const rgb = hexToRgb(hex)
  return rgbValuesToOklch(rgb.r, rgb.g, rgb.b)
}

/**
 * Parse hex string to RGB values
 */
function hexToRgb(hex) {
  let h = hex.replace('#', '')

  // Expand shorthand (e.g., #fff -> #ffffff)
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  }

  if (h.length === 4) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
  }

  const num = parseInt(h.slice(0, 6), 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}

/**
 * Parse RGB string to OKLCH
 */
function rgbToOklch(str) {
  // Match rgb(r, g, b) or rgb(r g b) or rgba(r, g, b, a)
  const match = str.match(/rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/)
  if (!match) {
    throw new Error(`Invalid rgb format: ${str}`)
  }

  const r = parseFloat(match[1])
  const g = parseFloat(match[2])
  const b = parseFloat(match[3])

  return rgbValuesToOklch(r, g, b)
}

/**
 * Parse HSL string to OKLCH
 */
function hslToOklch(str) {
  // Match hsl(h, s%, l%) or hsl(h s% l%) or hsla(h, s%, l%, a)
  const match = str.match(/hsla?\(\s*([0-9.]+)(deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%/)
  if (!match) {
    throw new Error(`Invalid hsl format: ${str}`)
  }

  const h = parseFloat(match[1])
  const s = parseFloat(match[3]) / 100
  const l = parseFloat(match[4]) / 100

  // Convert HSL to RGB first
  const rgb = hslToRgb(h, s, l)
  return rgbValuesToOklch(rgb.r * 255, rgb.g * 255, rgb.b * 255)
}

/**
 * Convert HSL to RGB (values 0-1)
 */
function hslToRgb(h, s, l) {
  const hue = h / 360
  let r, g, b

  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hueToRgb(p, q, hue + 1 / 3)
    g = hueToRgb(p, q, hue)
    b = hueToRgb(p, q, hue - 1 / 3)
  }

  return { r, g, b }
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

/**
 * Convert RGB (0-255) to OKLCH
 * Uses the OKLab intermediate color space
 */
function rgbValuesToOklch(r, g, b) {
  // Normalize to 0-1 range
  r /= 255
  g /= 255
  b /= 255

  // Apply sRGB gamma correction (linearize)
  r = srgbToLinear(r)
  g = srgbToLinear(g)
  b = srgbToLinear(b)

  // Convert linear RGB to OKLab via LMS
  // Using the OKLab matrix from https://bottosson.github.io/posts/oklab/
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l = Math.cbrt(l_)
  const m = Math.cbrt(m_)
  const s = Math.cbrt(s_)

  // OKLab coordinates
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const bLab = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s

  // Convert OKLab to OKLCH
  const C = Math.sqrt(a * a + bLab * bLab)
  let H = Math.atan2(bLab, a) * (180 / Math.PI)
  if (H < 0) H += 360

  return { l: L, c: C, h: H }
}

/**
 * Convert sRGB component to linear RGB
 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Convert linear RGB component to sRGB
 */
function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * Convert OKLCH to RGB (0-255)
 */
function oklchToRgb(l, c, h) {
  // Convert OKLCH to OKLab
  const hRad = h * (Math.PI / 180)
  const a = c * Math.cos(hRad)
  const bLab = c * Math.sin(hRad)

  // Convert OKLab to linear RGB via LMS
  const l_ = l + 0.3963377774 * a + 0.2158037573 * bLab
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bLab
  const s_ = l - 0.0894841775 * a - 1.2914855480 * bLab

  const lCubed = l_ * l_ * l_
  const mCubed = m_ * m_ * m_
  const sCubed = s_ * s_ * s_

  // Linear RGB
  let r = +4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed
  let g = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed
  let b = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.7076147010 * sCubed

  // Apply sRGB gamma and clamp
  r = Math.round(Math.max(0, Math.min(1, linearToSrgb(r))) * 255)
  g = Math.round(Math.max(0, Math.min(1, linearToSrgb(g))) * 255)
  b = Math.round(Math.max(0, Math.min(1, linearToSrgb(b))) * 255)

  return { r, g, b }
}

/**
 * Check if RGB values are within sRGB gamut
 */
function inGamut(r, g, b) {
  return r >= -0.5 && r <= 255.5 && g >= -0.5 && g <= 255.5 && b >= -0.5 && b <= 255.5
}

/**
 * Find maximum chroma that fits within sRGB gamut using binary search
 *
 * @param {number} l - Lightness
 * @param {number} h - Hue
 * @param {number} idealC - Desired chroma (upper bound)
 * @returns {number} Maximum valid chroma
 */
function findMaxChroma(l, h, idealC) {
  let minC = 0
  let maxC = idealC
  let bestC = 0

  // Binary search with 8 iterations for precision
  for (let i = 0; i < 8; i++) {
    const midC = (minC + maxC) / 2
    const rgb = oklchToRgb(l, midC, h)
    if (inGamut(rgb.r, rgb.g, rgb.b)) {
      bestC = midC
      minC = midC
    } else {
      maxC = midC
    }
  }

  return bestC
}

/**
 * Quadratic Bézier interpolation for smooth chroma curves
 *
 * @param {number} a - Start value
 * @param {number} control - Control point
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
function quadBezier(a, control, b, t) {
  const mt = 1 - t
  return mt * mt * a + 2 * mt * t * control + t * t * b
}

/**
 * Linear interpolation
 */
function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Normalize hue to 0-360 range
 */
function normalizeHue(h) {
  h = h % 360
  return h < 0 ? h + 360 : h
}

/**
 * Check if a color is warm (reds, oranges, yellows)
 *
 * @param {number} h - Hue angle (0-360)
 * @returns {boolean} True if warm
 */
function isWarmColor(h) {
  return (h >= 0 && h < 120) || h > 300
}

/**
 * Format OKLCH values as CSS string
 *
 * @param {number} l - Lightness (0-1)
 * @param {number} c - Chroma
 * @param {number} h - Hue (0-360)
 * @returns {string} CSS oklch() string
 */
export function formatOklch(l, c, h) {
  // Round to reasonable precision
  const lStr = (l * 100).toFixed(1)
  const cStr = c.toFixed(4)
  const hStr = h.toFixed(1)
  return `oklch(${lStr}% ${cStr} ${hStr})`
}

/**
 * Format RGB values as hex string
 *
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} Hex color string
 */
export function formatHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Generate color shades from a base color
 *
 * @param {string} color - Base color in any supported format
 * @param {Object} options - Options
 * @param {string} [options.format='oklch'] - Output format: 'oklch' or 'hex'
 * @param {string} [options.mode='fixed'] - Generation mode: 'fixed', 'natural', or 'vivid'
 * @param {boolean} [options.exactMatch=false] - If true, shade 500 will be the exact input color
 * @returns {Object} Object with shade levels as keys (50-950) and color values
 *
 * @example
 * // Default fixed mode (predictable, constant hue)
 * generateShades('#3b82f6')
 *
 * @example
 * // Natural mode (temperature-aware hue shifts)
 * generateShades('#3b82f6', { mode: 'natural' })
 *
 * @example
 * // Vivid mode (higher saturation)
 * generateShades('#3b82f6', { mode: 'vivid', exactMatch: true })
 */
export function generateShades(color, options = {}) {
  const { format = 'oklch', mode = 'fixed', exactMatch = false } = options
  const base = parseColor(color)
  const config = MODE_CONFIG[mode] || MODE_CONFIG.fixed

  // For fixed mode, use the original simple algorithm
  if (mode === 'fixed') {
    return generateFixedShades(base, color, format, exactMatch)
  }

  // For natural/vivid modes, use enhanced algorithm
  return generateEnhancedShades(base, color, format, config, exactMatch)
}

/**
 * Original fixed-lightness algorithm (default)
 */
function generateFixedShades(base, originalColor, format, exactMatch) {
  const shades = {}

  for (const level of SHADE_LEVELS) {
    // Handle exact match at 500
    if (exactMatch && level === 500) {
      if (format === 'hex') {
        shades[level] = originalColor.startsWith('#') ? originalColor : formatHexFromOklch(base)
      } else {
        shades[level] = formatOklch(base.l, base.c, base.h)
      }
      continue
    }

    const targetL = LIGHTNESS_MAP[level]
    const chromaScale = CHROMA_SCALE[level]
    const targetC = base.c * chromaScale

    // Use gamut mapping to find valid chroma
    const safeC = findMaxChroma(targetL, base.h, targetC)

    if (format === 'hex') {
      const rgb = oklchToRgb(targetL, safeC, base.h)
      shades[level] = formatHex(rgb.r, rgb.g, rgb.b)
    } else {
      shades[level] = formatOklch(targetL, safeC, base.h)
    }
  }

  return shades
}

/**
 * Enhanced algorithm with hue shifting and curved chroma (natural/vivid modes)
 */
function generateEnhancedShades(base, originalColor, format, config, exactMatch) {
  const shades = {}
  const isWarm = isWarmColor(base.h)

  // Calculate hue shift direction based on color temperature
  const hueShiftLight = isWarm ? config.hueShift.light : -config.hueShift.light
  const hueShiftDark = isWarm ? config.hueShift.dark : -config.hueShift.dark

  // Define endpoints
  const lightEnd = {
    l: LIGHTNESS_MAP[50],
    c: base.c * config.lightEndChroma,
    h: normalizeHue(base.h + hueShiftLight),
  }

  const darkEnd = {
    l: LIGHTNESS_MAP[950],
    c: base.c * config.darkEndChroma,
    h: normalizeHue(base.h + hueShiftDark),
  }

  // Control point for chroma curve (peaks at middle)
  const peakChroma = base.c * config.chromaBoost

  for (let i = 0; i < SHADE_LEVELS.length; i++) {
    const level = SHADE_LEVELS[i]

    // Handle exact match at 500 (index 5)
    if (exactMatch && level === 500) {
      if (format === 'hex') {
        shades[level] = originalColor.startsWith('#') ? originalColor : formatHexFromOklch(base)
      } else {
        shades[level] = formatOklch(base.l, base.c, base.h)
      }
      continue
    }

    let targetL, targetC, targetH

    // Split the curve at the base color (index 5 = shade 500)
    if (i <= 5) {
      // Light half: interpolate from lightEnd to base
      const t = i / 5
      targetL = lerp(lightEnd.l, base.l, t)
      targetH = lerp(lightEnd.h, base.h, t)

      // Bézier curve for chroma with peak at middle
      const controlC = (lightEnd.c + peakChroma) / 2
      targetC = quadBezier(lightEnd.c, controlC, peakChroma, t)
    } else {
      // Dark half: interpolate from base to darkEnd
      const t = (i - 5) / 5
      targetL = lerp(base.l, darkEnd.l, t)
      targetH = lerp(base.h, darkEnd.h, t)

      // Bézier curve for chroma, descending from peak
      const controlC = (peakChroma + darkEnd.c) / 2
      targetC = quadBezier(peakChroma, controlC, darkEnd.c, t)
    }

    // Normalize hue
    targetH = normalizeHue(targetH)

    // Gamut map to find maximum valid chroma
    const safeC = findMaxChroma(targetL, targetH, targetC)

    if (format === 'hex') {
      const rgb = oklchToRgb(targetL, safeC, targetH)
      shades[level] = formatHex(rgb.r, rgb.g, rgb.b)
    } else {
      shades[level] = formatOklch(targetL, safeC, targetH)
    }
  }

  return shades
}

/**
 * Helper to format OKLCH as hex
 */
function formatHexFromOklch(oklch) {
  const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h)
  return formatHex(rgb.r, rgb.g, rgb.b)
}

/**
 * Generate shades for multiple colors
 *
 * @param {Object} colors - Object with color names as keys and color values or config objects
 * @param {Object} options - Default options passed to generateShades
 * @returns {Object} Object with color names, each containing shade levels
 *
 * @example
 * // Simple usage with defaults
 * generatePalettes({
 *   primary: '#3b82f6',
 *   secondary: '#64748b'
 * })
 *
 * @example
 * // With per-color options
 * generatePalettes({
 *   primary: { base: '#3b82f6', mode: 'vivid', exactMatch: true },
 *   secondary: '#64748b',  // Uses defaults
 *   neutral: { base: '#737373', mode: 'fixed' }
 * })
 */
export function generatePalettes(colors, options = {}) {
  const palettes = {}

  for (const [name, colorConfig] of Object.entries(colors)) {
    // Pre-defined shades (object with numeric keys)
    if (typeof colorConfig === 'object' && colorConfig !== null && !colorConfig.base) {
      // Check if it's a shades object (has numeric keys like 50, 100, etc)
      const keys = Object.keys(colorConfig)
      if (keys.some(k => !isNaN(parseInt(k)))) {
        palettes[name] = colorConfig
        continue
      }
    }

    // Color config object with base and options
    if (typeof colorConfig === 'object' && colorConfig !== null && colorConfig.base) {
      const { base, ...colorOptions } = colorConfig
      palettes[name] = generateShades(base, { ...options, ...colorOptions })
    }
    // Simple color string
    else if (typeof colorConfig === 'string') {
      palettes[name] = generateShades(colorConfig, options)
    }
  }

  return palettes
}

/**
 * Get available generation modes
 * @returns {string[]} Array of mode names
 */
export function getAvailableModes() {
  return Object.keys(MODE_CONFIG)
}

/**
 * Check if a color string is valid
 *
 * @param {string} color - Color string to validate
 * @returns {boolean} True if color can be parsed
 */
export function isValidColor(color) {
  try {
    parseColor(color)
    return true
  } catch {
    return false
  }
}

/**
 * Get the shade levels used for generation
 * @returns {number[]} Array of shade levels
 */
export function getShadeLevels() {
  return [...SHADE_LEVELS]
}

export default {
  parseColor,
  formatOklch,
  formatHex,
  generateShades,
  generatePalettes,
  isValidColor,
  getShadeLevels,
  getAvailableModes,
}
