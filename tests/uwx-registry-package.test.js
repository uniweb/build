import { buildRegistryPackage } from '../src/uwx/registry-package.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// schema.json shape: _self (identity + config), dataSchemas (normalized, keyed by
// ref), component sections, _layouts. Build a realistic one.
function schemaJson() {
  return {
    _self: {
      name: '@acme/marketing',
      version: '1.2.0',
      role: 'foundation',
      description: 'Acme marketing',
      vars: { '--accent': '#09f' },
      defaultLayout: 'main',
    },
    dataSchemas: {
      '@/article': validateAndNormalizeSchema(
        { fields: { title: { type: 'string', required: true }, status: { type: 'string', enum: ['draft', 'live'] } } },
        '@/article'
      ),
      '@std/person': validateAndNormalizeSchema(
        { fields: { name: { type: 'string', required: true } } },
        '@std/person'
      ),
    },
    Hero: { name: 'Hero', path: 'sections/Hero', title: 'Hero' },
    _layouts: { main: { name: 'main', path: 'layouts/main' } },
  }
}

describe('buildRegistryPackage', () => {
  const doc = buildRegistryPackage({ schema: schemaJson(), exportedAt: '2026-05-24T00:00:00Z' })

  it('produces a uwx/1 envelope with an entities list', () => {
    expect(doc.uwx).toBe(1)
    expect(doc.exporter).toMatchObject({ tool: 'uniweb' })
    expect(doc.exported_at).toBe('2026-05-24T00:00:00Z')
    expect(Array.isArray(doc.entities)).toBe(true)
  })

  it('carries NO uuids anywhere', () => {
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/uuid/i)
    expect(json).not.toContain('model_uuid')
  })

  it('bundles a data-schema entity per DEFINED (@/) schema, not shared ones', () => {
    const dataSchemaEntities = doc.entities.filter((e) => e.model === '@uniweb/data-schema')
    expect(dataSchemaEntities).toHaveLength(1) // @/article only; @std/person not bundled
    expect(dataSchemaEntities[0]).toMatchObject({ model: '@uniweb/data-schema', name: '@/article' })
    expect(dataSchemaEntities[0].sections[0].kind).toBe('single')
    // the lowering ran: enum → a one_of constraint on the section
    expect(dataSchemaEntities[0].sections[0].constraints).toEqual(
      expect.arrayContaining([{ kind: 'one_of', field: 'status', values: ['draft', 'live'] }])
    )
  })

  it('lists the foundation last, with data schemas first (refs resolve)', () => {
    expect(doc.entities[doc.entities.length - 1].model).toBe('@uniweb/foundation-schema')
  })

  describe('the foundation-schema entity', () => {
    const f = doc.entities.find((e) => e.model === '@uniweb/foundation-schema')

    it('decomposes identity into info', () => {
      expect(f.info).toEqual({
        name: '@acme/marketing', version: '1.2.0', role: 'foundation', description: 'Acme marketing',
      })
    })

    it('ships the schema blob WHOLE minus identity and minus dataSchemas', () => {
      expect(f.schema.Hero).toBeTruthy()
      expect(f.schema._layouts).toBeTruthy()
      expect(f.schema.dataSchemas).toBeUndefined() // excluded
      expect(f.schema._self).toEqual({ vars: { '--accent': '#09f' }, defaultLayout: 'main' }) // config kept, identity dropped
      expect(f.schema._self.name).toBeUndefined()
    })

    it('lists every rendered data schema by name (own + shared)', () => {
      expect(f['data-schemas'].refs).toEqual([{ name: '@/article' }, { name: '@std/person' }])
    })

    it('has an empty locales map when no i18n/ dir', () => {
      expect(f.i18n).toEqual({ locales: {} })
    })
  })

  it('requires schema._self with name + version', () => {
    expect(() => buildRegistryPackage({ schema: { _self: {} } })).toThrow(/name \+ version is required/)
  })
})
