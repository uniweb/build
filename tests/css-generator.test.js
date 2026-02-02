import { describe, it, expect } from '@jest/globals'
import {
  generateThemeCSS,
  generateContextCSS,
  generatePaletteVars,
  getDefaultContextTokens,
  getDefaultColors,
} from '../src/theme/css-generator.js'
import { generatePalettes } from '../src/theme/shade-generator.js'

describe('css-generator', () => {
  describe('generateThemeCSS', () => {
    it('generates valid CSS with default config', () => {
      const css = generateThemeCSS()

      // Should include color palettes
      expect(css).toContain('--color-primary-500:')
      expect(css).toContain('--color-neutral-500:')

      // Should include semantic tokens
      expect(css).toContain('--bg:')
      expect(css).toContain('--text:')
      expect(css).toContain('--link:')

      // Should include context classes
      expect(css).toContain('.context-light')
      expect(css).toContain('.context-medium')
      expect(css).toContain('.context-dark')
    })

    it('generates all shade levels for color palettes', () => {
      const css = generateThemeCSS()
      const levels = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

      for (const level of levels) {
        expect(css).toContain(`--color-primary-${level}:`)
        expect(css).toContain(`--color-neutral-${level}:`)
      }
    })

    it('includes custom colors', () => {
      const css = generateThemeCSS({
        colors: {
          brand: '#ff5500',
          success: '#00cc00',
        },
      })

      expect(css).toContain('--color-brand-500:')
      expect(css).toContain('--color-success-500:')
    })

    it('applies context token overrides', () => {
      const css = generateThemeCSS({
        contexts: {
          light: {
            'link': 'var(--brand-600)',
          },
        },
      })

      // The light context should have custom link color
      expect(css).toMatch(/\.context-light[^}]+--link:\s*var\(--brand-600\)/)
    })

    it('includes font imports when provided', () => {
      const css = generateThemeCSS({
        fonts: {
          import: [
            { url: 'https://fonts.googleapis.com/css2?family=Inter' },
          ],
          body: 'Inter, sans-serif',
          heading: 'Inter, sans-serif',
        },
      })

      expect(css).toContain("@import url('https://fonts.googleapis.com/css2?family=Inter')")
      expect(css).toContain('--font-body: Inter, sans-serif')
      expect(css).toContain('--font-heading: Inter, sans-serif')
    })

    it('includes foundation variables when provided', () => {
      const css = generateThemeCSS({
        foundationVars: {
          'header-height': { type: 'length', default: '64px' },
          'sidebar-width': '280px',
        },
      })

      expect(css).toContain('--header-height: 64px')
      expect(css).toContain('--sidebar-width: 280px')
    })

    it('includes dark scheme CSS when enabled', () => {
      const css = generateThemeCSS({
        appearance: {
          allowToggle: true,
        },
      })

      expect(css).toContain('.scheme-dark')
      expect(css).toContain('@media (prefers-color-scheme: dark)')
    })

    it('does not include dark scheme CSS when disabled', () => {
      const css = generateThemeCSS({
        appearance: {},
      })

      expect(css).not.toContain('.scheme-dark')
      expect(css).not.toContain('prefers-color-scheme')
    })

    it('generates valid CSS syntax', () => {
      const css = generateThemeCSS()

      // Check balanced braces
      const openBraces = (css.match(/{/g) || []).length
      const closeBraces = (css.match(/}/g) || []).length
      expect(openBraces).toBe(closeBraces)

      // Check no undefined values
      expect(css).not.toContain('undefined')
      expect(css).not.toContain('NaN')
    })
  })

  describe('generateContextCSS', () => {
    it('generates light context CSS', () => {
      const css = generateContextCSS('light')

      expect(css).toContain('.context-light')
      expect(css).toContain('--bg:')
      expect(css).toContain('--text:')
      expect(css).toContain('--heading:')
      expect(css).toContain('--link:')
    })

    it('generates medium context CSS', () => {
      const css = generateContextCSS('medium')

      expect(css).toContain('.context-medium')
      expect(css).toContain('--bg:')
    })

    it('generates dark context CSS', () => {
      const css = generateContextCSS('dark')

      expect(css).toContain('.context-dark')
      expect(css).toContain('--bg:')
      // Dark context should have lighter text
      expect(css).toContain('--color-neutral-50')
    })

    it('merges custom tokens with defaults', () => {
      const css = generateContextCSS('light', {
        'custom-var': '#ff0000',
      })

      expect(css).toContain('--custom-var: #ff0000')
      // Should still have default tokens
      expect(css).toContain('--bg:')
    })

    it('overrides default tokens with custom values', () => {
      const css = generateContextCSS('light', {
        'bg': '#ffffff',
      })

      expect(css).toContain('--bg: #ffffff')
    })
  })

  describe('generatePaletteVars', () => {
    it('generates CSS variables for all shades', () => {
      const palettes = generatePalettes({
        primary: '#3b82f6',
      })
      const css = generatePaletteVars(palettes)

      expect(css).toContain('--color-primary-50:')
      expect(css).toContain('--color-primary-500:')
      expect(css).toContain('--color-primary-950:')
    })

    it('handles multiple palettes', () => {
      const palettes = generatePalettes({
        primary: '#3b82f6',
        secondary: '#64748b',
      })
      const css = generatePaletteVars(palettes)

      expect(css).toContain('--color-primary-500:')
      expect(css).toContain('--color-secondary-500:')
    })

    it('generates oklch values', () => {
      const palettes = generatePalettes({
        primary: '#3b82f6',
      })
      const css = generatePaletteVars(palettes)

      expect(css).toContain('oklch(')
    })
  })

  describe('getDefaultContextTokens', () => {
    it('returns all three contexts', () => {
      const tokens = getDefaultContextTokens()

      expect(tokens).toHaveProperty('light')
      expect(tokens).toHaveProperty('medium')
      expect(tokens).toHaveProperty('dark')
    })

    it('returns complete token sets', () => {
      const tokens = getDefaultContextTokens()

      const requiredTokens = ['bg', 'text', 'heading', 'link', 'border']
      for (const token of requiredTokens) {
        expect(tokens.light).toHaveProperty(token)
        expect(tokens.medium).toHaveProperty(token)
        expect(tokens.dark).toHaveProperty(token)
      }
    })

    it('returns a copy (not mutable)', () => {
      const tokens1 = getDefaultContextTokens()
      tokens1.light.custom = 'value'
      const tokens2 = getDefaultContextTokens()
      expect(tokens2.light).not.toHaveProperty('custom')
    })
  })

  describe('getDefaultColors', () => {
    it('returns default color palette', () => {
      const colors = getDefaultColors()

      expect(colors).toHaveProperty('primary')
      expect(colors).toHaveProperty('secondary')
      expect(colors).toHaveProperty('accent')
      expect(colors).toHaveProperty('neutral')
    })

    it('returns hex color values', () => {
      const colors = getDefaultColors()

      expect(colors.primary).toMatch(/^#[0-9a-f]{6}$/i)
    })
  })

  describe('CSS output format', () => {
    it('includes section comments', () => {
      const css = generateThemeCSS()

      expect(css).toContain('/* Color Palettes */')
      expect(css).toContain('/* Default Semantic Tokens */')
      expect(css).toContain('/* Color Contexts */')
    })

    it('properly formats :root declarations', () => {
      const css = generateThemeCSS()

      // Should have :root blocks
      expect(css).toMatch(/:root\s*\{/)
    })

    it('properly indents variable declarations', () => {
      const css = generateThemeCSS()

      // Variables should be indented with 2 spaces
      expect(css).toMatch(/\n  --\w/)
    })
  })
})
