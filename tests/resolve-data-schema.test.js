import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateAndNormalizeSchema,
  collectNestedRefs,
  buildDataSchemaMap,
  resolveSchemaRef,
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
    // `markdown` lowers to text + format (the retired `richtext` kind's replacement)
    expect(out.fields.body).toEqual({ type: 'text', format: 'markdown' })
    expect(out.fields.photo.type).toBe('file')
    // url/email lower to string + format
    expect(out.fields.site).toEqual({ type: 'string', format: 'url' })
    expect(out.fields.email).toEqual({ type: 'string', format: 'email' })
    // carry-through preserved
    expect(out.fields.name.required).toBe(true)
    expect(out.fields.price.default).toBe(0)
  })

  it('lowers the rich-content aliases (markdown/html) and the retired richtext to text + format', () => {
    const out = validateAndNormalizeSchema(
      {
        fields: {
          md: { type: 'markdown' },
          page: { type: 'html' },
          // `richtext` is retired as a kind (2026-06-02) but kept as a back-compat
          // alias → text + format: markdown (so pre-migration schemas still register).
          legacy: { type: 'richtext' },
          // an explicit text + format passes through verbatim
          prose: { type: 'text', format: 'markdown' },
        },
      },
      '@/x'
    )
    expect(out.fields.md).toEqual({ type: 'text', format: 'markdown' })
    expect(out.fields.page).toEqual({ type: 'text', format: 'html' })
    expect(out.fields.legacy).toEqual({ type: 'text', format: 'markdown' })
    expect(out.fields.prose).toEqual({ type: 'text', format: 'markdown' })
  })

  it('`prose` is the rich-document alias → json + format: prosemirror', () => {
    const out = validateAndNormalizeSchema({ fields: { body: 'prose', note: { type: 'prose' } } }, '@/x')
    expect(out.fields.body).toEqual({ type: 'json', format: 'prosemirror' })
    expect(out.fields.note).toEqual({ type: 'json', format: 'prosemirror' })
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

  it('carries append_only on a multi section into the IR', () => {
    const out = validateAndNormalizeSchema(
      { sections: { activity: { kind: 'multi', append_only: true, fields: { event: { type: 'string' } } } } },
      '@/log'
    )
    expect(out.sections.activity.append_only).toBe(true)
  })
})

describe('validateAndNormalizeSchema — friendly cardinality sugar', () => {
  it('a section is single by default; `many: true` makes it a list', () => {
    const out = validateAndNormalizeSchema(
      {
        sections: {
          identity: { brief: true, fields: { title: 'string' } },
          modules: { many: true, fields: { title: 'string' } },
        },
      },
      '@/course'
    )
    expect(out.sections.identity.kind).toBe('single')
    expect(out.sections.identity.brief).toBe(true)
    expect(out.sections.modules.kind).toBe('multi')
  })

  it('infers a binder from a section with only child sections (no fields)', () => {
    const out = validateAndNormalizeSchema(
      { sections: { contributions: { sections: { publications: { many: true, fields: { title: 'string' } } } } } },
      '@/cv'
    )
    expect(out.sections.contributions.kind).toBe('binder')
    expect(out.sections.contributions.sections.publications.kind).toBe('multi')
  })

  it('`{ ref }` infers a reference; `{ ref, many: true }` a list of refs', () => {
    const out = validateAndNormalizeSchema(
      {
        fields: {
          instructor: { ref: '@std/person' },
          prerequisites: { ref: '@/course', many: true },
        },
      },
      '@/course'
    )
    expect(out.fields.instructor).toEqual({ type: 'ref', ref: '@std/person' })
    expect(out.fields.prerequisites).toEqual({ type: 'array', items: { type: 'ref', ref: '@/course' } })
  })

  it('`{ type, many: true }` is a list of scalars; `{ options }` infers a picklist value', () => {
    const out = validateAndNormalizeSchema(
      { fields: { tags: { type: 'string', many: true }, country: { options: '@/countries' } } },
      '@/x'
    )
    expect(out.fields.tags).toEqual({ type: 'array', items: { type: 'string' } })
    expect(out.fields.country).toEqual({ type: 'string', options: '@/countries' })
  })

  it('`many` lifts collection metadata (required) onto the array, type onto items', () => {
    const out = validateAndNormalizeSchema(
      { fields: { authors: { ref: '@/person', many: true, required: true } } },
      '@/paper'
    )
    expect(out.fields.authors).toEqual({
      type: 'array',
      required: true,
      items: { type: 'ref', ref: '@/person' },
    })
  })

  it('`tree: true` on a `many` section → self-nesting (nestable IR)', () => {
    const out = validateAndNormalizeSchema(
      { sections: { outline: { many: true, tree: true, fields: { heading: 'string' } } } },
      '@/doc'
    )
    expect(out.sections.outline.kind).toBe('multi')
    expect(out.sections.outline.nestable).toBe(true)
  })

  it('rejects `tree` on a non-list section', () => {
    expect(() =>
      validateAndNormalizeSchema({ sections: { a: { tree: true, fields: { x: 'string' } } } }, '@/x')
    ).toThrow(/only a 'many: true' section can form a tree/)
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
  it('rejects a content format on the wrong base kind (per-shape registration)', () => {
    // markdown/html only on text; prosemirror only on json (uwx-format.md §3).
    expect(bad({ fields: { x: { type: 'string', format: 'markdown' } } })).toThrow(
      /format 'markdown', valid only on a 'text' field/
    )
    expect(bad({ fields: { x: { type: 'string', format: 'prosemirror' } } })).toThrow(
      /format 'prosemirror', valid only on a 'json' field/
    )
  })
  it('requires nested fields on an object', () => {
    expect(bad({ fields: { x: { type: 'object' } } })).toThrow(/object field 'x' must declare nested 'fields'/)
  })
  it('requires a target on a ref', () => {
    expect(bad({ fields: { x: { type: 'ref' } } })).toThrow(/ref field 'x' must name a target/)
  })
  it('rejects append_only on a non-multi section', () => {
    expect(
      bad({ sections: { a: { kind: 'single', append_only: true, fields: { x: { type: 'string' } } } } })
    ).toThrow(/only a 'many: true' section can be append-only/)
  })
  it('rejects a non-boolean append_only', () => {
    expect(
      bad({ sections: { a: { kind: 'multi', append_only: 'yes', fields: { x: { type: 'string' } } } } })
    ).toThrow(/'append_only' must be a boolean/)
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
          sessions: { type: 'array', items: { type: 'object', fields: { who: { type: 'ref', ref: '@std/person' } } } },
        },
      },
      '@/event'
    )
    expect(collectNestedRefs(schema).sort()).toEqual(['@/currencies', '@/person', '@std/person'])
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

describe('resolveSchemaRef — org scope resolution', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-scope-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-foundation', version: '1.0.0' }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Install a fake '@<scope>/schemas' package into a foundation's node_modules,
  // exporting schemas the way '@uniweb/schemas' does (getSchema + schemas map).
  const installSchemaPackage = (srcDir, pkgName, schemas) => {
    const pkgDir = join(srcDir, 'node_modules', ...pkgName.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '1.0.0', type: 'module', main: 'index.js' })
    )
    writeFileSync(
      join(pkgDir, 'index.js'),
      `export const schemas = ${JSON.stringify(schemas)}\n` + `export function getSchema(n) { return schemas[n] }\n`
    )
  }

  it("resolves '@org/name' from the org's '@org/schemas' package", async () => {
    installSchemaPackage(dir, '@acme/schemas', {
      person: { name: 'person', fields: { name: { type: 'string', required: true } } },
    })
    const out = await resolveSchemaRef('@acme/person', { srcDir: dir })
    expect(out.name).toBe('person')
    expect(out.fields.name).toEqual({ type: 'string', required: true })
  })

  it('lets multiple foundations share one org schema set (cross-foundation)', async () => {
    const schemas = { event: { name: 'event', fields: { title: { type: 'string' } } } }
    const foundationB = mkdtempSync(join(tmpdir(), 'ds-scope-b-'))
    writeFileSync(join(foundationB, 'package.json'), JSON.stringify({ name: 'foundation-b', version: '1.0.0' }))
    try {
      installSchemaPackage(dir, '@acme/schemas', schemas)
      installSchemaPackage(foundationB, '@acme/schemas', schemas)
      const a = await resolveSchemaRef('@acme/event', { srcDir: dir })
      const b = await resolveSchemaRef('@acme/event', { srcDir: foundationB })
      expect(a).toEqual(b)
      expect(a.name).toBe('event')
    } finally {
      rmSync(foundationB, { recursive: true, force: true })
    }
  })

  it("rejects '@uniweb/<name>' as the reserved system namespace, pointing to '@std'", async () => {
    await expect(resolveSchemaRef('@uniweb/person', { srcDir: dir })).rejects.toThrow(
      /reserved platform system namespace.*Use '@std\/person'/
    )
  })

  it('throws a clear error when the org schema package is not installed', async () => {
    await expect(resolveSchemaRef('@acme/person', { srcDir: dir })).rejects.toThrow(
      /'@acme\/schemas' is not installed/
    )
  })
})
