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

  describe('inset extraction', () => {
    it('extracts inset: true', () => {
      const meta = { inset: true }
      expect(extractRuntimeSchema(meta)).toEqual({ inset: true })
    })

    it('ignores inset when falsy', () => {
      const meta = { inset: false }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('ignores inset when not present', () => {
      const meta = { background: 'self' }
      const result = extractRuntimeSchema(meta)
      expect(result.inset).toBeUndefined()
    })
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
    // `data.entity` is a declaration (shape hint), not a delivery gate.
    // Delivery is default-on and does not need `inheritData` to be set.
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

    it('`data: false` marks explicit opt-out', () => {
      const meta = { data: false }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: false,
      })
    })
  })

  describe('consolidated data object format', () => {
    // With default-on delivery, `entity` is a declaration only — no
    // `inheritData` is emitted for entity declarations.
    it('extracts entity from data object', () => {
      const meta = { data: { entity: 'events:6' } }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
      })
    })

    it('extracts entity without limit', () => {
      const meta = { data: { entity: 'events' } }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: null },
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

    it('old top-level format: schemas + legacy inheritData: false', () => {
      // Top-level inheritData is honored only as opt-out.
      const meta = {
        data: 'events:6',
        schemas: { event: { title: 'string' } },
        inheritData: false,
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'events', limit: 6 },
        schemas: { event: { title: 'string' } },
        inheritData: false,
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
      })
    })

    it('ignores eager (removed — BlockRenderer always renders immediately)', () => {
      const meta = { data: { eager: true } }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })
  })

  describe('deprecated inherit handling', () => {
    // Delivery is default-on; component-side inherit is gone.
    // The runtime schema accepts the old forms silently (with dev warning
    // in non-production, suppressed here) but ignores everything except
    // `inherit: false`.
    const originalWarn = console.warn
    beforeAll(() => {
      console.warn = () => {}
    })
    afterAll(() => {
      console.warn = originalWarn
    })

    it('ignores data: { inherit: true }', () => {
      const meta = { data: { inherit: true } }
      // `data: {}` with only ignored fields returns null
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('ignores data: { inherit: ["x"] }', () => {
      const meta = { data: { inherit: ['team'] } }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })

    it('honors data: { inherit: false } as opt-out', () => {
      const meta = { data: { inherit: false } }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: false,
      })
    })

    it('ignores data.detail / data.limit on the component side', () => {
      const meta = { data: { entity: 'articles', detail: false, limit: 3 } }
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { type: 'articles', limit: null },
      })
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

describe('top-level inheritData (legacy)', () => {
  // Delivery is default-on. Top-level `inheritData` is honored only as
  // an opt-out (`false`). Truthy and array forms are ignored.
  it('honors inheritData: false as opt-out', () => {
    const meta = { inheritData: false }
    expect(extractRuntimeSchema(meta)).toEqual({ inheritData: false })
  })

  it('ignores inheritData: true', () => {
    const meta = { inheritData: true }
    expect(extractRuntimeSchema(meta)).toBeNull()
  })

  it('ignores inheritData as array', () => {
    const meta = { inheritData: ['person', 'config'] }
    expect(extractRuntimeSchema(meta)).toBeNull()
  })

  it('ignores undefined inheritData', () => {
    const meta = { background: true }
    const result = extractRuntimeSchema(meta)
    expect(result).toEqual({ background: true })
    expect(result.inheritData).toBeUndefined()
  })

  it('combines inheritData: false with other runtime properties', () => {
    const meta = {
      background: true,
      inheritData: false,
      params: { theme: { default: 'dark' } },
    }
    expect(extractRuntimeSchema(meta)).toEqual({
      background: true,
      inheritData: false,
      defaults: { theme: 'dark' },
    })
  })
})

describe('entity is a declaration, not a delivery gate', () => {
  // Under default-on delivery, `entity` no longer implies `inheritData`.
  // EntityStore delivers everything unless the component opts out.
  it('does not emit inheritData for string data format', () => {
    const meta = { data: 'articles:5' }
    const result = extractRuntimeSchema(meta)
    expect(result.data).toEqual({ type: 'articles', limit: 5 })
    expect(result.inheritData).toBeUndefined()
  })

  it('does not emit inheritData for object entity format', () => {
    const meta = { data: { entity: 'team' } }
    const result = extractRuntimeSchema(meta)
    expect(result.data).toEqual({ type: 'team', limit: null })
    expect(result.inheritData).toBeUndefined()
  })

  it('does not emit inheritData when only schemas are declared', () => {
    const meta = { data: { schemas: { nav: { label: 'string' } } } }
    const result = extractRuntimeSchema(meta)
    expect(result.inheritData).toBeUndefined()
  })

  it('returns null for empty data object', () => {
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

