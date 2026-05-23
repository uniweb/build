import {
  foundationSchemaToEntity,
  emitFoundationPackage,
  readZip,
  FOUNDATION_MODEL_UUID,
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

describe('uwx/foundation foundationSchemaToEntity', () => {
  it('maps to the @uniweb/foundation-schema Model shape (coarse Sections)', () => {
    const e = foundationSchemaToEntity(sampleSchema())
    expect(e.model_uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(e.owner_uuid).toBeNull()
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)

    // Five single-Item coarse Sections — no per-component/layout/output spread.
    const sections = e.items.map((i) => i.section).sort()
    expect(sections).toEqual([
      'components',
      'config',
      'info',
      'layouts',
      'outputs',
    ])
    for (const s of sections) {
      expect(e.items.filter((i) => i.section === s)).toHaveLength(1)
    }
  })

  it('info carries identity only; role defaults; config/outputs split out', () => {
    const info = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'info'
    ).data
    expect(info.name).toBe('@acme/marketing')
    expect(info.version).toBe('1.2.3')
    expect(info.description).toBe('Marketing foundation')
    expect(info.role).toBe('foundation') // defaulted (absent in schema)
    // Config + outputs live in their own Sections, not info.
    expect(info).not.toHaveProperty('defaultLayout')
    expect(info).not.toHaveProperty('vars')
    expect(info).not.toHaveProperty('outputs')
  })

  it('passes through an explicit extension role', () => {
    const s = sampleSchema()
    s._self.role = 'extension'
    const info = foundationSchemaToEntity(s).items.find(
      (i) => i.section === 'info'
    ).data
    expect(info.role).toBe('extension')
  })

  it('config ships _self minus identity + outputs, whole', () => {
    const config = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'config'
    ).data.schema
    expect(config.defaultLayout).toBe('marketing')
    expect(config.defaultSection).toBe('Hero')
    expect(config.vars).toEqual({ 'brand-color': { default: '#09f' } })
    expect(config.viewTransitions).toEqual({ enabled: true })
    expect(config.xref).toEqual({ registry: 'figures' })
    // Identity + outputs are NOT in config (each has its own Section).
    expect(config).not.toHaveProperty('name')
    expect(config).not.toHaveProperty('version')
    expect(config).not.toHaveProperty('outputs')
  })

  it('components ships the section-type map whole, authored labels intact', () => {
    const components = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'components'
    ).data.schema
    expect(Object.keys(components).sort()).toEqual(['Features', 'Hero'])
    // Labels stay single-language (NOT localized-wrapped); translations ride
    // in the i18n Section later.
    expect(components.Hero.title).toBe('Hero')
    expect(components.Hero.description).toBe('Big banner')
    expect(components.Hero.background).toBe('self')
    // Underscore keys (_self, _layouts) are not components.
    expect(components).not.toHaveProperty('_self')
    expect(components).not.toHaveProperty('_layouts')
  })

  it('layouts ships _layouts whole', () => {
    const layouts = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'layouts'
    ).data.schema
    expect(layouts.marketing.areas).toEqual(['hero', 'main'])
    expect(layouts.marketing.scroll).toBe('self')
    expect(layouts.marketing.title).toBe('Marketing')
  })

  it('outputs ships _self.outputs whole', () => {
    const outputs = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'outputs'
    ).data.schema
    expect(outputs).toEqual({
      typst: { extension: 'zip' },
      pdf: { extension: 'pdf', via: 'typst' },
    })
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

describe('uwx/foundation emitFoundationPackage', () => {
  it('produces a valid @uniweb/foundation-schema .uwx end-to-end', () => {
    const zip = emitFoundationPackage(sampleSchema(), {
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const files = readZip(zip)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))

    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required[0].uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(manifest.models_required[0].name_at_export).toBe(
      '@uniweb/foundation-schema'
    )
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entityFile = `entities/${manifest.roots[0]}.json`
    const entity = JSON.parse(files.get(entityFile).toString('utf8'))
    expect(entity.model_uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(entity.owner_uuid).toBeNull()
    const sections = entity.items.map((i) => i.section).sort()
    expect(sections).toEqual([
      'components',
      'config',
      'info',
      'layouts',
      'outputs',
    ])
  })
})
