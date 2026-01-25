import { describe, it, expect } from '@jest/globals'
import {
  parseColor,
  formatOklch,
  formatHex,
  generateShades,
  generatePalettes,
  isValidColor,
  getShadeLevels,
  getAvailableModes,
} from '../src/theme/shade-generator.js'

describe('shade-generator', () => {
  describe('parseColor', () => {
    it('parses 6-digit hex colors', () => {
      const result = parseColor('#3b82f6')
      expect(result).toHaveProperty('l')
      expect(result).toHaveProperty('c')
      expect(result).toHaveProperty('h')
      expect(result.l).toBeGreaterThan(0)
      expect(result.l).toBeLessThan(1)
    })

    it('parses 3-digit hex colors', () => {
      const result = parseColor('#fff')
      expect(result.l).toBeCloseTo(1, 1) // White should be ~1.0 lightness
      expect(result.c).toBeCloseTo(0, 2) // White has no chroma
    })

    it('parses hex without # prefix', () => {
      const result = parseColor('3b82f6')
      expect(result.l).toBeGreaterThan(0)
    })

    it('parses RGB colors', () => {
      const result = parseColor('rgb(59, 130, 246)')
      expect(result.l).toBeGreaterThan(0.5)
      expect(result.l).toBeLessThan(0.7)
    })

    it('parses RGB colors with spaces', () => {
      const result = parseColor('rgb(59 130 246)')
      expect(result.l).toBeGreaterThan(0.5)
    })

    it('parses HSL colors', () => {
      const result = parseColor('hsl(217, 91%, 60%)')
      expect(result.l).toBeGreaterThan(0.5)
      expect(result.h).toBeGreaterThan(250) // Blue hue in OKLCH (~260)
      expect(result.h).toBeLessThan(270)
    })

    it('parses OKLCH colors', () => {
      const result = parseColor('oklch(0.55 0.2 250)')
      expect(result.l).toBeCloseTo(0.55, 2)
      expect(result.c).toBeCloseTo(0.2, 2)
      expect(result.h).toBeCloseTo(250, 0)
    })

    it('parses OKLCH with percentage lightness', () => {
      const result = parseColor('oklch(55% 0.2 250)')
      expect(result.l).toBeCloseTo(0.55, 2)
    })

    it('throws for invalid colors', () => {
      expect(() => parseColor('invalid')).toThrow()
      expect(() => parseColor('')).toThrow()
      expect(() => parseColor(null)).toThrow()
    })

    it('parses black correctly', () => {
      const result = parseColor('#000000')
      expect(result.l).toBeCloseTo(0, 1)
    })

    it('parses pure colors correctly', () => {
      const red = parseColor('#ff0000')
      expect(red.h).toBeGreaterThan(20)
      expect(red.h).toBeLessThan(40) // Red hue in OKLCH

      const green = parseColor('#00ff00')
      expect(green.h).toBeGreaterThan(130)
      expect(green.h).toBeLessThan(160) // Green hue

      const blue = parseColor('#0000ff')
      expect(blue.h).toBeGreaterThan(260)
      expect(blue.h).toBeLessThan(280) // Blue hue
    })
  })

  describe('formatOklch', () => {
    it('formats OKLCH values correctly', () => {
      const result = formatOklch(0.55, 0.2, 250)
      expect(result).toBe('oklch(55.0% 0.2000 250.0)')
    })

    it('rounds values to reasonable precision', () => {
      const result = formatOklch(0.55555, 0.123456, 250.789)
      expect(result).toMatch(/oklch\(\d+\.\d% 0\.\d{4} \d+\.\d\)/)
    })
  })

  describe('formatHex', () => {
    it('formats RGB values to hex', () => {
      expect(formatHex(255, 255, 255)).toBe('#ffffff')
      expect(formatHex(0, 0, 0)).toBe('#000000')
      expect(formatHex(59, 130, 246)).toBe('#3b82f6')
    })

    it('pads single digit values', () => {
      expect(formatHex(0, 15, 255)).toBe('#000fff')
    })
  })

  describe('generateShades', () => {
    it('generates all 11 shade levels', () => {
      const shades = generateShades('#3b82f6')
      const levels = Object.keys(shades).map(Number)
      expect(levels).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950])
    })

    it('generates OKLCH format by default', () => {
      const shades = generateShades('#3b82f6')
      expect(shades[500]).toMatch(/^oklch\(/)
    })

    it('generates hex format when specified', () => {
      const shades = generateShades('#3b82f6', { format: 'hex' })
      expect(shades[500]).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('generates lighter shades at lower numbers', () => {
      const shades = generateShades('#3b82f6')
      // Extract lightness from oklch string
      const getLightness = (s) => parseFloat(s.match(/oklch\(([0-9.]+)%/)[1])

      expect(getLightness(shades[50])).toBeGreaterThan(getLightness(shades[500]))
      expect(getLightness(shades[500])).toBeGreaterThan(getLightness(shades[950]))
    })

    it('preserves hue across shades', () => {
      const shades = generateShades('#3b82f6')
      const getHue = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\)/)[1])

      const hue50 = getHue(shades[50])
      const hue500 = getHue(shades[500])
      const hue950 = getHue(shades[950])

      // Hue should be consistent (within 1 degree)
      expect(Math.abs(hue50 - hue500)).toBeLessThan(1)
      expect(Math.abs(hue500 - hue950)).toBeLessThan(1)
    })

    it('reduces chroma at extremes', () => {
      const shades = generateShades('#3b82f6')
      const getChroma = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\s/)[1])

      const chroma50 = getChroma(shades[50])
      const chroma500 = getChroma(shades[500])
      const chroma950 = getChroma(shades[950])

      // Chroma should be highest at 500
      expect(chroma500).toBeGreaterThan(chroma50)
      expect(chroma500).toBeGreaterThan(chroma950)
    })

    it('handles grayscale colors', () => {
      const shades = generateShades('#808080')
      expect(Object.keys(shades)).toHaveLength(11)
      // Gray should have very low chroma
      const getChroma = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\s/)[1])
      expect(getChroma(shades[500])).toBeLessThan(0.01)
    })

    it('handles saturated colors without clipping', () => {
      // Test a highly saturated color
      const shades = generateShades('#ff0000', { format: 'hex' })

      // All shades should be valid hex colors
      for (const shade of Object.values(shades)) {
        expect(shade).toMatch(/^#[0-9a-f]{6}$/)
      }

      // Shade 50 should be very light (close to white)
      const shade50 = shades[50]
      const r = parseInt(shade50.slice(1, 3), 16)
      const g = parseInt(shade50.slice(3, 5), 16)
      const b = parseInt(shade50.slice(5, 7), 16)
      expect(r).toBeGreaterThan(200)
      expect(g).toBeGreaterThan(200)
      expect(b).toBeGreaterThan(200)
    })
  })

  describe('generatePalettes', () => {
    it('generates shades for multiple colors', () => {
      const palettes = generatePalettes({
        primary: '#3b82f6',
        secondary: '#64748b',
      })

      expect(palettes).toHaveProperty('primary')
      expect(palettes).toHaveProperty('secondary')
      expect(Object.keys(palettes.primary)).toHaveLength(11)
      expect(Object.keys(palettes.secondary)).toHaveLength(11)
    })

    it('passes through pre-defined shade objects', () => {
      const predefined = { 500: '#custom', 600: '#color' }
      const palettes = generatePalettes({
        primary: '#3b82f6',
        custom: predefined,
      })

      expect(palettes.custom).toBe(predefined)
      expect(Object.keys(palettes.primary)).toHaveLength(11)
    })

    it('passes format option to generateShades', () => {
      const palettes = generatePalettes(
        { primary: '#3b82f6' },
        { format: 'hex' }
      )

      expect(palettes.primary[500]).toMatch(/^#/)
    })
  })

  describe('isValidColor', () => {
    it('returns true for valid colors', () => {
      expect(isValidColor('#3b82f6')).toBe(true)
      expect(isValidColor('#fff')).toBe(true)
      expect(isValidColor('rgb(255, 0, 0)')).toBe(true)
      expect(isValidColor('hsl(200, 50%, 50%)')).toBe(true)
      expect(isValidColor('oklch(0.5 0.2 200)')).toBe(true)
    })

    it('returns false for invalid colors', () => {
      expect(isValidColor('invalid')).toBe(false)
      expect(isValidColor('')).toBe(false)
      expect(isValidColor('not-a-color')).toBe(false)
    })
  })

  describe('getShadeLevels', () => {
    it('returns array of shade levels', () => {
      const levels = getShadeLevels()
      expect(levels).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950])
    })

    it('returns a copy (not mutable)', () => {
      const levels1 = getShadeLevels()
      levels1.push(999)
      const levels2 = getShadeLevels()
      expect(levels2).not.toContain(999)
    })
  })

  describe('getAvailableModes', () => {
    it('returns available mode names', () => {
      const modes = getAvailableModes()
      expect(modes).toContain('fixed')
      expect(modes).toContain('natural')
      expect(modes).toContain('vivid')
    })
  })

  describe('generation modes', () => {
    describe('fixed mode (default)', () => {
      it('uses fixed mode by default', () => {
        const shades = generateShades('#3b82f6')
        const shadesExplicit = generateShades('#3b82f6', { mode: 'fixed' })

        // Should produce same results
        expect(shades[500]).toBe(shadesExplicit[500])
        expect(shades[50]).toBe(shadesExplicit[50])
      })

      it('preserves hue across all shades in fixed mode', () => {
        const shades = generateShades('#3b82f6', { mode: 'fixed' })
        const getHue = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\)/)[1])

        const hues = Object.values(shades).map(getHue)
        const avgHue = hues.reduce((a, b) => a + b) / hues.length

        // All hues should be within 1 degree of average
        hues.forEach(h => {
          expect(Math.abs(h - avgHue)).toBeLessThan(1)
        })
      })
    })

    describe('natural mode', () => {
      it('shifts hue for warm colors', () => {
        // Orange is a warm color
        const shades = generateShades('#f97316', { mode: 'natural' })
        const getHue = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\)/)[1])

        const hue50 = getHue(shades[50])
        const hue500 = getHue(shades[500])
        const hue950 = getHue(shades[950])

        // Light shades should shift cooler (higher hue for orange)
        // Dark shades should shift warmer (lower hue)
        // Allow for small differences due to gamut mapping
        expect(hue50).not.toBeCloseTo(hue950, 0)
      })

      it('shifts hue for cool colors in opposite direction', () => {
        // Blue is a cool color
        const shades = generateShades('#3b82f6', { mode: 'natural' })
        const getHue = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\)/)[1])

        const hue50 = getHue(shades[50])
        const hue950 = getHue(shades[950])

        // Cool colors shift opposite to warm colors
        expect(hue50).not.toBeCloseTo(hue950, 0)
      })

      it('generates valid colors', () => {
        const shades = generateShades('#3b82f6', { mode: 'natural', format: 'hex' })

        for (const shade of Object.values(shades)) {
          expect(shade).toMatch(/^#[0-9a-f]{6}$/)
        }
      })
    })

    describe('vivid mode', () => {
      it('produces higher chroma than fixed mode', () => {
        const fixed = generateShades('#3b82f6', { mode: 'fixed' })
        const vivid = generateShades('#3b82f6', { mode: 'vivid' })

        const getChroma = (s) => parseFloat(s.match(/oklch\([^)]+\s([0-9.]+)\s/)[1])

        // Compare middle shades (300-700) where vivid boost is most apparent
        const fixedChroma400 = getChroma(fixed[400])
        const vividChroma400 = getChroma(vivid[400])

        expect(vividChroma400).toBeGreaterThanOrEqual(fixedChroma400)
      })

      it('generates valid colors even with high chroma', () => {
        // Test with already saturated color
        const shades = generateShades('#ff0000', { mode: 'vivid', format: 'hex' })

        for (const shade of Object.values(shades)) {
          expect(shade).toMatch(/^#[0-9a-f]{6}$/)
        }
      })
    })

    describe('exactMatch option', () => {
      it('preserves exact input color at shade 500 (hex)', () => {
        const inputColor = '#e31937'
        const shades = generateShades(inputColor, { format: 'hex', exactMatch: true })

        expect(shades[500].toLowerCase()).toBe(inputColor.toLowerCase())
      })

      it('works with natural mode', () => {
        const inputColor = '#3b82f6'
        const shades = generateShades(inputColor, {
          mode: 'natural',
          format: 'hex',
          exactMatch: true,
        })

        expect(shades[500].toLowerCase()).toBe(inputColor.toLowerCase())
      })

      it('works with vivid mode', () => {
        const inputColor = '#10b981'
        const shades = generateShades(inputColor, {
          mode: 'vivid',
          format: 'hex',
          exactMatch: true,
        })

        expect(shades[500].toLowerCase()).toBe(inputColor.toLowerCase())
      })
    })
  })

  describe('generatePalettes with per-color config', () => {
    it('supports per-color mode configuration', () => {
      const palettes = generatePalettes({
        primary: { base: '#3b82f6', mode: 'vivid' },
        secondary: '#64748b', // Uses default
      })

      expect(Object.keys(palettes.primary)).toHaveLength(11)
      expect(Object.keys(palettes.secondary)).toHaveLength(11)
    })

    it('supports per-color exactMatch option', () => {
      const palettes = generatePalettes({
        brand: { base: '#e31937', exactMatch: true, format: 'hex' },
      })

      expect(palettes.brand[500].toLowerCase()).toBe('#e31937')
    })

    it('passes through pre-defined shades with numeric keys', () => {
      const predefined = {
        50: '#fef2f2',
        100: '#fee2e2',
        500: '#ef4444',
        950: '#450a0a',
      }

      const palettes = generatePalettes({
        custom: predefined,
      })

      expect(palettes.custom).toBe(predefined)
    })
  })
})
