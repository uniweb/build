import { describe, it, expect } from '@jest/globals'
import {
  validateThemeConfig,
  processTheme,
  extractFoundationVars,
  foundationHasVars,
} from '../src/theme/processor.js'

describe('theme-processor', () => {
  describe('validateThemeConfig', () => {
    it('accepts empty config', () => {
      const result = validateThemeConfig({})
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('accepts null/undefined config', () => {
      expect(validateThemeConfig(null).valid).toBe(true)
      expect(validateThemeConfig(undefined).valid).toBe(true)
    })

    it('validates color format', () => {
      const result = validateThemeConfig({
        colors: {
          primary: '#3b82f6',
          invalid: 'not-a-color',
        },
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('invalid'))
    })

    it('accepts valid hex colors', () => {
      const result = validateThemeConfig({
        colors: {
          primary: '#3b82f6',
          secondary: '#fff',
          accent: 'ff5500',
        },
      })

      expect(result.valid).toBe(true)
    })

    it('accepts pre-defined shade objects', () => {
      const result = validateThemeConfig({
        colors: {
          custom: {
            50: '#fef2f2',
            500: '#ef4444',
            950: '#450a0a',
          },
        },
      })

      expect(result.valid).toBe(true)
    })

    it('validates context names', () => {
      const result = validateThemeConfig({
        contexts: {
          light: {},
          invalid: {},
        },
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('invalid'))
    })

    it('accepts valid context configs', () => {
      const result = validateThemeConfig({
        contexts: {
          light: { section: 'white' },
          medium: { section: '#f5f5f5' },
          dark: { section: 'black' },
        },
      })

      expect(result.valid).toBe(true)
    })

    it('validates font imports structure', () => {
      const result = validateThemeConfig({
        fonts: {
          import: 'not-an-array',
        },
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('array'))
    })

    it('validates font import items', () => {
      const result = validateThemeConfig({
        fonts: {
          import: [
            { url: 'https://fonts.example.com' },
            { invalid: true }, // Missing url
          ],
        },
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('url'))
    })

    it('validates appearance values', () => {
      const result = validateThemeConfig({
        appearance: 'invalid-value',
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(expect.stringContaining('invalid'))
    })

    it('accepts valid appearance string', () => {
      expect(validateThemeConfig({ appearance: 'light' }).valid).toBe(true)
      expect(validateThemeConfig({ appearance: 'dark' }).valid).toBe(true)
      expect(validateThemeConfig({ appearance: 'system' }).valid).toBe(true)
    })

    it('accepts valid appearance object', () => {
      const result = validateThemeConfig({
        appearance: {
          default: 'light',
          allowToggle: true,
          schemes: ['light', 'dark'],
        },
      })

      expect(result.valid).toBe(true)
    })
  })

  describe('processTheme', () => {
    it('returns default config when given empty input', () => {
      const { config, errors, warnings } = processTheme({})

      expect(errors).toHaveLength(0)
      expect(config.colors).toHaveProperty('primary')
      expect(config.colors).toHaveProperty('neutral')
      expect(config.contexts).toHaveProperty('light')
      expect(config.contexts).toHaveProperty('medium')
      expect(config.contexts).toHaveProperty('dark')
      expect(config.fonts).toHaveProperty('body')
      expect(config.appearance).toHaveProperty('default')
    })

    it('merges custom colors with defaults', () => {
      const { config } = processTheme({
        colors: {
          brand: '#ff5500',
        },
      })

      expect(config.colors.brand).toBe('#ff5500')
      expect(config.colors.primary).toBeDefined() // Default preserved
    })

    it('overrides default colors', () => {
      const { config } = processTheme({
        colors: {
          primary: '#ff0000',
        },
      })

      expect(config.colors.primary).toBe('#ff0000')
    })

    it('merges context token overrides', () => {
      const { config } = processTheme({
        contexts: {
          light: {
            'custom-token': 'custom-value',
          },
        },
      })

      expect(config.contexts.light['custom-token']).toBe('custom-value')
      expect(config.contexts.light.section).toBeDefined() // Default preserved
    })

    it('resolves bare palette references in context overrides', () => {
      const { config } = processTheme({
        contexts: {
          light: {
            primary: 'primary-500',
            'primary-hover': '--primary-600',
            section: 'white',           // Named color — pass through
            link: 'var(--accent-400)',   // Already var() — pass through
            border: '#e5e5e5',           // Hex — pass through
          },
        },
      })

      expect(config.contexts.light.primary).toBe('var(--primary-500)')
      expect(config.contexts.light['primary-hover']).toBe('var(--primary-600)')
      expect(config.contexts.light.section).toBe('white')
      expect(config.contexts.light.link).toBe('var(--accent-400)')
      expect(config.contexts.light.border).toBe('#e5e5e5')
    })

    it('processes font configuration', () => {
      const { config } = processTheme({
        fonts: {
          body: 'Inter, sans-serif',
          import: [{ url: 'https://fonts.example.com' }],
        },
      })

      expect(config.fonts.body).toBe('Inter, sans-serif')
      expect(config.fonts.import).toHaveLength(1)
    })

    it('normalizes simple appearance string', () => {
      const { config } = processTheme({
        appearance: 'dark',
      })

      expect(config.appearance.default).toBe('dark')
      expect(config.appearance.allowToggle).toBe(false)
    })

    it('normalizes system appearance', () => {
      const { config } = processTheme({
        appearance: 'system',
      })

      expect(config.appearance.default).toBe('system')
      expect(config.appearance.respectSystemPreference).toBe(true)
    })

    it('merges appearance object with defaults', () => {
      const { config } = processTheme({
        appearance: {
          allowToggle: true,
        },
      })

      expect(config.appearance.allowToggle).toBe(true)
      expect(config.appearance.default).toBe('light') // Default
    })

    it('generates warnings for missing primary color', () => {
      const { warnings } = processTheme({})

      expect(warnings).toContainEqual(expect.stringContaining('primary'))
    })

    it('resolves neutral preset names to hex', () => {
      const { config, errors } = processTheme({
        colors: { neutral: 'stone' },
      })

      expect(errors).toHaveLength(0)
      expect(config.colors.neutral).toBe('#78716c')
    })

    it('accepts all neutral preset names', () => {
      for (const preset of ['stone', 'zinc', 'gray', 'slate', 'neutral']) {
        const { errors } = processTheme({ colors: { neutral: preset } })
        expect(errors).toHaveLength(0)
      }
    })

    it('validates neutral preset names', () => {
      const { valid } = validateThemeConfig({ colors: { neutral: 'stone' } })
      expect(valid).toBe(true)
    })

    it('provides default inline styles', () => {
      const { config } = processTheme({})

      expect(config.inline).toHaveProperty('accent')
      expect(config.inline.accent.color).toBe('var(--link)')
      expect(config.inline).toHaveProperty('muted')
      expect(config.inline.muted.color).toBe('var(--subtle)')
    })

    it('merges user inline styles with defaults', () => {
      const { config } = processTheme({
        inline: {
          highlight: {
            'background-color': 'var(--accent-100)',
          },
        },
      })

      // User style present
      expect(config.inline.highlight['background-color']).toBe('var(--accent-100)')
      // Defaults preserved
      expect(config.inline.accent.color).toBe('var(--link)')
    })

    it('allows user to override default inline styles', () => {
      const { config } = processTheme({
        inline: {
          accent: {
            color: 'var(--accent-600)',
            'font-style': 'italic',
          },
        },
      })

      expect(config.inline.accent.color).toBe('var(--accent-600)')
      expect(config.inline.accent['font-style']).toBe('italic')
    })

    it('throws in strict mode with errors', () => {
      expect(() => {
        processTheme(
          { colors: { invalid: 'not-a-color' } },
          { strict: true }
        )
      }).toThrow()
    })

    it('does not throw in non-strict mode with errors', () => {
      const { errors } = processTheme(
        { colors: { invalid: 'not-a-color' } },
        { strict: false }
      )

      expect(errors.length).toBeGreaterThan(0)
    })

    describe('foundation vars', () => {
      it('includes foundation vars in output', () => {
        const { config } = processTheme({}, {
          foundationVars: {
            'header-height': { type: 'length', default: '64px' },
          },
        })

        expect(config.foundationVars['header-height']).toBeDefined()
        expect(config.foundationVars['header-height'].default).toBe('64px')
      })

      it('merges site overrides with foundation vars', () => {
        const { config } = processTheme(
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

        expect(config.foundationVars['header-height'].default).toBe('80px')
      })

      it('allows site to add new vars', () => {
        const { config } = processTheme(
          {
            vars: {
              'custom-var': 'custom-value',
            },
          },
          {
            foundationVars: {},
          }
        )

        expect(config.foundationVars['custom-var'].default).toBe('custom-value')
      })

      it('handles foundationVars alias', () => {
        const { config } = processTheme({
          foundationVars: {
            'sidebar-width': '300px',
          },
        })

        expect(config.foundationVars['sidebar-width'].default).toBe('300px')
      })
    })
  })

  describe('extractFoundationVars', () => {
    it('extracts vars from module default export', () => {
      const module = {
        default: {
          vars: {
            'header-height': '64px',
          },
        },
      }

      const vars = extractFoundationVars(module)
      expect(vars['header-height']).toBe('64px')
    })

    it('extracts vars from direct module', () => {
      const module = {
        vars: {
          'sidebar-width': '280px',
        },
      }

      const vars = extractFoundationVars(module)
      expect(vars['sidebar-width']).toBe('280px')
    })

    it('uses whole module if no vars property', () => {
      const module = {
        'custom-var': '100px',
      }

      const vars = extractFoundationVars(module)
      expect(vars['custom-var']).toBe('100px')
    })

    it('returns empty object for null/undefined', () => {
      expect(extractFoundationVars(null)).toEqual({})
      expect(extractFoundationVars(undefined)).toEqual({})
    })
  })

  describe('foundationHasVars', () => {
    it('returns true if schema has root themeVars (backwards compat)', () => {
      const schema = {
        themeVars: {
          'header-height': { type: 'length', default: '64px' },
        },
      }

      expect(foundationHasVars(schema)).toBe(true)
    })

    it('returns true if schema has _self.themeVars', () => {
      const schema = {
        _self: {
          name: 'Test Foundation',
          themeVars: {
            'sidebar-width': { type: 'length', default: '280px' },
          },
        },
      }

      expect(foundationHasVars(schema)).toBe(true)
    })

    it('returns false if schema has no themeVars', () => {
      expect(foundationHasVars({})).toBe(false)
      expect(foundationHasVars(null)).toBe(false)
      expect(foundationHasVars(undefined)).toBe(false)
    })

    it('returns false if _self exists but has no themeVars', () => {
      expect(foundationHasVars({ _self: { name: 'Foundation' } })).toBe(false)
    })
  })
})
