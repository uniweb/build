import { validateItem, isStaticallyCheckable } from '../src/validate-data.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// Validate against the SAME normalized shape the build produces, so the checker
// and the normalizer are exercised against one definition of each kind.
const project = validateAndNormalizeSchema(
  {
    name: 'project',
    fields: {
      name: { type: 'string', required: true },
      status: { type: 'string', enum: ['active', 'archived'], default: 'active' },
      url: { type: 'url' },
      featured: { type: 'boolean', default: false },
      rank: { type: 'integer' },
    },
  },
  '@acme/project'
)

const rules = (vs) => vs.map((v) => v.rule)
const fields = (vs) => vs.map((v) => v.field)

describe('validateItem — scalar facets', () => {
  it('passes a fully conformant item', () => {
    expect(validateItem(project, { slug: 'a', name: 'Atlas', status: 'active', url: 'https://atlas.io' })).toEqual([])
  })

  it('flags a missing required field', () => {
    const out = validateItem(project, { slug: 'a', status: 'active' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'name', rule: 'required' })
  })

  it('does NOT flag an absent optional field (default fills it)', () => {
    // `status` and `featured` omitted — both have defaults; not a violation.
    expect(validateItem(project, { slug: 'a', name: 'Atlas' })).toEqual([])
  })

  it('does NOT flag a field equal to its default', () => {
    expect(validateItem(project, { slug: 'a', name: 'Atlas', status: 'active', featured: false })).toEqual([])
  })

  it('flags an enum value outside the allowed set — as enum, not also type', () => {
    const out = validateItem(project, { slug: 'a', name: 'Atlas', status: 42 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'status', rule: 'enum' })
    expect(out[0].message).toContain('active')
  })

  it('flags a type mismatch on a boolean', () => {
    const out = validateItem(project, { slug: 'a', name: 'Atlas', featured: 'yes' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'featured', rule: 'type' })
  })

  it('flags a non-integer for an int field', () => {
    expect(rules(validateItem(project, { name: 'a', rank: 1.5 }))).toEqual(['type'])
    expect(validateItem(project, { name: 'a', rank: 3 })).toEqual([])
  })

  it('ignores unknown / extra fields (runtime tolerates them)', () => {
    expect(validateItem(project, { name: 'Atlas', extra: 'x', another: 123 })).toEqual([])
  })
})

describe('validateItem — format', () => {
  const withFormats = validateAndNormalizeSchema(
    { fields: { site: { type: 'url' }, email: { type: 'email' } } },
    '@/x'
  )

  it('accepts valid url and email', () => {
    expect(validateItem(withFormats, { site: 'https://example.com/x', email: 'a@b.co' })).toEqual([])
  })

  it('accepts lenient url shapes authors actually write', () => {
    for (const site of ['example.com', '/local/path', '//cdn.site.io/a', 'sub.domain.io/path']) {
      expect(validateItem(withFormats, { site })).toEqual([])
    }
  })

  it('flags garbage url and malformed email', () => {
    expect(rules(validateItem(withFormats, { site: 'not a url' }))).toEqual(['format'])
    expect(rules(validateItem(withFormats, { email: 'nope' }))).toEqual(['format'])
  })
})

describe('validateItem — nested structures', () => {
  const nested = validateAndNormalizeSchema(
    {
      fields: {
        name: { type: 'string', required: true },
        social: { type: 'object', fields: { handle: { type: 'string', required: true } } },
        tags: { type: 'array', items: { type: 'string' } },
        results: {
          type: 'array',
          items: { type: 'object', fields: { metric: { type: 'string', required: true } } },
        },
      },
    },
    '@/x'
  )

  it('passes conformant nested data', () => {
    expect(
      validateItem(nested, { name: 'a', social: { handle: 'x' }, tags: ['p', 'q'], results: [{ metric: 'm' }] })
    ).toEqual([])
  })

  it('flags a missing required field inside a nested object (dotted path)', () => {
    const out = validateItem(nested, { name: 'a', social: {} })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'social.handle', rule: 'required' })
  })

  it('flags a non-object given to an object field', () => {
    expect(fields(validateItem(nested, { name: 'a', social: 'oops' }))).toEqual(['social'])
    expect(rules(validateItem(nested, { name: 'a', social: 'oops' }))).toEqual(['type'])
  })

  it('flags a wrong element type in an array of scalars (indexed path)', () => {
    const out = validateItem(nested, { name: 'a', tags: ['ok', 5] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'tags[1]', rule: 'type' })
  })

  it('recurses into an array of objects (indexed dotted path)', () => {
    const out = validateItem(nested, { name: 'a', results: [{ metric: 'm' }, {}] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'results[1].metric', rule: 'required' })
  })

  it('flags a non-array given to an array field', () => {
    expect(rules(validateItem(nested, { name: 'a', tags: 'notarray' }))).toEqual(['type'])
  })
})

describe('validateItem — references are required-only, value deferred', () => {
  const withRefs = validateAndNormalizeSchema(
    {
      fields: {
        owner: { type: 'ref', ref: '@/person', required: true },
        related: { type: 'ref', ref: '@/person' },
        currency: { type: 'string', options: '@/currencies' },
      },
    },
    '@/x'
  )

  it('flags a missing required ref', () => {
    expect(validateItem(withRefs, {})).toMatchObject([{ field: 'owner', rule: 'required' }])
  })

  it('does not check the value of a present ref (no backend graph)', () => {
    expect(validateItem(withRefs, { owner: 'jane' })).toEqual([])
    expect(validateItem(withRefs, { owner: { any: 'shape' } })).toEqual([])
  })

  it('defers the value of an options (item_ref) field', () => {
    expect(validateItem(withRefs, { owner: 'x', currency: 'whatever' })).toEqual([])
  })
})

describe('validateItem — date handling', () => {
  const withDate = validateAndNormalizeSchema({ fields: { when: { type: 'date' } } }, '@/x')

  it('accepts an ISO string (JSON) and a Date object (YAML)', () => {
    expect(validateItem(withDate, { when: '2024-01-01' })).toEqual([])
    expect(validateItem(withDate, { when: new Date('2024-01-01') })).toEqual([])
  })

  it('flags a number for a date field', () => {
    expect(rules(validateItem(withDate, { when: 1234 }))).toEqual(['type'])
  })
})

describe('validateItem — sections-form is deferred upstream', () => {
  const rich = validateAndNormalizeSchema(
    { sections: { profile: { kind: 'single', fields: { name: { type: 'string', required: true } } } } },
    '@std/nav'
  )

  it('returns no findings for a sections-form schema (rich model)', () => {
    expect(validateItem(rich, {})).toEqual([])
  })

  it('isStaticallyCheckable: fields-form yes, sections-form no', () => {
    expect(isStaticallyCheckable(project)).toBe(true)
    expect(isStaticallyCheckable(rich)).toBe(false)
    expect(isStaticallyCheckable(null)).toBe(false)
  })
})

describe('validateItem — robustness', () => {
  it('treats a null/undefined item as all-required-missing without throwing', () => {
    expect(rules(validateItem(project, null))).toEqual(['required'])
    expect(rules(validateItem(project, undefined))).toEqual(['required'])
  })
})
