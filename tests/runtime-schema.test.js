import {
  extractRuntimeSchema,
  extractAllRuntimeSchemas,
} from '../src/runtime-schema.js'

describe('extractRuntimeSchema', () => {
  it('returns null for empty/invalid input', () => {
    expect(extractRuntimeSchema(null)).toBeNull()
    expect(extractRuntimeSchema(undefined)).toBeNull()
    expect(extractRuntimeSchema('not an object')).toBeNull()
  })

  it('returns null when meta has no runtime-relevant properties', () => {
    const meta = {
      title: 'Hero',
      description: 'A hero component',
      category: 'impact',
    }
    expect(extractRuntimeSchema(meta)).toBeNull()
  })

  describe('background extraction', () => {
    it('extracts background: true', () => {
      const meta = { background: true }
      expect(extractRuntimeSchema(meta)).toEqual({ background: true })
    })

    it('extracts background: "auto"', () => {
      const meta = { background: 'auto' }
      expect(extractRuntimeSchema(meta)).toEqual({ background: 'auto' })
    })

    it('extracts background: "manual"', () => {
      const meta = { background: 'manual' }
      expect(extractRuntimeSchema(meta)).toEqual({ background: 'manual' })
    })

    it('ignores background: false', () => {
      const meta = { background: false }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })
  })

  describe('data parsing', () => {
    it('parses type only', () => {
      const meta = { data: 'events' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: null },
      })
    })

    it('parses type with limit', () => {
      const meta = { data: 'events:6' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
      })
    })

    it('trims whitespace', () => {
      const meta = { data: ' articles : 5 ' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'articles', limit: 5 },
      })
    })

    it('handles single entity', () => {
      const meta = { data: 'project:1' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'project', limit: 1 },
      })
    })

    it('ignores invalid data values', () => {
      expect(extractRuntimeSchema({ data: null })).toBeNull()
      expect(extractRuntimeSchema({ data: 123 })).toBeNull()
      expect(extractRuntimeSchema({ data: '' })).toBeNull()
    })
  })

  describe('param defaults extraction', () => {
    it('extracts defaults from params', () => {
      const meta = {
        params: {
          theme: { type: 'select', default: 'gradient' },
          layout: { type: 'select', default: 'center' },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient', layout: 'center' },
      })
    })

    it('handles boolean defaults', () => {
      const meta = {
        params: {
          showPattern: { type: 'boolean', default: true },
          showBorder: { type: 'boolean', default: false },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { showPattern: true, showBorder: false },
      })
    })

    it('handles numeric defaults', () => {
      const meta = {
        params: {
          maxItems: { type: 'number', default: 6 },
          columns: { type: 'number', default: 0 },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { maxItems: 6, columns: 0 },
      })
    })

    it('ignores params without defaults', () => {
      const meta = {
        params: {
          theme: { type: 'select', default: 'gradient' },
          customClass: { type: 'string' }, // no default
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient' },
      })
    })

    it('returns null when no params have defaults', () => {
      const meta = {
        params: {
          customClass: { type: 'string' },
        },
      }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('ignores invalid params values', () => {
      expect(extractRuntimeSchema({ params: null })).toBeNull()
      expect(extractRuntimeSchema({ params: 'invalid' })).toBeNull()
    })

    it('supports v1 "properties" field name', () => {
      const meta = {
        properties: {
          theme: { type: 'select', default: 'gradient' },
          layout: { type: 'select', default: 'center' },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'gradient', layout: 'center' },
      })
    })

    it('prefers v2 "params" over v1 "properties"', () => {
      const meta = {
        params: { theme: { default: 'v2-value' } },
        properties: { theme: { default: 'v1-value' } },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        defaults: { theme: 'v2-value' },
      })
    })
  })

  describe('schemas extraction', () => {
    it('extracts schemas with shorthand notation', () => {
      const meta = {
        schemas: {
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      })
    })

    it('strips editor-only fields (label, hint)', () => {
      const meta = {
        schemas: {
          'nav-links': {
            label: {
              type: 'string',
              label: 'Link Label',
              hint: 'Text shown in the navigation',
            },
            href: {
              type: 'string',
              label: 'Link URL',
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      })
    })

    it('keeps runtime-relevant fields (default, options)', () => {
      const meta = {
        schemas: {
          'nav-links': {
            type: {
              type: 'select',
              label: 'Link Type',
              options: ['plain', 'button', 'dropdown'],
              default: 'plain',
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'nav-links': {
            type: {
              type: 'select',
              options: ['plain', 'button', 'dropdown'],
              default: 'plain',
            },
          },
        },
      })
    })

    it('handles nested object schema', () => {
      const meta = {
        schemas: {
          'card': {
            meta: {
              type: 'object',
              label: 'Metadata',
              schema: {
                author: { type: 'string', label: 'Author Name' },
                date: 'string',
              },
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'card': {
            meta: {
              type: 'object',
              schema: {
                author: 'string',
                date: 'string',
              },
            },
          },
        },
      })
    })

    it('handles array with string of-type', () => {
      const meta = {
        schemas: {
          'tags': {
            items: { type: 'array', of: 'string' },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'tags': {
            items: { type: 'array', of: 'string' },
          },
        },
      })
    })

    it('handles array with schema reference', () => {
      const meta = {
        schemas: {
          'nav-links': {
            children: { type: 'array', of: 'nav-links', label: 'Child Links' },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'nav-links': {
            children: { type: 'array', of: 'nav-links' },
          },
        },
      })
    })

    it('handles array with inline object of-type', () => {
      const meta = {
        schemas: {
          'social': {
            links: {
              type: 'array',
              label: 'Social Links',
              of: {
                platform: { type: 'string', label: 'Platform' },
                url: 'string',
              },
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'social': {
            links: {
              type: 'array',
              of: {
                platform: 'string',
                url: 'string',
              },
            },
          },
        },
      })
    })

    it('returns null for empty schemas', () => {
      expect(extractRuntimeSchema({ schemas: {} })).toBeNull()
      expect(extractRuntimeSchema({ schemas: null })).toBeNull()
    })

    it('handles multiple schemas', () => {
      const meta = {
        schemas: {
          'nav-links': {
            label: 'string',
            href: 'string',
          },
          'social': {
            platform: 'string',
            url: 'string',
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          'nav-links': { label: 'string', href: 'string' },
          'social': { platform: 'string', url: 'string' },
        },
      })
    })
  })

  describe('combined extraction', () => {
    it('extracts all runtime properties', () => {
      const meta = {
        title: 'Event Grid',
        description: 'Display events in a grid',
        category: 'showcase',
        background: true,
        data: 'events:6',
        params: {
          layout: { type: 'select', default: 'grid' },
          columns: { type: 'number', default: 3 },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        background: true,
        data: { type: 'events', limit: 6 },
        defaults: { layout: 'grid', columns: 3 },
      })
    })

    it('extracts all properties including schemas', () => {
      const meta = {
        title: 'Header',
        background: true,
        params: {
          theme: { type: 'select', default: 'dark' },
        },
        schemas: {
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        background: true,
        defaults: { theme: 'dark' },
        schemas: {
          'nav-links': { label: 'string', href: 'string' },
        },
      })
    })
  })
})

describe('extractAllRuntimeSchemas', () => {
  it('extracts schemas for multiple components', () => {
    const componentsMeta = {
      Hero: {
        title: 'Hero',
        background: true,
        params: { theme: { default: 'gradient' } },
      },
      Features: {
        title: 'Features',
        data: 'features:6',
      },
      Text: {
        title: 'Text Section',
        category: 'structure',
      },
    }

    const result = extractAllRuntimeSchemas(componentsMeta)

    expect(result).toEqual({
      Hero: {
        background: true,
        defaults: { theme: 'gradient' },
      },
      Features: {
        data: { type: 'features', limit: 6 },
      },
      // Text is excluded (no runtime properties)
    })
  })

  it('returns empty object when no components have runtime properties', () => {
    const componentsMeta = {
      Text: { title: 'Text', category: 'structure' },
      Section: { title: 'Section', category: 'structure' },
    }
    expect(extractAllRuntimeSchemas(componentsMeta)).toEqual({})
  })

  it('handles empty input', () => {
    expect(extractAllRuntimeSchemas({})).toEqual({})
  })
})

