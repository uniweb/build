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
      openExtraKey: 'must be dropped (closed contract)',
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
        entryFile: 'marketing.jsx', // executable plumbing → must be dropped
      },
    },
    Hero: {
      name: 'Hero',
      path: 'sections/Hero',
      title: 'Hero',
      description: 'Big banner',
      category: 'impact',
      initialState: { open: false },
      inheritData: ['articles'],
      inset: false,
      background: 'self',
      hidden: false,
      metaExtraKey: 'must be dropped',
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
  it('maps to the @uniweb/foundation Model shape', () => {
    const e = foundationSchemaToEntity(sampleSchema())
    expect(e.model_uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(e.owner_uuid).toBeNull()
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)

    const bySection = (s) => e.items.filter((i) => i.section === s)
    expect(bySection('info')).toHaveLength(1)
    expect(bySection('section_types')).toHaveLength(2)
    expect(bySection('layouts')).toHaveLength(1)
    expect(bySection('outputs')).toHaveLength(2)
  })

  it('maps info with camel→snake, role default, and drops open keys', () => {
    const info = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'info'
    ).data
    expect(info.name).toBe('@acme/marketing')
    expect(info.version).toBe('1.2.3')
    expect(info.role).toBe('foundation') // defaulted (absent in schema)
    expect(info.default_layout).toBe('marketing')
    expect(info.default_section).toBe('Hero')
    expect(info.view_transitions).toEqual({ enabled: true })
    expect(info.default_insets).toEqual({ Gallery: { cols: 3 } })
    expect(info.xref).toEqual({ registry: 'figures' })
    expect(info).not.toHaveProperty('openExtraKey') // dropped by design
    expect(info).not.toHaveProperty('outputs') // separate Section
  })

  it('passes through an explicit extension role', () => {
    const s = sampleSchema()
    s._self.role = 'extension'
    const info = foundationSchemaToEntity(s).items.find(
      (i) => i.section === 'info'
    ).data
    expect(info.role).toBe('extension')
  })

  it('maps section_types with localized title and snake_case, drops extras', () => {
    const hero = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'section_types' && i.data.name === 'Hero'
    ).data
    expect(hero.title).toEqual({ en: 'Hero' }) // localized wrap
    expect(hero.description).toEqual({ en: 'Big banner' })
    expect(hero.initial_state).toEqual({ open: false }) // initialState→snake
    expect(hero.inherit_data).toEqual(['articles'])
    expect(hero.background).toBe('self')
    expect(hero.inset).toBe(false)
    expect(hero).not.toHaveProperty('metaExtraKey') // dropped
    expect(hero).not.toHaveProperty('initialState') // only snake form
  })

  it('orders section_types items by discovery order', () => {
    const st = foundationSchemaToEntity(sampleSchema())
      .items.filter((i) => i.section === 'section_types')
      .sort((a, b) => a.order_number - b.order_number)
      .map((i) => i.data.name)
    expect(st).toEqual(['Hero', 'Features'])
  })

  it('maps layouts and drops entryFile (executable plumbing)', () => {
    const lay = foundationSchemaToEntity(sampleSchema()).items.find(
      (i) => i.section === 'layouts'
    ).data
    expect(lay.name).toBe('marketing')
    expect(lay.areas).toEqual(['hero', 'main'])
    expect(lay.scroll).toBe('self')
    expect(lay.title).toEqual({ en: 'Marketing' })
    expect(lay).not.toHaveProperty('entryFile')
  })

  it('maps _self.outputs to outputs Items (getOptions already JSON-stripped)', () => {
    const outs = foundationSchemaToEntity(sampleSchema())
      .items.filter((i) => i.section === 'outputs')
      .map((i) => i.data)
    expect(outs).toEqual([
      { format: 'typst', extension: 'zip' },
      { format: 'pdf', extension: 'pdf', via: 'typst' },
    ])
  })

  it('honors a sourceLocale override', () => {
    const hero = foundationSchemaToEntity(sampleSchema(), {
      sourceLocale: 'fr',
    }).items.find(
      (i) => i.section === 'section_types' && i.data.name === 'Hero'
    ).data
    expect(hero.title).toEqual({ fr: 'Hero' })
  })

  it('pins the Entity uuid when given (identity hook)', () => {
    const u = '019e2400-0000-7000-8000-000000000000'
    expect(foundationSchemaToEntity(sampleSchema(), { entityUuid: u }).uuid).toBe(
      u
    )
  })

  it('throws when _self/name/version is missing', () => {
    expect(() => foundationSchemaToEntity({})).toThrow()
    expect(() => foundationSchemaToEntity({ _self: { name: 'x' } })).toThrow()
  })
})

describe('uwx/foundation emitFoundationPackage', () => {
  it('produces a valid @uniweb/foundation .uwx end-to-end', () => {
    const zip = emitFoundationPackage(sampleSchema(), {
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const files = readZip(zip)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))

    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required[0].uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(manifest.models_required[0].name_at_export).toBe('@uniweb/foundation')
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entityFile = `entities/${manifest.roots[0]}.json`
    const entity = JSON.parse(files.get(entityFile).toString('utf8'))
    expect(entity.model_uuid).toBe(FOUNDATION_MODEL_UUID)
    expect(entity.owner_uuid).toBeNull()
    expect(entity.items.some((i) => i.section === 'info')).toBe(true)
    expect(
      entity.items.filter((i) => i.section === 'section_types')
    ).toHaveLength(2)
  })
})
