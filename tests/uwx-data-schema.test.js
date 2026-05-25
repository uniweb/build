import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// Drive the lowering off the real normalized IR, so the translation and the
// normalizer stay in step. Each test authors a schema, normalizes it, lowers it
// to the @uniweb/data-schema declaration, and asserts the §3 shape.
const lower = (authored, ref, name) =>
  toDataSchemaDeclaration(validateAndNormalizeSchema(authored, ref), { name })

const fieldByKey = (section, key) => section.fields.find((f) => f.key === key)

describe('toDataSchemaDeclaration — fields-form (flat)', () => {
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

  it('carries model attributes and synthesizes one single brief section', () => {
    expect(decl.name).toBe('@acme/article')
    expect(decl.description).toBe('A post')
    expect(decl.sort_date_field).toBe('published')
    expect(decl.brief).toBe('article')
    expect(decl.sections).toHaveLength(1)
    expect(decl.sections[0]).toMatchObject({ name: 'article', kind: 'single' })
  })

  const sec = () => decl.sections[0]

  it('maps scalars 1:1 and required', () => {
    expect(fieldByKey(sec(), 'title')).toMatchObject({ key: 'title', type: 'string', required: true })
    expect(fieldByKey(sec(), 'published')).toEqual({ key: 'published', type: 'date' })
  })

  it('marks human text localized; not machine strings', () => {
    expect(fieldByKey(sec(), 'title').localized).toBe(true) // prose
    expect(fieldByKey(sec(), 'slug').localized).toBeUndefined() // translatable:false
    expect(fieldByKey(sec(), 'status').localized).toBeUndefined() // enum token
    expect(fieldByKey(sec(), 'site').localized).toBeUndefined() // url format
  })

  it('lowers enum → a section one_of constraint, not a field property', () => {
    expect(fieldByKey(sec(), 'status')).toEqual({ key: 'status', type: 'string' })
    expect(sec().constraints).toEqual(
      expect.arrayContaining([{ kind: 'one_of', field: 'status', values: ['draft', 'live'] }])
    )
  })

  it('lowers format → a section format constraint', () => {
    expect(fieldByKey(sec(), 'site')).toEqual({ key: 'site', type: 'string' })
    expect(sec().constraints).toEqual(
      expect.arrayContaining([{ kind: 'format', field: 'site', format: 'url' }])
    )
  })

  it('drops field defaults (they ride in the foundation blob)', () => {
    expect(JSON.stringify(decl)).not.toContain('default')
  })

  it('lowers array-of-scalar → array + element_kind', () => {
    expect(fieldByKey(sec(), 'tags')).toEqual({ key: 'tags', type: 'array', element_kind: 'string' })
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
  const sec = decl.sections[0]

  it('ref → entity_ref with the name resolved into the schema org', () => {
    expect(fieldByKey(sec, 'author')).toEqual({ key: 'author', type: 'entity_ref', models: ['@acme/person'] })
  })

  it('array-of-ref → array element_kind entity_ref', () => {
    expect(fieldByKey(sec, 'editors')).toEqual({
      key: 'editors', type: 'array', element_kind: 'entity_ref', models: ['@acme/person'],
    })
  })

  it('options → item_ref to the resolved model', () => {
    expect(fieldByKey(sec, 'country')).toEqual({ key: 'country', type: 'item_ref', options: '@acme/countries' })
  })

  it('passes a non-self scope through unchanged', () => {
    expect(fieldByKey(sec, 'crossorg').models).toEqual(['@std/person'])
  })

  it('honors a custom resolveName', () => {
    const norm = validateAndNormalizeSchema({ fields: { a: { type: 'ref', ref: '@/person' } } }, '@/x')
    const d = toDataSchemaDeclaration(norm, { name: '@acme/doc', resolveName: () => '@registry/Person' })
    expect(d.sections[0].fields[0].models).toEqual(['@registry/Person'])
  })
})

describe('toDataSchemaDeclaration — nesting → sections', () => {
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
  const root = decl.sections[0]

  it('object field → a child single section (not a field)', () => {
    expect(fieldByKey(root, 'social')).toBeUndefined()
    const social = root.sections.find((s) => s.name === 'social')
    expect(social).toMatchObject({ name: 'social', kind: 'single' })
    expect(fieldByKey(social, 'handle')).toMatchObject({ key: 'handle', type: 'string' })
  })

  it('array-of-object field → a child multi section', () => {
    const results = root.sections.find((s) => s.name === 'results')
    expect(results).toMatchObject({ name: 'results', kind: 'multi' })
    expect(fieldByKey(results, 'value')).toEqual({ key: 'value', type: 'int' })
  })

  it('keeps plain scalars as fields alongside child sections', () => {
    expect(fieldByKey(root, 'name')).toMatchObject({ key: 'name', type: 'string', required: true })
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

  it('emits the section list in order', () => {
    expect(decl.sections.map((s) => s.name)).toEqual(['card', 'outline', 'meta'])
  })

  it('hoists brief:true to the model-level brief', () => {
    expect(decl.brief).toBe('meta')
  })

  it('lowers nestable → self_nesting', () => {
    const outline = decl.sections.find((s) => s.name === 'outline')
    expect(outline).toMatchObject({ kind: 'multi', self_nesting: true })
  })

  it('infers the first single as brief when none is marked', () => {
    const d = lower(
      { sections: { a: { kind: 'multi', fields: { x: { type: 'string' } } }, b: { kind: 'single', fields: { y: { type: 'string' } } } } },
      '@/x',
      '@acme/d'
    )
    expect(d.brief).toBe('b')
  })
})

describe('toDataSchemaDeclaration — guards', () => {
  it('requires a registry name', () => {
    expect(() => toDataSchemaDeclaration({ fields: {} })).toThrow(/registry name is required/)
  })
})
