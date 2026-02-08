import { describe, it, expect } from '@jest/globals'
import { buildTheme } from '../src/theme/index.js'

describe('Theme Build Pipeline', () => {
  describe('buildTheme', () => {
    it('builds theme with default config', () => {
      const result = buildTheme({})

      expect(result).toHaveProperty('css')
      expect(result).toHaveProperty('config')
      expect(result).toHaveProperty('errors')
      expect(result).toHaveProperty('warnings')
      expect(result.errors).toHaveLength(0)
    })

    it('generates CSS with all palette shades', () => {
      const result = buildTheme({
        colors: {
          primary: '#3b82f6',
        },
      })

      // Check all shade levels are present
      const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
      for (const shade of shades) {
        expect(result.css).toContain(`--primary-${shade}:`)
      }
    })

    it('generates OKLCH color values', () => {
      const result = buildTheme({
        colors: { primary: '#3b82f6' },
      })

      expect(result.css).toContain('oklch(')
    })

    it('includes context classes in CSS', () => {
      const result = buildTheme({})

      expect(result.css).toContain('.context-light')
      expect(result.css).toContain('.context-medium')
      expect(result.css).toContain('.context-dark')
    })

    it('includes semantic tokens in contexts', () => {
      const result = buildTheme({})

      // Each context should have semantic tokens
      expect(result.css).toMatch(/\.context-light[^}]+--section:/)
      expect(result.css).toMatch(/\.context-light[^}]+--body:/)
      expect(result.css).toMatch(/\.context-dark[^}]+--section:/)
    })

    it('applies custom context token overrides', () => {
      const result = buildTheme({
        contexts: {
          light: {
            'custom-token': '#ff0000',
          },
        },
      })

      expect(result.css).toContain('--custom-token: #ff0000')
    })

    it('includes font configuration', () => {
      const result = buildTheme({
        fonts: {
          body: 'Inter, sans-serif',
          heading: 'Poppins, sans-serif',
        },
      })

      expect(result.css).toContain('--font-body: Inter, sans-serif')
      expect(result.css).toContain('--font-heading: Poppins, sans-serif')
    })

    it('includes font imports when provided', () => {
      const result = buildTheme({
        fonts: {
          import: [
            { url: 'https://fonts.googleapis.com/css2?family=Inter' },
          ],
        },
      })

      expect(result.css).toContain("@import url('https://fonts.googleapis.com/css2?family=Inter')")
    })

    it('includes foundation vars in CSS', () => {
      const result = buildTheme({}, {
        foundationVars: {
          'header-height': { type: 'length', default: '64px' },
          'sidebar-width': '280px',
        },
      })

      expect(result.css).toContain('--header-height: 64px')
      expect(result.css).toContain('--sidebar-width: 280px')
    })

    it('allows site to override foundation vars', () => {
      const result = buildTheme(
        {
          vars: {
            'header-height': '80px',
          },
        },
        {
          foundationVars: {
            'header-height': { type: 'length', default: '64px' },
          },
        }
      )

      expect(result.css).toContain('--header-height: 80px')
      expect(result.css).not.toContain('--header-height: 64px')
    })

    it('includes dark scheme CSS when toggle enabled', () => {
      const result = buildTheme({
        appearance: {
          allowToggle: true,
        },
      })

      expect(result.css).toContain('.scheme-dark')
    })

    it('does not include dark scheme CSS by default', () => {
      const result = buildTheme({})

      expect(result.css).not.toContain('.scheme-dark')
    })

    it('returns processed config object', () => {
      const result = buildTheme({
        colors: { primary: '#ff0000' },
      })

      expect(result.config).toHaveProperty('colors')
      expect(result.config.colors.primary).toBe('#ff0000')
      expect(result.config).toHaveProperty('contexts')
      expect(result.config).toHaveProperty('fonts')
      expect(result.config).toHaveProperty('appearance')
    })

    it('generates warnings for missing primary color', () => {
      const result = buildTheme({})

      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings.some(w => w.includes('primary'))).toBe(true)
    })

    it('generates errors for invalid colors', () => {
      const result = buildTheme({
        colors: {
          invalid: 'not-a-color',
        },
      })

      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('handles pre-defined shade objects', () => {
      const result = buildTheme({
        colors: {
          custom: {
            50: '#fef2f2',
            500: '#ef4444',
            950: '#450a0a',
          },
        },
      })

      expect(result.css).toContain('--custom-50: #fef2f2')
      expect(result.css).toContain('--custom-500: #ef4444')
      expect(result.css).toContain('--custom-950: #450a0a')
    })
  })

  describe('CSS Output Quality', () => {
    it('generates valid CSS syntax (balanced braces)', () => {
      const result = buildTheme({
        colors: { primary: '#3b82f6', secondary: '#64748b' },
        contexts: { light: { custom: 'value' } },
        fonts: { body: 'Inter' },
      })

      const openBraces = (result.css.match(/{/g) || []).length
      const closeBraces = (result.css.match(/}/g) || []).length
      expect(openBraces).toBe(closeBraces)
    })

    it('does not contain undefined or NaN values', () => {
      const result = buildTheme({
        colors: { primary: '#3b82f6' },
      })

      expect(result.css).not.toContain('undefined')
      expect(result.css).not.toContain('NaN')
    })

    it('includes section comments for readability', () => {
      const result = buildTheme({})

      expect(result.css).toContain('/* Color Palettes */')
      expect(result.css).toContain('/* Color Contexts */')
    })

    it('has properly formatted :root blocks', () => {
      const result = buildTheme({})

      expect(result.css).toMatch(/:root\s*\{/)
    })
  })

  describe('Full Integration', () => {
    it('processes complete theme configuration', () => {
      const themeConfig = {
        colors: {
          primary: '#3b82f6',
          secondary: '#64748b',
          accent: '#8b5cf6',
          neutral: '#737373',
        },
        contexts: {
          light: {
            section: 'white',
            body: 'var(--neutral-900)',
          },
          medium: {
            section: 'var(--neutral-100)',
          },
          dark: {
            section: 'var(--neutral-900)',
            body: 'white',
          },
        },
        fonts: {
          body: 'Inter, sans-serif',
          heading: 'Poppins, sans-serif',
          mono: 'Fira Code, monospace',
          import: [
            { url: 'https://fonts.googleapis.com/css2?family=Inter' },
            { url: 'https://fonts.googleapis.com/css2?family=Poppins' },
          ],
        },
        appearance: {
          default: 'light',
          allowToggle: true,
          respectSystemPreference: true,
          schemes: ['light', 'dark'],
        },
      }

      const foundationVars = {
        'header-height': { default: '4rem', description: 'Header height' },
        'max-content-width': { default: '80rem' },
      }

      const result = buildTheme(themeConfig, { foundationVars })

      // Verify all colors generated
      expect(result.css).toContain('--primary-500:')
      expect(result.css).toContain('--secondary-500:')
      expect(result.css).toContain('--accent-500:')
      expect(result.css).toContain('--neutral-500:')

      // Verify contexts
      expect(result.css).toContain('.context-light')
      expect(result.css).toContain('.context-medium')
      expect(result.css).toContain('.context-dark')

      // Verify fonts
      expect(result.css).toContain('--font-body: Inter, sans-serif')
      expect(result.css).toContain('--font-heading: Poppins, sans-serif')
      expect(result.css).toContain("@import url('https://fonts.googleapis.com")

      // Verify foundation vars
      expect(result.css).toContain('--header-height: 4rem')
      expect(result.css).toContain('--max-content-width: 80rem')

      // Verify dark scheme support
      expect(result.css).toContain('.scheme-dark')

      // No errors
      expect(result.errors).toHaveLength(0)
    })

    it('handles minimal theme configuration', () => {
      const result = buildTheme({
        colors: {
          primary: '#3b82f6',
        },
      })

      expect(result.errors).toHaveLength(0)
      expect(result.css).toContain('--primary-500:')
      // Should still have defaults for other required items
      expect(result.css).toContain('.context-light')
    })

    it('handles empty theme configuration', () => {
      const result = buildTheme()

      expect(result.errors).toHaveLength(0)
      expect(result.css.length).toBeGreaterThan(0)
      // Should have all default content
      expect(result.css).toContain(':root')
      expect(result.css).toContain('.context-light')
    })
  })

  describe('Status Tokens', () => {
    it('includes status tokens in generated CSS', () => {
      const result = buildTheme({})

      expect(result.css).toContain('--success:')
      expect(result.css).toContain('--success-subtle:')
      expect(result.css).toContain('--warning:')
      expect(result.css).toContain('--error:')
      expect(result.css).toContain('--info:')
      expect(result.css).toContain('--info-subtle:')
    })

    it('has different status shades for dark context', () => {
      const result = buildTheme({})

      // Dark context uses lighter shades (e.g., green-400 instead of green-600)
      expect(result.css).toMatch(/\.context-dark[^}]+--success:\s*#4ade80/)
      expect(result.css).toMatch(/\.context-light[^}]+--success:\s*#16a34a/)
    })
  })

  describe('Neutral Presets', () => {
    it('accepts named neutral presets', () => {
      const result = buildTheme({
        colors: { neutral: 'stone' },
      })

      expect(result.errors).toHaveLength(0)
      expect(result.css).toContain('--neutral-500:')
    })

    it('uses stone as default neutral', () => {
      const result = buildTheme({})

      expect(result.config.colors.neutral).toBe('#78716c')
    })
  })

  describe('Inline Defaults', () => {
    it('includes default inline styles in output', () => {
      const result = buildTheme({})

      expect(result.css).toContain('span[emphasis]')
      expect(result.css).toContain('var(--link)')
      expect(result.css).toContain('span[muted]')
      expect(result.css).toContain('var(--subtle)')
    })
  })

  describe('Appearance Settings', () => {
    it('respects system appearance when configured', () => {
      const result = buildTheme({
        appearance: 'system',
      })

      expect(result.config.appearance.default).toBe('system')
      expect(result.config.appearance.respectSystemPreference).toBe(true)
    })

    it('handles simple appearance string', () => {
      const result = buildTheme({
        appearance: 'dark',
      })

      expect(result.config.appearance.default).toBe('dark')
    })

    it('merges appearance object with defaults', () => {
      const result = buildTheme({
        appearance: {
          allowToggle: true,
        },
      })

      expect(result.config.appearance.allowToggle).toBe(true)
      expect(result.config.appearance.default).toBe('light')
    })
  })
})
