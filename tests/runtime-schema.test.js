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

  describe('data declaration', () => {
    it('`data: false` marks explicit opt-out', () => {
      const meta = { data: false }
      expect(extractRuntimeSchema(meta)).toEqual({
        inheritData: false,
      })
    })

    it('returns null for empty data object', () => {
      expect(extractRuntimeSchema({ data: {} })).toBeNull()
    })

    it('extracts an inline field-map schema keyed by data key', () => {
      const meta = {
        data: { nav: { label: 'string', href: 'string' } },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        schemas: { nav: { label: 'string', href: 'string' } },
      })
    })

    it('resolves a named ref via dataSchemaMap', () => {
      const meta = { data: { member: '@/member' } }
      const result = extractRuntimeSchema(meta, {
        '@/member': {
          name: 'member',
          fields: { name: 'string', role: { type: 'string', label: 'Role' } },
        },
      })
      expect(result).toEqual({
        schemas: { member: { name: 'string', role: 'string' } },
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

  describe('schemas extraction (inline field maps under data:)', () => {
    it('extracts schemas with shorthand notation', () => {
      const meta = {
        data: {
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
        data: {
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
        data: {
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
        data: {
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
        data: {
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
        data: {
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
        data: {
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

    it('returns null for empty schema entries', () => {
      expect(extractRuntimeSchema({ data: { nav: {} } })).toBeNull()
      expect(extractRuntimeSchema({ data: {} })).toBeNull()
    })

    it('handles multiple schemas', () => {
      const meta = {
        data: {
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
        data: {
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
        data: {
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
        data: {
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
        data: { events: { title: 'string', date: 'string' } },
        params: {
          layout: { type: 'select', default: 'grid' },
          columns: { type: 'number', default: 3 },
        },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        background: true,
        schemas: { events: { title: 'string', date: 'string' } },
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
        data: {
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

describe('schema delivery is default-on (data: is a declaration, not a gate)', () => {
  // EntityStore delivers everything unless the component opts out with
  // `data: false`. A `data:` schema entry never implies `inheritData`.
  it('does not emit inheritData when a schema is declared', () => {
    const meta = { data: { team: { name: 'string' } } }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.team).toEqual({ name: 'string' })
    expect(result.inheritData).toBeUndefined()
  })

  it('does not emit inheritData when only a nav schema is declared', () => {
    const meta = { data: { nav: { label: 'string' } } }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.nav).toEqual({ label: 'string' })
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
        data: { features: { title: 'string', summary: 'string' } },
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
        schemas: { features: { title: 'string', summary: 'string' } },
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

describe('rich form schemas (FormBlock + tagged-block unified)', () => {
  it('passes a composite schema through with all editor metadata', () => {
    const richSchema = {
      name: { en: 'Stats', fr: 'Statistiques' },
      isComposite: true,
      childSchema: {
        name: { en: 'Stat', fr: 'Statistique' },
        fields: [
          {
            id: 'number',
            type: 'text',
            label: { en: 'Number', fr: 'Nombre' },
            required: true,
          },
          { id: 'text', type: 'text', label: 'Text' },
        ],
      },
    }
    const meta = { data: { stats: richSchema } }
    expect(extractRuntimeSchema(meta)).toEqual({
      schemas: { stats: richSchema },
    })
  })

  it('keeps rich and simple schemas side-by-side in the same map', () => {
    const meta = {
      data: {
        'nav-links': { label: 'string', href: 'string' },
        'stats': {
          isComposite: true,
          childSchema: { fields: [{ id: 'n', type: 'text' }] },
        },
      },
    }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas['nav-links']).toEqual({ label: 'string', href: 'string' })
    expect(result.schemas.stats).toEqual({
      isComposite: true,
      childSchema: { fields: [{ id: 'n', type: 'text' }] },
    })
  })

  it('normalizes legacy type:"string" to type:"text" in rich field definitions', () => {
    const meta = {
      data: {
        item: {
          fields: [{ id: 'date', type: 'string' }],
        },
      },
    }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.item.fields[0].type).toBe('text')
  })

  it('preserves condition operators on rich fields', () => {
    const fields = [
      { id: 'for', type: 'select' },
      { id: 'department', type: 'text', condition: { for: 'scholar' } },
      { id: 'label', type: 'text', condition: { for: { $in: ['a', 'b'] } } },
    ]
    const meta = { data: { form: { fields } } }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.form.fields).toEqual(fields)
  })

  it('distinguishes rich schema (fields array) from full format (fields object)', () => {
    const meta = {
      data: {
        rich: { fields: [{ id: 'a', type: 'text' }] },
        full: { name: 's', fields: { a: 'string' } },
      },
    }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.rich.fields).toEqual([{ id: 'a', type: 'text' }])
    expect(result.schemas.full).toEqual({ a: 'string' })
  })

  it('treats childSchema presence as a rich-schema marker even without isComposite', () => {
    const meta = {
      data: {
        items: { childSchema: { fields: [{ id: 'n', type: 'text' }] } },
      },
    }
    const result = extractRuntimeSchema(meta)
    expect(result.schemas.items).toEqual({
      childSchema: { fields: [{ id: 'n', type: 'text' }] },
    })
  })
})
