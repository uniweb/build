import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateAndNormalizeSchema,
  collectNestedRefs,
  buildDataSchemaMap,
} from '../src/resolve-data-schema.js'

describe('validateAndNormalizeSchema — valid', () => {
  it('normalizes the friendly type aliases to canonical kinds', () => {
    const out = validateAndNormalizeSchema(
      {
        name: 'product',
        version: '1.0.0',
        fields: {
          name: { type: 'string', required: true },
          price: { type: 'number', default: 0 },
          rank: { type: 'integer' },
          live: { type: 'boolean', default: true },
          body: { type: 'markdown' },
          photo: { type: 'image' },
          site: { type: 'url' },
          email: { type: 'email' },
        },
      },
      '@/product'
    )
    expect(out.fields.price.type).toBe('decimal')
    expect(out.fields.rank.type).toBe('int')
    expect(out.fields.live.type).toBe('bool')
    expect(out.fields.body.type).toBe('richtext')
    expect(out.fields.photo.type).toBe('file')
    // url/email lower to string + format
    expect(out.fields.site).toEqual({ type: 'string', format: 'url' })
    expect(out.fields.email).toEqual({ type: 'string', format: 'email' })
    // carry-through preserved
    expect(out.fields.name.required).toBe(true)
    expect(out.fields.price.default).toBe(0)
  })

  it('accepts a bare type-string shorthand and inline enum', () => {
    const out = validateAndNormalizeSchema(
      { fields: { slug: 'string', currency: { type: 'string', enum: ['USD', 'EUR'] } } },
      '@/x'
    )
    expect(out.fields.slug).toEqual({ type: 'string' })
    expect(out.fields.currency.enum).toEqual(['USD', 'EUR'])
  })

  it('normalizes nested object, array-of-object, and ref', () => {
    const out = validateAndNormalizeSchema(
      {
        fields: {
          location: { type: 'object', fields: { city: { type: 'string' } } },
          sessions: {
            type: 'array',
            items: { type: 'object', fields: { speaker: { type: 'ref', ref: '@/person' } } },
          },
          tags: { type: 'array', items: { type: 'string' } },
          curated: { type: 'string', options: '@/currencies' },
        },
      },
      '@/event'
    )
    expect(out.fields.location.fields.city.type).toBe('string')
    expect(out.fields.sessions.items.fields.speaker).toEqual({ type: 'ref', ref: '@/person' })
    expect(out.fields.tags.items.type).toBe('string')
    expect(out.fields.curated.options).toBe('@/currencies')
  })

  it('accepts the sections form with one brief single section', () => {
    const out = validateAndNormalizeSchema(
      {
        sections: {
          details: { kind: 'single', brief: true, fields: { title: { type: 'string' } } },
          comments: { kind: 'multi', nestable: true, fields: { body: { type: 'text' } } },
        },
      },
      '@/post'
    )
    expect(out.sections.details.brief).toBe(true)
    expect(out.sections.comments.kind).toBe('multi')
  })
})

describe('validateAndNormalizeSchema — errors', () => {
  const bad = (schema, ref = '@/x') => () => validateAndNormalizeSchema(schema, ref)

  it('rejects a non-object schema', () => {
    expect(bad(null)).toThrow(/did not export a schema object/)
  })
  it('requires fields or sections', () => {
    expect(bad({ name: 'x' })).toThrow(/must declare 'fields' or 'sections'/)
  })
  it('rejects both fields and sections', () => {
    expect(bad({ fields: {}, sections: {} })).toThrow(/not both/)
  })
  it('rejects an unknown field type', () => {
    expect(bad({ fields: { x: { type: 'colour' } } })).toThrow(/unknown type 'colour'/)
  })
  it('requires nested fields on an object', () => {
    expect(bad({ fields: { x: { type: 'object' } } })).toThrow(/object field 'x' must declare nested 'fields'/)
  })
  it('requires a target on a ref', () => {
    expect(bad({ fields: { x: { type: 'ref' } } })).toThrow(/ref field 'x' must name a target/)
  })
  it('rejects array-style options (steers to enum)', () => {
    expect(bad({ fields: { x: { type: 'string', options: ['a', 'b'] } } })).toThrow(/use 'enum:'/)
  })
  it('rejects more than one brief section', () => {
    expect(
      bad({
        sections: {
          a: { kind: 'single', brief: true, fields: { t: 'string' } },
          b: { kind: 'single', brief: true, fields: { t: 'string' } },
        },
      })
    ).toThrow(/more than one section marked 'brief: true'/)
  })
  it('rejects a binder with fields', () => {
    expect(bad({ sections: { a: { kind: 'binder', fields: { t: 'string' } } } })).toThrow(
      /binder section .* carries only child 'sections'/
    )
  })
})

describe('collectNestedRefs', () => {
  it('finds ref and options targets across nesting', () => {
    const schema = validateAndNormalizeSchema(
      {
        fields: {
          author: { type: 'ref', ref: '@/person' },
          currency: { type: 'string', options: '@/currencies' },
          sessions: { type: 'array', items: { type: 'object', fields: { who: { type: 'ref', ref: '@uniweb/person' } } } },
        },
      },
      '@/event'
    )
    expect(collectNestedRefs(schema).sort()).toEqual(['@/currencies', '@/person', '@uniweb/person'])
  })
})

describe('buildDataSchemaMap — transitive resolution', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-'))
    mkdirSync(join(dir, 'schemas'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name, body) => writeFileSync(join(dir, 'schemas', `${name}.yml`), body)

  it('closes the graph over ref targets', async () => {
    write('event', 'name: event\nfields:\n  speaker: { type: ref, ref: "@/person" }\n')
    write('person', 'name: person\nfields:\n  name: { type: string }\n')
    const map = await buildDataSchemaMap(new Set(['@/event']), { srcDir: dir })
    expect(Object.keys(map).sort()).toEqual(['@/event', '@/person'])
  })

  it('throws naming an unresolvable target', async () => {
    write('event', 'name: event\nfields:\n  speaker: { type: ref, ref: "@/missing" }\n')
    await expect(buildDataSchemaMap(new Set(['@/event']), { srcDir: dir })).rejects.toThrow(
      /Data schema '@\/missing' not found/
    )
  })
})
