import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// Drive the lowering off the real normalized IR, so the translation and the
// normalizer stay in step. Each test authors a schema, normalizes it, lowers it to
// the @uniweb/data-schema `sections:`-tree declaration, and asserts that shape: a
// root MAP of sections; within a section a `fields:` MAP of leaves + nested
// (`type: section`) fields; cardinality via `multiple:`; brief + sort axis inline;
// `enum`/`format` on the field; no `kind`, no schema-level `brief:`/`sort_date_field`.
const lower = (authored, ref, name) =>
  toDataSchemaDeclaration(validateAndNormalizeSchema(authored, ref), { name })

// The name of the brief section (the one marked `brief: true`), or undefined.
const briefName = (decl) =>
  Object.entries(decl.sections || {}).find(([, s]) => s.brief)?.[0]

describe('toDataSchemaDeclaration — fields-form (flat shorthand)', () => {
  const decl = lower(
    {
      name: 'article',
      description: 'A post',
      sortDate: 'published',
      fields: {
        title: { type: 'string', required: true },
        published: { type: 'date' },
        slug: { type: 'string', translatable: false },
        status: { type: 'string', enum: ['draft', 'live'], default: 'draft' },
        site: { type: 'url' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    '@/article',
    '@acme/article'
  )

  it('carries model attributes and synthesizes one single brief section (root map)', () => {
    expect(decl.name).toBe('@acme/article')
    expect(decl.description).toBe('A post')
    // No schema-level brief / sort_date_field — both are inline now.
    expect(decl).not.toHaveProperty('brief')
    expect(decl).not.toHaveProperty('sort_date_field')
    expect(Object.keys(decl.sections)).toEqual(['article'])
    expect(decl.sections.article.brief).toBe(true)
    expect(decl.sections.article).not.toHaveProperty('multiple') // single
  })

  const fields = () => decl.sections.article.fields

  it('maps scalars 1:1 and required (no `key`, no `kind`)', () => {
    expect(fields().title).toMatchObject({ type: 'string', required: true })
    expect(fields().published).toMatchObject({ type: 'date' })
  })

  it('marks the brief date field with inline sort_date', () => {
    expect(fields().published.sort_date).toBe(true)
  })

  it('marks human text localized; not machine strings', () => {
    expect(fields().title.localized).toBe(true) // prose
    expect(fields().slug.localized).toBeUndefined() // translatable:false
    expect(fields().status.localized).toBeUndefined() // enum token
    expect(fields().site.localized).toBeUndefined() // url format
  })

  it('keeps enum on the field (the backend relocates it to a constraint at ingest)', () => {
    expect(fields().status).toEqual({ type: 'string', enum: ['draft', 'live'] })
  })

  it('keeps format on the field', () => {
    // url/email lower to a plain `string` field carrying `format`; the backend
    // relocates it to a section `format` constraint at ingest.
    expect(fields().site).toEqual({ type: 'string', format: 'url' })
  })

  it('drops field defaults (they ride in the foundation blob)', () => {
    expect(JSON.stringify(decl)).not.toContain('default')
  })

  it('lowers array-of-scalar → the scalar kind + multiple (no `array` type)', () => {
    expect(fields().tags).toEqual({ type: 'string', multiple: true })
  })
})

describe('toDataSchemaDeclaration — json + format: prosemirror (content fields)', () => {
  const decl = lower(
    {
      name: 'doc',
      fields: {
        body: { type: 'json', format: 'prosemirror' }, // rich content
        meta: { type: 'json' }, // plain structured json
        site: { type: 'url' }, // string + format: url (machine-ish)
      },
    },
    '@/doc',
    '@acme/doc'
  )
  const f = () => decl.sections.doc.fields

  it('marks a format: prosemirror json field localized (content, not machine-ish)', () => {
    // Like url/email, `format` rides on the field — but prosemirror is a MARKER,
    // not a validator: the backend carries it and surfaces it in schema reads (so
    // the app mounts a rich-text editor), it does NOT relocate it to a section
    // constraint the way it does the email/url/enum validators.
    expect(f().body).toEqual({ type: 'json', format: 'prosemirror', localized: true })
  })

  it('leaves a plain json field non-localized', () => {
    expect(f().meta.localized).toBeUndefined()
  })

  it('keeps a string format (url/email) non-localized', () => {
    expect(f().site.localized).toBeUndefined()
  })
})

describe('toDataSchemaDeclaration — references', () => {
  const decl = lower(
    {
      fields: {
        author: { type: 'ref', ref: '@/person' },
        editors: { type: 'array', items: { type: 'ref', ref: '@/person' } },
        country: { type: 'string', options: '@/countries' },
        crossorg: { type: 'ref', ref: '@std/person' },
      },
    },
    '@/x',
    '@acme/doc'
  )
  const fields = decl.sections[briefName(decl)].fields

  it('ref → entity_ref with the name resolved into the schema org (scalar model)', () => {
    expect(fields.author).toEqual({ type: 'entity_ref', model: '@acme/person' })
  })

  it('array-of-ref → entity_ref + multiple (the `array` Kind is retired)', () => {
    expect(fields.editors).toEqual({ type: 'entity_ref', multiple: true, model: '@acme/person' })
  })

  it('options → item_ref to the resolved model', () => {
    expect(fields.country).toEqual({ type: 'item_ref', options: '@acme/countries' })
  })

  it('passes a non-self scope through unchanged', () => {
    expect(fields.crossorg.model).toBe('@std/person')
  })

  it('honors a custom resolveName', () => {
    const norm = validateAndNormalizeSchema({ fields: { a: { type: 'ref', ref: '@/person' } } }, '@/x')
    const d = toDataSchemaDeclaration(norm, { name: '@acme/doc', resolveName: () => '@registry/Person' })
    expect(d.sections[briefName(d)].fields.a.model).toBe('@registry/Person')
  })

  it('uses resolveOptions for the full @/x/<section> item_ref path (§10.1)', () => {
    const norm = validateAndNormalizeSchema({ fields: { c: { type: 'string', options: '@/colors' } } }, '@/x')
    const d = toDataSchemaDeclaration(norm, { name: '@acme/doc', resolveOptions: (r) => `${r}/values` })
    expect(d.sections[briefName(d)].fields.c).toEqual({ type: 'item_ref', options: '@/colors/values' })
  })
})

describe('toDataSchemaDeclaration — brief & linkable', () => {
  it('omits linkable when a brief section exists (default true)', () => {
    const d = lower({ fields: { name: { type: 'string' } } }, '@/x', '@acme/x')
    expect(briefName(d)).toBe('x')
    expect(d.sections.x.brief).toBe(true)
    expect(d).not.toHaveProperty('linkable')
  })

  it('emits linkable:false for a brief-less model (no single section)', () => {
    const d = lower(
      { sections: { items: { kind: 'multi', nestable: true, fields: { label: { type: 'string' } } } } },
      '@/nav',
      '@std/nav'
    )
    expect(briefName(d)).toBeUndefined()
    expect(d.linkable).toBe(false)
    expect(d.sections.items).toMatchObject({ multiple: true, self_nesting: true })
  })
})

describe('toDataSchemaDeclaration — nesting → type: section fields', () => {
  const decl = lower(
    {
      fields: {
        name: { type: 'string', required: true },
        social: { type: 'object', fields: { handle: { type: 'string' }, verified: { type: 'bool' } } },
        results: {
          type: 'array',
          items: { type: 'object', fields: { metric: { type: 'string' }, value: { type: 'int' } } },
        },
      },
    },
    '@/x',
    '@acme/profile'
  )
  const fields = decl.sections[briefName(decl)].fields

  it('object field → a nested single section (type: section)', () => {
    expect(fields.social.type).toBe('section')
    expect(fields.social).not.toHaveProperty('multiple') // single
    expect(fields.social.fields.handle).toMatchObject({ type: 'string' })
  })

  it('array-of-object field → a nested multi section', () => {
    expect(fields.results).toMatchObject({ type: 'section', multiple: true })
    expect(fields.results.fields.value).toEqual({ type: 'int' })
  })

  it('keeps plain scalars as leaf fields alongside nested sections', () => {
    expect(fields.name).toMatchObject({ type: 'string', required: true })
  })
})

describe('toDataSchemaDeclaration — sections-form', () => {
  const decl = lower(
    {
      sections: {
        card: { kind: 'single', fields: { title: { type: 'string' } } },
        outline: { kind: 'multi', nestable: true, fields: { heading: { type: 'string' } } },
        meta: { kind: 'single', brief: true, fields: { ref_code: { type: 'string' } } },
      },
    },
    '@/x',
    '@acme/doc'
  )

  it('emits the sections map in declared order', () => {
    expect(Object.keys(decl.sections)).toEqual(['card', 'outline', 'meta'])
  })

  it('marks the brief:true section inline (no schema-level back-reference)', () => {
    expect(briefName(decl)).toBe('meta')
    expect(decl.sections.meta.brief).toBe(true)
    expect(decl.sections.card).not.toHaveProperty('brief')
  })

  it('lowers nestable → self_nesting on a multi section', () => {
    expect(decl.sections.outline).toMatchObject({ multiple: true, self_nesting: true })
  })

  it('infers + stamps the first single as brief when none is marked', () => {
    const d = lower(
      { sections: { a: { kind: 'multi', fields: { x: { type: 'string' } } }, b: { kind: 'single', fields: { y: { type: 'string' } } } } },
      '@/x',
      '@acme/d'
    )
    expect(briefName(d)).toBe('b')
    expect(d.sections.b.brief).toBe(true)
  })
})

describe('toDataSchemaDeclaration — guards', () => {
  it('requires a registry name', () => {
    expect(() => toDataSchemaDeclaration({ fields: {} })).toThrow(/registry name is required/)
  })
})
