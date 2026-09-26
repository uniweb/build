import {
  extractRuntimeSchema,
  extractAllRuntimeSchemas,
} from '../src/runtime-schema.js'

// What a lean schema says apart from its declared keys — for the tests of field extraction,
// which the `data` map of keys (asserted on its own below) does not change.
const withoutData = (lean) => {
  if (!lean) return lean
  const { data, ...rest } = lean
  return Object.keys(rest).length ? rest : null
}

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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({ inset: true })
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({ background: true })
    })

    it('extracts background: "auto"', () => {
      const meta = { background: 'auto' }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({ background: 'auto' })
    })

    it('extracts background: "manual"', () => {
      const meta = { background: 'manual' }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({ background: 'manual' })
    })

    it('ignores background: false', () => {
      const meta = { background: false }
      expect(extractRuntimeSchema(meta)).toBeNull()
    })
  })

  describe('data declaration', () => {
    it('⭐ every declared key reaches the runtime with its schema ref — null for an inline shape (2026-09-14)', () => {
      const meta = {
        data: {
          post: '@std/article',
          team: { schema: '@/member' },
          nav: { label: 'string' },
          form: { fields: [{ id: 'name', type: 'text' }] },
          notes: {},
        },
      }
      const result = extractRuntimeSchema(meta, { '@std/article': { name: 'article', fields: { title: { type: 'string' } } } })
      expect(result.data).toEqual({ post: '@std/article', team: '@/member', nav: null, form: null, notes: null })
      expect(Object.keys(result.data)).toEqual(['post', 'team', 'nav', 'form', 'notes'])
      // field defaults only where there are fields
      expect(Object.keys(result.schemas)).toEqual(['post', 'nav', 'form'])
    })

    it('⛔ a value that is no schema is refused — it would declare a key by accident', () => {
      expect(() => extractRuntimeSchema({ data: { inherit: ['members', 'queries'] } })).toThrow(/data\.inherit.*`data: \{ inherit: \[\.\.\.\] \}` is retired/)
      expect(() => extractRuntimeSchema({ data: { posts: true } })).toThrow(/Invalid 'data\.posts'/)
      expect(() => extractRuntimeSchema({ data: { posts: 3 } })).toThrow(/Invalid 'data\.posts'/)
      // CONTROL — every schema form, and `{}` / null for none
      expect(extractRuntimeSchema({ data: { a: '@/x', b: {}, c: null, d: { fields: [] } } }).data).toEqual({ a: '@/x', b: null, c: null, d: null })
    })

    it('`data: false` declares nothing, as no `data:` does — ⛔ it was the opt-out, `inheritData: false`, until 2026-09-14', () => {
      expect(extractRuntimeSchema({ data: false })).toBeNull()
      expect(extractRuntimeSchema({ title: 'X' })).toBeNull()
    })

    it('returns null for empty data object', () => {
      expect(extractRuntimeSchema({ data: {} })).toBeNull()
    })

    it('extracts an inline field-map schema keyed by data key', () => {
      const meta = {
        data: { nav: { label: 'string', href: 'string' } },
      }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(result)).toEqual({
        schemas: { member: { name: 'string', role: 'string' } },
      })
    })

    // ⛔ THE REGRESSION THIS SUITE MISSED FOR ITS WHOLE LIFE. Every case above
    // hands `dataSchemaMap` a schema in the FIELDS-FORM — the authoring sugar for
    // a one-section model. `leanDataSchema` read `resolved.fields` directly, which
    // only that form has, so a SECTIONS-FORM schema resolved to null and the
    // section's `data:` binding supplied no field defaults at all. Every `@std/*`
    // schema is sections-form, so that was every standard binding — and the suite
    // stayed green because it contained no sections-form schema to fail on.
    //
    // ⚖️ `dataSchemaMap` holds each schema AS AUTHORED: resolution and lowering
    // are different steps, and only lowering (on the way to the registry)
    // normalizes the two forms. A reader here must therefore accept both.
    it('resolves a SECTIONS-FORM named ref, not just the fields-form sugar', () => {
      const meta = { data: { articles: '@std/article' } }
      const result = extractRuntimeSchema(meta, {
        '@std/article': {
          name: 'article',
          sections: {
            article: {
              brief: true,
              fields: { title: 'string', slug: 'string' },
            },
            article_body: {
              fields: { status: { type: 'string', default: 'published' } },
            },
          },
        },
      })
      // As DELIVERED: the brief's fields at the top, another section under its name —
      // so `status`'s default lands inside `article_body`, where the record carries it.
      expect(withoutData(result)).toEqual({
        schemas: {
          articles: {
            title: 'string',
            slug: 'string',
            article_body: { type: 'object', fields: { status: { type: 'string', default: 'published' } } },
          },
        },
      })
    })

    it('a `multi` section is one field of the delivered record — a list, each record filled', () => {
      const meta = { data: { x: '@/thing' } }
      const result = extractRuntimeSchema(meta, {
        '@/thing': {
          name: 'thing',
          sections: {
            thing: { brief: true, fields: { title: 'string' } },
            entries: { kind: 'multi', fields: { note: { type: 'string', default: '—' } } },
          },
        },
      })
      expect(result.schemas.x).toEqual({
        title: 'string',
        entries: { type: 'array', items: { type: 'object', fields: { note: { type: 'string', default: '—' } } } },
      })
      // Never a field of the record itself.
      expect(result.schemas.x.note).toBeUndefined()
    })

    it('a ref that resolves to neither form yields no field defaults — the key still reaches the runtime', () => {
      // The control: no `schemas` entry rather than an empty object, which would be a
      // schema key a component can do nothing with. The key itself is what it receives.
      const meta = { data: { x: '@/empty' } }
      expect(extractRuntimeSchema(meta, { '@/empty': { name: 'empty' } })).toEqual({ data: { x: '@/empty' } })
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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

    it('handles a nested object via fields', () => {
      const meta = {
        data: {
          card: {
            meta: {
              type: 'object',
              label: 'Metadata',
              fields: {
                author: { type: 'string', label: 'Author Name' },
                date: 'string',
              },
            },
          },
        },
      }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
        schemas: {
          card: {
            meta: {
              type: 'object',
              fields: {
                author: 'string',
                date: 'string',
              },
            },
          },
        },
      })
    })

    it('handles an array with scalar items', () => {
      const meta = {
        data: {
          card: {
            tags: { type: 'array', items: 'string' },
          },
        },
      }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
        schemas: {
          card: {
            tags: { type: 'array', items: 'string' },
          },
        },
      })
    })

    it('handles an array of objects via items.fields', () => {
      const meta = {
        data: {
          social: {
            links: {
              type: 'array',
              label: 'Social Links',
              items: {
                type: 'object',
                fields: {
                  platform: { type: 'string', label: 'Platform' },
                  url: 'string',
                },
              },
            },
          },
        },
      }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
        schemas: {
          social: {
            links: {
              type: 'array',
              items: {
                type: 'object',
                fields: {
                  platform: 'string',
                  url: 'string',
                },
              },
            },
          },
        },
      })
    })

    it('carries defaults through nested object and array-of-object fields', () => {
      const meta = {
        data: {
          event: {
            location: {
              type: 'object',
              fields: {
                city: 'string',
                virtual: { type: 'bool', default: false },
              },
            },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                fields: {
                  name: 'string',
                  published: { type: 'bool', default: true },
                },
              },
            },
          },
        },
      }
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
        schemas: {
          event: {
            location: {
              type: 'object',
              fields: {
                city: 'string',
                virtual: { type: 'bool', default: false },
              },
            },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                fields: {
                  name: 'string',
                  published: { type: 'bool', default: true },
                },
              },
            },
          },
        },
      })
    })

    it('an empty schema entry carries no field defaults — the key still reaches the runtime', () => {
      expect(extractRuntimeSchema({ data: { nav: {} } })).toEqual({ data: { nav: null } })
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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
      expect(withoutData(extractRuntimeSchema(meta))).toEqual({
        background: true,
        defaults: { theme: 'dark' },
        schemas: {
          'nav-links': { label: 'string', href: 'string' },
        },
      })
    })
  })
})

describe('`data:` is the delivery — a section receives the keys its component declares (ruled 2026-09-14)', () => {
  // ⛔ Until then delivery was default-on and `data:` a hint: `inheritData` is emitted no more.
  it('a declared schema lists its key, and emits no inheritData', () => {
    const meta = { data: { team: { name: 'string' } } }
    const result = extractRuntimeSchema(meta)
    expect(result.data).toEqual({ team: null })
    expect(result.schemas.team).toEqual({ name: 'string' })
    expect(result.inheritData).toBeUndefined()
  })

  it('a nav schema likewise', () => {
    const meta = { data: { nav: { label: 'string' } } }
    const result = extractRuntimeSchema(meta)
    expect(result.data).toEqual({ nav: null })
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
        data: { features: null },
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
    expect(withoutData(extractRuntimeSchema(meta))).toEqual({
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

  it('does NOT convert a form field type of "string" — the legacy text alias was removed 2026-09-05', () => {
    const meta = {
      data: {
        item: {
          fields: [{ id: 'date', type: 'string' }],
        },
      },
    }
    const result = extractRuntimeSchema(meta)
    // The value passes through untouched; `string` is no longer a form type.
    expect(result.schemas.item.fields[0].type).toBe('string')
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

describe('an enum of `{ value, label }` entries', () => {
  it('reaches the runtime as its values — the label is an editor’s', () => {
    const lean = extractRuntimeSchema({
      data: { posts: { fields: { status: { type: 'string', default: 'draft', enum: [{ value: 'draft', label: 'Draft' }, { value: 'live', label: 'Live' }] } } } },
    })
    expect(JSON.stringify(lean)).toContain('"enum":["draft","live"]')
    expect(JSON.stringify(lean)).not.toContain('Draft')
  })
})
