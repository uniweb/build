import {
  extractRuntimeSchema,
  extractAllRuntimeSchemas,
} from '../src/runtime-schema.js'

// What a lean schema says apart from its declared keys — for the tests of the other parts,
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

  it('⛔ does not carry `inset` — an inset is found by name; the flag is the editor’s (2026-10-05)', () => {
    expect(extractRuntimeSchema({ inset: true })).toBeNull()
    expect(extractRuntimeSchema({ inset: true, background: 'self' })).toEqual({ background: 'self' })
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
      const result = extractRuntimeSchema(meta)
      expect(result.data).toEqual({ post: '@std/article', team: '@/member', nav: null, form: null, notes: null })
      expect(Object.keys(result.data)).toEqual(['post', 'team', 'nav', 'form', 'notes'])
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

    it('a concept block’s key is the tag a component reads, with no schema', () => {
      expect(extractRuntimeSchema({ data: { 'md:faq': 'Questions [2+]' } })).toEqual({ data: { faq: null } })
    })
  })

  describe('⛔ no field defaults — ruled 2026-10-05', () => {
    // Until then each declared key carried `schemas` — its schema's field defaults, `enum`
    // and the nesting that led to them — and the runtime filled a missing field from its
    // `default` and replaced a value its `enum` rejected.
    const meta = {
      data: {
        team: '@/member',
        posts: '@std/article/*',
        specs: { cpu: { type: 'string', default: 'quad', label: 'CPU', enum: ['quad', 'octa'] } },
        signup: {
          fields: [
            { id: 'email', type: 'text', label: 'Email address', placeholder: 'you@example.com', default: 'a@b.c' },
            { id: 'topic', type: 'select', label: 'Topic', options: ['Sales', 'Support'], condition: { email: 'x' } },
          ],
        },
      },
    }

    it('a section type carries its keys and their refs, and no shape of any of them', () => {
      expect(extractRuntimeSchema(meta)).toEqual({
        data: { team: '@/member', posts: '@std/article/*', specs: null, signup: null },
      })
    })

    it('a form in `data:` is the editor’s, for authoring the block — none of it reaches the runtime', () => {
      const lean = JSON.stringify(extractRuntimeSchema(meta))
      for (const word of ['Email address', 'you@example.com', 'a@b.c', 'Sales', 'condition', 'quad', 'CPU']) {
        expect(lean).not.toContain(word)
      }
      // CONTROL — the keys themselves are there
      expect(lean).toContain('"signup":null')
    })

    it('resolved data schemas change nothing — the extractor takes none', () => {
      const resolved = { '@/member': { name: 'member', fields: { role: { type: 'string', default: 'Member' } } } }
      expect(extractRuntimeSchema(meta, resolved)).toEqual(extractRuntimeSchema(meta))
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
        context: { allowTranslucentTop: true },
        initialState: { expanded: false },
      }
      expect(extractRuntimeSchema(meta)).toEqual({
        background: true,
        data: { events: null },
        defaults: { layout: 'grid', columns: 3 },
        context: { allowTranslucentTop: true },
        initialState: { expanded: false },
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
