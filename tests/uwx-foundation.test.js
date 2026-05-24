import {
  foundationSchemaToEntity,
  emitFoundationSchemaPackage,
  readZip,
  FOUNDATION_SCHEMA_TYPE_UUID,
} from '../src/uwx/index.js'

// Shaped exactly like framework/build/src/schema.js::buildSchema output.
function sampleSchema(overrides = {}) {
  return {
    _self: {
      name: '@acme/marketing',
      version: '1.2.3',
      description: 'Marketing foundation',
      defaultLayout: 'marketing',
      defaultSection: 'Hero',
      vars: { 'brand-color': { default: '#09f' } },
      props: { spacing: 'lg' },
      handlers: { data: 'loomData' },
      viewTransitions: { enabled: true },
      defaultInsets: { Gallery: { cols: 3 } },
      xref: { registry: 'figures' },
      outputs: {
        typst: { extension: 'zip' },
        pdf: { extension: 'pdf', via: 'typst' },
      },
      // no `role` → primary foundation → must default to "foundation"
    },
    dataSchemas: {
      '@/article': {
        name: 'article',
        version: '1.0.0',
        description: 'A blog post',
        fields: { title: { type: 'string', default: '' } },
      },
      '@uniweb/person': {
        name: 'person',
        version: '2.1.0',
        fields: { name: { type: 'string', default: '' } },
      },
    },
    _layouts: {
      marketing: {
        name: 'marketing',
        path: 'layouts/marketing',
        title: 'Marketing',
        areas: ['hero', 'main'],
        scroll: 'self',
        params: {},
      },
    },
    Hero: {
      name: 'Hero',
      path: 'sections/Hero',
      title: 'Hero',
      description: 'Big banner',
      category: 'impact',
      initialState: { open: false },
      background: 'self',
    },
    Features: {
      name: 'Features',
      path: 'sections/Features',
      title: 'Features',
    },
    ...overrides,
  }
}

const sectionData = (e, name) =>
  e.items.find((i) => i.section === name).data

describe('uwx/foundation foundationSchemaToEntity', () => {
  it('maps to the @uniweb/foundation-schema entity-type shape (4 coarse Sections)', () => {
    const e = foundationSchemaToEntity(sampleSchema())
    expect(e.model_uuid).toBe(FOUNDATION_SCHEMA_TYPE_UUID)
    expect(e.owner_uuid).toBeNull()
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)

    // Four single-Item Sections per foundation-schema.fixture.yaml — the old
    // config/components/layouts/outputs collapsed into one `schema` blob.
    const sections = e.items.map((i) => i.section).sort()
    expect(sections).toEqual(['data-schemas', 'i18n', 'info', 'schema'])
    for (const s of sections) {
      expect(e.items.filter((i) => i.section === s)).toHaveLength(1)
    }
  })

  it('info carries identity only; role defaults', () => {
    const info = sectionData(foundationSchemaToEntity(sampleSchema()), 'info')
    expect(info.name).toBe('@acme/marketing')
    expect(info.version).toBe('1.2.3')
    expect(info.description).toBe('Marketing foundation')
    expect(info.role).toBe('foundation') // defaulted (absent in schema)
    // Everything non-identity lives in the `schema` blob, not info.
    expect(info).not.toHaveProperty('defaultLayout')
    expect(info).not.toHaveProperty('vars')
    expect(info).not.toHaveProperty('outputs')
  })

  it('passes through an explicit extension role', () => {
    const s = sampleSchema()
    s._self.role = 'extension'
    expect(sectionData(foundationSchemaToEntity(s), 'info').role).toBe(
      'extension'
    )
  })

  it('schema ships the whole renderable schema MINUS identity and dataSchemas', () => {
    const blob = sectionData(foundationSchemaToEntity(sampleSchema()), 'schema')
      .schema

    // Foundation-wide config (formerly `config`) — under _self, identity stripped.
    expect(blob._self.defaultLayout).toBe('marketing')
    expect(blob._self.vars).toEqual({ 'brand-color': { default: '#09f' } })
    expect(blob._self.xref).toEqual({ registry: 'figures' })
    // Output formats (formerly `outputs`) ride along inside _self.
    expect(blob._self.outputs.pdf).toEqual({ extension: 'pdf', via: 'typst' })
    // Identity is stripped from _self.
    expect(blob._self).not.toHaveProperty('name')
    expect(blob._self).not.toHaveProperty('version')
    expect(blob._self).not.toHaveProperty('description')
    expect(blob._self).not.toHaveProperty('role')

    // Components (formerly `components`) ship whole, authored labels intact.
    expect(blob.Hero.title).toBe('Hero')
    expect(blob.Hero.background).toBe('self')
    expect(blob.Features.title).toBe('Features')

    // Layouts (formerly `layouts`) ride along.
    expect(blob._layouts.marketing.areas).toEqual(['hero', 'main'])

    // dataSchemas is NOT in the blob — it becomes the `models` Section.
    expect(blob).not.toHaveProperty('dataSchemas')
  })

  it('data-schemas carries the deduped refs BY NAME, sorted, no uuid', () => {
    const refs = sectionData(
      foundationSchemaToEntity(sampleSchema()),
      'data-schemas'
    ).refs
    // References are names only — the server resolves them to Models.
    expect(refs).toEqual([{ name: '@/article' }, { name: '@uniweb/person' }])
  })

  it('data-schemas is empty refs when the foundation declares no data schemas', () => {
    const s = sampleSchema()
    delete s.dataSchemas
    expect(
      sectionData(foundationSchemaToEntity(s), 'data-schemas').refs
    ).toEqual([])
  })

  it('i18n locales is empty without a foundationDir', () => {
    expect(sectionData(foundationSchemaToEntity(sampleSchema()), 'i18n')).toEqual(
      { locales: {} }
    )
  })

  it('pins the Entity uuid when given (identity hook)', () => {
    const u = '019e2400-0000-7000-8000-000000000000'
    expect(
      foundationSchemaToEntity(sampleSchema(), { entityUuid: u }).uuid
    ).toBe(u)
  })

  it('throws when _self/name/version is missing', () => {
    expect(() => foundationSchemaToEntity({})).toThrow()
    expect(() => foundationSchemaToEntity({ _self: { name: 'x' } })).toThrow()
  })
})

describe('uwx/foundation emitFoundationSchemaPackage', () => {
  it('produces a valid @uniweb/foundation-schema .uwx end-to-end', () => {
    const zip = emitFoundationSchemaPackage(sampleSchema(), {
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const files = readZip(zip)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))

    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required[0].uuid).toBe(FOUNDATION_SCHEMA_TYPE_UUID)
    expect(manifest.models_required[0].name_at_export).toBe(
      '@uniweb/foundation-schema'
    )
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entityFile = `entities/${manifest.roots[0]}.json`
    const entity = JSON.parse(files.get(entityFile).toString('utf8'))
    expect(entity.model_uuid).toBe(FOUNDATION_SCHEMA_TYPE_UUID)
    expect(entity.owner_uuid).toBeNull()
    const sections = entity.items.map((i) => i.section).sort()
    expect(sections).toEqual(['data-schemas', 'i18n', 'info', 'schema'])
  })
})
