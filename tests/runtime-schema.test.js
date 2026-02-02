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
        inheritData: ['events'],
      })
    })

    it('parses type with limit', () => {
      const meta = { data: 'events:6' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        inheritData: ['events'],
      })
    })

    it('trims whitespace', () => {
      const meta = { data: ' articles : 5 ' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'articles', limit: 5 },
        inheritData: ['articles'],
      })
    })

    it('handles single entity', () => {
      const meta = { data: 'project:1' }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'project', limit: 1 },
        inheritData: ['project'],
      })
    })

    it('ignores invalid data values', () => {
      expect(extractRuntimeSchema({ data: null })).toBeNull()
      expect(extractRuntimeSchema({ data: 123 })).toBeNull()
      expect(extractRuntimeSchema({ data: '' })).toBeNull()
    })
  })

  describe('consolidated data object format', () => {
    it('extracts entity from data object', () => {
      const meta = { data: { entity: 'events:6' } }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        inheritData: ['events'],
      })
    })

    it('extracts entity without limit', () => {
      const meta = { data: { entity: 'events' } }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: null },
        inheritData: ['events'],
      })
    })

    it('extracts all three subfields', () => {
      const meta = {
        data: {
          entity: 'person:6',
          schemas: { team: { name: 'string', role: 'string' } },
          inherit: true,
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'person', limit: 6 },
        schemas: { team: { name: 'string', role: 'string' } },
        inheritData: true,
      })
    })

    it('extracts schemas without entity', () => {
      const meta = {
        data: {
          schemas: { nav: { label: 'string', href: 'string' } },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: { nav: { label: 'string', href: 'string' } },
      })
    })

    it('extracts inherit without entity', () => {
      const meta = { data: { inherit: ['team'] } }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: ['team'],
      })
    })

    it('extracts inherit: false', () => {
      const meta = { data: { inherit: false } }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: false,
      })
    })

    it('returns null for empty data object', () => {
      expect(extractRuntimeSchema({ data: {} })).toBeNull()
    })

    it('ignores empty entity string in data object', () => {
      const meta = { data: { entity: '' } }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('data.schemas takes priority over top-level schemas', () => {
      const meta = {
        data: {
          schemas: { nav: { label: 'string' } },
        },
        schemas: { nav: { label: 'string', href: 'string' } },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: { nav: { label: 'string' } },
      })
    })

    it('data.inherit takes priority over top-level inheritData', () => {
      const meta = {
        data: { inherit: ['team'] },
        inheritData: true,
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: ['team'],
      })
    })

    it('old top-level format still works', () => {
      const meta = {
        data: 'events:6',
        schemas: { event: { title: 'string' } },
        inheritData: true,
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        schemas: { event: { title: 'string' } },
        inheritData: true,
      })
    })

    it('top-level schemas used when data object has no schemas', () => {
      const meta = {
        data: { entity: 'events:6' },
        schemas: { event: { title: 'string' } },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        schemas: { event: { title: 'string' } },
        inheritData: ['events'],
      })
    })

    it('top-level inheritData used when data object has no inherit', () => {
      const meta = {
        data: { entity: 'events:6' },
        inheritData: ['event'],
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        inheritData: ['event'],
      })
    })

    it('ignores eager (removed — BlockRenderer always renders immediately)', () => {
      const meta = { data: { eager: true } }
      expect(extractRuntimeSchema(meta)).toBeNull()
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

    it('ignores legacy "properties" field name', () => {
      const meta = {
        properties: {
          theme: { type: 'select', default: 'gradient' },
        },
      }
      expect(extractRuntimeSchema(meta)).toBeNull()
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

    it('handles full @uniweb/schemas format (with name/version/fields)', () => {
      const meta = {
        schemas: {
          team: {
            name: 'person',
            version: '1.0.0',
            description: 'A person schema',
            fields: {
              name: { type: 'string', required: true, description: 'Full name' },
              role: { type: 'string', description: 'Job title' },
              featured: { type: 'boolean', default: false },
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          team: {
            name: 'string',
            role: 'string',
            featured: { type: 'boolean', default: false },
          },
        },
      })
    })

    it('handles mixed inline and full format schemas', () => {
      const meta = {
        schemas: {
          // Full format (from @uniweb/schemas)
          team: {
            name: 'person',
            fields: {
              name: 'string',
              email: { type: 'string', format: 'email' },
            },
          },
          // Inline format
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          team: {
            name: 'string',
            email: 'string',
          },
          'nav-links': {
            label: 'string',
            href: 'string',
          },
        },
      })
    })

    it('extracts defaults from full format schema fields', () => {
      const meta = {
        schemas: {
          config: {
            name: 'config',
            fields: {
              theme: { type: 'select', options: ['light', 'dark'], default: 'light' },
              maxItems: { type: 'number', default: 10 },
            },
          },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: {
          config: {
            theme: { type: 'select', options: ['light', 'dark'], default: 'light' },
            maxItems: { type: 'number', default: 10 },
          },
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
        inheritData: ['events'],
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

describe('inheritData extraction', () => {
  it('extracts inheritData: true', () => {
    const meta = { inheritData: true }
    expect(extractRuntimeSchema(meta)).toEqual({ inheritData: true })
  })

  it('extracts inheritData: false', () => {
    const meta = { inheritData: false }
    expect(extractRuntimeSchema(meta)).toEqual({ inheritData: false })
  })

  it('extracts inheritData as array', () => {
    const meta = { inheritData: ['person', 'config'] }
    expect(extractRuntimeSchema(meta)).toEqual({
      inheritData: ['person', 'config'],
    })
  })

  it('ignores undefined inheritData', () => {
    const meta = { background: true }
    const result = extractRuntimeSchema(meta)
    expect(result).toEqual({ background: true })
    expect(result.inheritData).toBeUndefined()
  })

  it('combines with other runtime properties', () => {
    const meta = {
      background: true,
      inheritData: true,
      params: { theme: { default: 'dark' } },
    }
    expect(extractRuntimeSchema(meta)).toEqual({
      background: true,
      inheritData: true,
      defaults: { theme: 'dark' },
    })
  })
})

describe('auto-derive inheritData from entity', () => {
  it('derives inheritData from string data format', () => {
    const meta = { data: 'articles:5' }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toEqual(['articles'])
  })

  it('derives inheritData from object entity format', () => {
    const meta = { data: { entity: 'team' } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toEqual(['team'])
  })

  it('explicit data.inherit array overrides auto-derive', () => {
    const meta = { data: { entity: 'articles', inherit: ['articles', 'featured'] } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toEqual(['articles', 'featured'])
  })

  it('explicit data.inherit: true overrides auto-derive', () => {
    const meta = { data: { entity: 'articles', inherit: true } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toBe(true)
  })

  it('explicit data.inherit: false overrides auto-derive', () => {
    const meta = { data: { entity: 'articles', inherit: false } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toBe(false)
  })

  it('top-level inheritData overrides auto-derive', () => {
    const meta = { data: 'articles:5', inheritData: ['articles', 'featured'] }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toEqual(['articles', 'featured'])
  })

  it('does not derive when no entity is declared', () => {
    const meta = { data: { schemas: { nav: { label: 'string' } } } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toBeUndefined()
  })

  it('does not derive for empty data object', () => {
    const result = extractRuntimeSchema({ data: {} })
    expect(result).toBeNull()
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
        inheritData: ['features'],
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

