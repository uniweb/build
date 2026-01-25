/**
 * OKLCH Shade Generator
 *
 * Generates 11 color shades (50-950) from a single base color using
 * the OKLCH color space for perceptually uniform results.
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
 * @returns {Object} Object with shade levels as keys (50-950) and color values
 */
export function generateShades(color, options = {}) {
  const { format = 'oklch' } = options
  const { l, c, h } = parseColor(color)

  const shades = {}

  for (const level of SHADE_LEVELS) {
    const targetL = LIGHTNESS_MAP[level]
    const chromaScale = CHROMA_SCALE[level]

    // Scale chroma based on lightness to prevent clipping
    // Also consider the original chroma - low chroma colors stay low
    const targetC = c * chromaScale

    if (format === 'hex') {
      const rgb = oklchToRgb(targetL, targetC, h)
      shades[level] = formatHex(rgb.r, rgb.g, rgb.b)
    } else {
      shades[level] = formatOklch(targetL, targetC, h)
    }
  }

  return shades
}

/**
 * Generate shades for multiple colors
 *
 * @param {Object} colors - Object with color names as keys and color values
 * @param {Object} options - Options passed to generateShades
 * @returns {Object} Object with color names, each containing shade levels
 *
 * @example
 * generatePalettes({
 *   primary: '#3b82f6',
 *   secondary: '#64748b'
 * })
 * // Returns: { primary: { 50: '...', 100: '...', ... }, secondary: { ... } }
 */
export function generatePalettes(colors, options = {}) {
  const palettes = {}

  for (const [name, color] of Object.entries(colors)) {
    // Skip if color is already an object (pre-defined shades)
    if (typeof color === 'object' && color !== null) {
      palettes[name] = color
    } else {
      palettes[name] = generateShades(color, options)
    }
  }

  return palettes
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
}
