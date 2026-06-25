import { buildRegistryPackage, buildSchemaOnlyPackage } from '../src/uwx/registry-package.js'
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
    const article = Object.values(dataSchemaEntities[0].sections).find((s) => s.brief)
    expect(article).toBeTruthy() // a single brief section
    // the lowering ran: enum stays ON the field (the backend relocates it to a
    // one_of section constraint at ingest).
    expect(article.fields.status.enum).toEqual(['draft', 'live'])
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

    it('omits info.digest when no digest is supplied', () => {
      expect(f.info.digest).toBeUndefined()
    })
  })

  it('threads a supplied content digest into the foundation-schema info', () => {
    const withDigest = buildRegistryPackage({ schema: schemaJson(), digest: 'sha256:deadbeef' })
    const fe = withDigest.entities.find((e) => e.model === '@uniweb/foundation-schema')
    expect(fe.info.digest).toBe('sha256:deadbeef')
  })

  it('requires schema._self with name + version', () => {
    expect(() => buildRegistryPackage({ schema: { _self: {} } })).toThrow(/name \+ version is required/)
  })

  it('resolves item_ref options to the full @/x/<section> path (§10.1)', () => {
    const schema = {
      _self: { name: '@acme/f', version: '1.0.0' },
      dataSchemas: {
        '@/post': validateAndNormalizeSchema({ fields: { cat: { type: 'string', options: '@/categories' } } }, '@/post'),
        '@/categories': validateAndNormalizeSchema({ fields: { label: { type: 'string' } } }, '@/categories'),
      },
    }
    const post = buildRegistryPackage({ schema }).entities.find((e) => e.name === '@/post')
    const postBrief = Object.values(post.sections).find((s) => s.brief)
    expect(postBrief.fields.cat).toEqual({ type: 'item_ref', options: '@/categories/categories' })
  })
})

// ── The foundation-LESS variant: a schemas-only package (uwx-format §2/§5) ────
// `buildSchemaOnlyPackage` shares the data-schema lowering with the foundation
// publish but emits NO foundation-schema entity — the shape `uniweb register`
// submits for a schemas package (e.g. the standards under @std).
describe('buildSchemaOnlyPackage (foundation-less — schemas only)', () => {
  // The discovery output shape: { '@/<name>': normalizedSchema }.
  function schemaMap() {
    return {
      '@/person': validateAndNormalizeSchema(
        { fields: { name: { type: 'string', required: true }, email: { type: 'email' } } },
        '@/person'
      ),
      '@/article': validateAndNormalizeSchema(
        { fields: { title: { type: 'string', required: true }, body: { type: 'markdown' } } },
        '@/article'
      ),
    }
  }

  const doc = buildSchemaOnlyPackage({
    schemas: schemaMap(),
    scope: '@std',
    exporter: { tool: 'uniweb', version: '9.9.9', instance: 'build' },
    exportedAt: '2026-05-26T00:00:00Z',
  })

  it('produces a uwx/1 envelope with an entities list', () => {
    expect(doc.uwx).toBe(1)
    expect(doc.exporter).toMatchObject({ tool: 'uniweb', version: '9.9.9' })
    expect(doc.exported_at).toBe('2026-05-26T00:00:00Z')
    expect(Array.isArray(doc.entities)).toBe(true)
  })

  it('emits ONLY @uniweb/data-schema entities — no foundation-schema', () => {
    expect(doc.entities.every((e) => e.model === '@uniweb/data-schema')).toBe(true)
    expect(doc.entities.some((e) => e.model === '@uniweb/foundation-schema')).toBe(false)
  })

  it('scopes each @/ name into the publish scope, sorted', () => {
    expect(doc.entities.map((e) => e.name)).toEqual(['@std/article', '@std/person'])
  })

  it('runs the lowering (markdown→text+format, email→format constraint)', () => {
    const article = doc.entities.find((e) => e.name === '@std/article')
    const articleBrief = Object.values(article.sections).find((s) => s.brief)
    expect(articleBrief.fields.body).toMatchObject({ type: 'text', format: 'markdown' })
    const person = doc.entities.find((e) => e.name === '@std/person')
    const personBrief = Object.values(person.sections).find((s) => s.brief)
    // format stays ON the field now (the backend relocates it to a constraint).
    expect(personBrief.fields.email).toMatchObject({ type: 'string', format: 'email' })
  })

  it('carries NO uuids / identity-in fields (name-in, like the foundation publish)', () => {
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/uuid/i)
    expect(json).not.toContain('models_required')
  })

  it('leaves @/ names unscoped when no scope is given (local preview)', () => {
    const preview = buildSchemaOnlyPackage({ schemas: schemaMap() })
    expect(preview.entities.map((e) => e.name)).toEqual(['@/article', '@/person'])
  })

  it('throws when there are no schemas to register', () => {
    expect(() => buildSchemaOnlyPackage({ schemas: {} })).toThrow(/no data schemas to register/)
    expect(() => buildSchemaOnlyPackage({})).toThrow(/no data schemas to register/)
  })
})

// ── Regression guard: the locked `uniweb register --scope` contract ──────────
// `register` is NAME-IN — the name is the identity; the backend mints uuids and
// integer versions. It is NOT the uuid-based `content export` / restore path. So
// the scoped submission must carry concrete @org-scoped names, an exporter.version,
// and NO identity-in fields (uuid / id / models_required).
describe('register --scope output — locked contract (regression)', () => {
  // A foundation with a BARE name + one DEFINED (@/) schema + one shared (@std)
  // ref, registered under @acme — the shape `uniweb register --scope @acme` sends.
  function bareNamedSchema() {
    return {
      _self: { name: 'src', version: '0.1.0', role: 'foundation' },
      dataSchemas: {
        '@/event': validateAndNormalizeSchema(
          { fields: { title: { type: 'string', required: true } } },
          '@/event'
        ),
        '@std/person': validateAndNormalizeSchema({ fields: { name: { type: 'string' } } }, '@std/person'),
      },
    }
  }

  const doc = buildRegistryPackage({
    schema: bareNamedSchema(),
    scope: '@acme',
    exporter: { tool: 'uniweb', version: '9.9.9', instance: 'build' },
  })

  it('resolves the bare foundation name into the scope (src -> @acme/src)', () => {
    const f = doc.entities.find((e) => e.model === '@uniweb/foundation-schema')
    expect(f.info.name).toBe('@acme/src')
  })

  it('resolves DEFINED @/ schema names into the scope; leaves shared refs as-is', () => {
    const defined = doc.entities.filter((e) => e.model === '@uniweb/data-schema')
    expect(defined.map((e) => e.name)).toEqual(['@acme/event']) // @/event -> @acme/event; @std/person not bundled
    const f = doc.entities.find((e) => e.model === '@uniweb/foundation-schema')
    // foundation lists BOTH it renders, scoped: own (@acme/event) + shared (@std/person)
    expect(f['data-schemas'].refs).toEqual([{ name: '@acme/event' }, { name: '@std/person' }])
  })

  it('carries an exporter.version string', () => {
    expect(typeof doc.exporter.version).toBe('string')
    expect(doc.exporter.version).toBe('9.9.9')
  })

  it('is name-in, not identity-in: no entity carries uuid / id / models_required', () => {
    for (const entity of doc.entities) {
      expect(entity).not.toHaveProperty('uuid')
      expect(entity).not.toHaveProperty('id')
      expect(entity).not.toHaveProperty('model_uuid')
      expect(entity).not.toHaveProperty('models_required')
    }
    // belt-and-suspenders across the whole document (distinctive substrings)
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/uuid/i)
    expect(json).not.toContain('models_required')
  })
})
