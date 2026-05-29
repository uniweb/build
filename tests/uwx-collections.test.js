import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitEntityPackage,
  emitCollectionSyncPackage,
  readZip,
  mintUuidV7,
  collectionRecordsToEntities,
} from '../src/uwx/index.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

// Drive the mapper off a REAL declaration (author → normalize → lower), so the
// schema lowering and the mapper stay in step.
const lower = (authored, ref, name) =>
  toDataSchemaDeclaration(validateAndNormalizeSchema(authored, ref), { name })

const unzip = (buf) => {
  const files = readZip(buf)
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  // old `items[]` lane (emitEntityPackage): files are entities/<uuid>.json
  const entity = (uuid) =>
    JSON.parse(files.get(`entities/${uuid}.json`).toString('utf8'))
  // sync lane: files are at an opaque path recorded in entries[].file
  const byFile = (path) => JSON.parse(files.get(path).toString('utf8'))
  return { files, manifest, entity, byFile }
}

// ── Step A: model-by-name in emitEntityPackage (legacy items[] lane) ─────────

describe('emitEntityPackage — model-by-name', () => {
  it('serializes an entity by NAME (no model_uuid) + null-uuid models_required', () => {
    const uuid = mintUuidV7()
    const buf = emitEntityPackage({
      entities: [
        {
          uuid,
          model: '@acme/product',
          items: [{ uuid: mintUuidV7(), section: 'product', data: { sku: 'X' } }],
        },
      ],
      modelsRequired: [{ name_at_export: '@acme/product' }],
    })
    const { manifest, entity } = unzip(buf)

    // models_required: uuid is null; the importer resolves by name.
    expect(manifest.models_required[0]).toEqual({
      uuid: null,
      name_at_export: '@acme/product',
      policy_hint: 'validate_existing',
    })
    // the per-entity file carries `model` (name) and NO model_uuid.
    const e = entity(uuid)
    expect(e.model).toBe('@acme/product')
    expect(e).not.toHaveProperty('model_uuid')
    // the manifest entry mirrors the by-name pointer.
    const entry = manifest.entries.find((x) => x.uuid === uuid)
    expect(entry.model).toBe('@acme/product')
    expect(entry).not.toHaveProperty('model_uuid')
  })

  it('keeps a by-uuid entity unchanged (model_uuid, no `model`)', () => {
    const uuid = mintUuidV7()
    const modelUuid = mintUuidV7()
    const buf = emitEntityPackage({
      entities: [{ uuid, model_uuid: modelUuid, items: [] }],
      modelsRequired: [{ uuid: modelUuid, name_at_export: '@uniweb/site-content' }],
    })
    const { manifest, entity } = unzip(buf)
    const e = entity(uuid)
    expect(e.model_uuid).toBe(modelUuid)
    expect(e).not.toHaveProperty('model')
    expect(manifest.models_required[0].uuid).toBe(modelUuid)
  })

  it('rejects an entity with neither model_uuid nor model', () => {
    expect(() =>
      emitEntityPackage({
        entities: [{ uuid: mintUuidV7(), items: [] }],
        modelsRequired: [{ name_at_export: '@acme/x' }],
      })
    ).toThrow(/needs a model_uuid or a model/)
  })
})

// ── Step B: collectionRecordsToEntities → `$`-document (pure mapper) ──────────

describe('collectionRecordsToEntities — flat record → brief section `$`-document', () => {
  const declaration = lower(
    {
      name: 'product',
      sortDate: 'published',
      fields: {
        title: { type: 'string', required: true }, // human text → localized
        price: { type: 'decimal' },
        published: { type: 'date' },
        sku: { type: 'string', translatable: false }, // machine → not localized
      },
    },
    '@/product',
    '@acme/product'
  )

  it('lowers to a single brief section named by the short name', () => {
    expect(declaration.brief).toBe('product')
    expect(declaration.sections[0]).toMatchObject({ name: 'product', kind: 'single' })
  })

  it('maps each record to one by-name entity-content document (no $uuid on first sync)', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
    })
    expect(entities).toHaveLength(1)
    const [e] = entities
    expect(e.model).toBe('@acme/product')
    expect(e.id).toBe('widget-x')
    expect(e.uuid).toBeNull() // first sync — backend mints
    expect(e.file).toBe('entities/products/widget-x.json')
    expect(e.document).not.toHaveProperty('items') // not the legacy items[] shape
    expect(e.document.$id).toBe('widget-x')
    expect(e.document.$model).toBe('@acme/product')
    expect(e.document).not.toHaveProperty('$uuid')
    // brief section keyed by its name; its value is the fields object.
    expect(e.document.product).toMatchObject({ price: 9.99, published: '2026-01-01' })
  })

  it('canonical key order: $id, $model, then the section (no leading $uuid first sync)', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'a', title: 'A' }],
      declaration,
    })
    expect(Object.keys(entities[0].document)).toEqual(['$id', '$model', 'product'])
  })

  it('emits the brief fields in schema-declared order', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'a', sku: 'S', published: '2026-01-01', price: 1, title: 'A' }],
      declaration,
    })
    // declared order is title, price, published, sku — not the record's order.
    expect(Object.keys(entities[0].document.product)).toEqual([
      'title',
      'price',
      'published',
      'sku',
    ])
  })

  it('wraps localized fields, leaves scalars/dates raw, drops slug', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
      sourceLocale: 'en',
    })
    const data = entities[0].document.product
    expect(data.title).toEqual({ en: 'Widget X' }) // localized wrap
    expect(data.price).toBe(9.99) // raw scalar
    expect(data.published).toBe('2026-01-01') // date string passthrough
    expect(data.sku).toBe('WX-1') // not localized (translatable:false)
    expect(data).not.toHaveProperty('slug') // identity, not data
  })

  it('emits a `date` field as YYYY-MM-DD (not full ISO — backend rejects the latter)', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'd', title: 'D', published: new Date('2026-03-01T00:00:00Z') }],
      declaration, // `published` is type `date`
    })
    expect(entities[0].document.product.published).toBe('2026-03-01')
  })

  it('emits a `datetime` field as full RFC3339', () => {
    const dt = lower(
      { name: 'event', fields: { title: { type: 'string' }, at: { type: 'datetime' } } },
      '@/event',
      '@acme/event'
    )
    const { entities } = collectionRecordsToEntities({
      collectionName: 'events',
      records: [{ slug: 'e', title: 'E', at: new Date('2026-03-01T12:30:00Z') }],
      declaration: dt,
    })
    expect(entities[0].document.event.at).toBe('2026-03-01T12:30:00.000Z')
  })

  it('round-trips a back-filled $uuid for re-sync (as the leading key)', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'widget-x', $uuid: 'abc-123', title: 'Widget X' }],
      declaration,
    })
    const [e] = entities
    expect(e.uuid).toBe('abc-123')
    expect(e.document.$uuid).toBe('abc-123')
    expect(Object.keys(e.document)).toEqual(['$uuid', '$id', '$model', 'product'])
  })

  it('honors an explicit $id over the slug', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'file-name', $id: 'explicit-id', title: 'X' }],
      declaration,
    })
    expect(entities[0].id).toBe('explicit-id')
    expect(entities[0].document.$id).toBe('explicit-id')
    // file path still uses the slug (the on-disk anchor).
    expect(entities[0].file).toBe('entities/products/file-name.json')
  })

  it('warns about + drops a field not on the Model', () => {
    const { entities, warnings } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'g', title: 'G', color: 'red' }],
      declaration,
    })
    expect(entities[0].document.product).not.toHaveProperty('color')
    expect(warnings.some((w) => w.includes('color'))).toBe(true)
  })

  it('skips a record without a slug (with a warning)', () => {
    const { entities, warnings } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ title: 'No slug' }],
      declaration,
    })
    expect(entities).toHaveLength(0)
    expect(warnings.some((w) => w.includes('without a slug'))).toBe(true)
  })

  it('throws for a brief-less Model (no single section)', () => {
    const declNoBrief = lower(
      { name: 'log', sections: { entries: { kind: 'multi', fields: { msg: { type: 'string' } } } } },
      '@/log',
      '@acme/log'
    )
    expect(declNoBrief.brief).toBeFalsy()
    expect(() =>
      collectionRecordsToEntities({
        collectionName: 'logs',
        records: [{ slug: 'a', msg: 'hi' }],
        declaration: declNoBrief,
      })
    ).toThrow(/no brief section/)
  })
})

// ── Step B2: markdown body → the brief's richtext field ──────────────────────

describe('collectionRecordsToEntities — markdown body → richtext field', () => {
  const decl = lower(
    { name: 'article', fields: { title: { type: 'string' }, body: { type: 'richtext' } } },
    '@/article',
    '@acme/article'
  )

  it('maps $body to the brief richtext field as the raw value (localized-wrapped, not ProseMirror)', () => {
    const { entities, warnings } = collectionRecordsToEntities({
      collectionName: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: '\n# Welcome\n' }],
      declaration: decl,
      sourceLocale: 'en',
    })
    expect(warnings).toEqual([])
    const data = entities[0].document.article
    expect(data.title).toEqual({ en: 'Hello' })
    expect(data.body).toEqual({ en: '\n# Welcome\n' }) // raw markdown string
  })

  it('lets an explicit frontmatter value win over the body', () => {
    const { entities } = collectionRecordsToEntities({
      collectionName: 'articles',
      records: [{ slug: 'h', title: 'H', body: 'explicit', $body: 'from-md-body' }],
      declaration: decl,
    })
    expect(entities[0].document.article.body).toEqual({ en: 'explicit' })
  })

  it('never treats $body as an unknown field', () => {
    const { warnings } = collectionRecordsToEntities({
      collectionName: 'articles',
      records: [{ slug: 'hello', title: 'Hello', $body: 'x' }],
      declaration: decl,
    })
    expect(warnings.some((w) => w.includes('$body'))).toBe(false)
  })

  it('warns when a body is present but the Model has no richtext field', () => {
    const noRich = lower(
      { name: 'product', fields: { title: { type: 'string' } } },
      '@/product',
      '@acme/product'
    )
    const { warnings } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'p', title: 'P', $body: 'orphan body' }],
      declaration: noRich,
    })
    expect(warnings.some((w) => w.includes('no richtext field'))).toBe(true)
  })
})

// ── Step C: emitCollectionSyncPackage (orchestrator, real fs) ────────────────

describe('emitCollectionSyncPackage — site + local foundation → .uwx', () => {
  let root
  let siteDir

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-sync-'))
    siteDir = join(root, 'site')
    const foundationDir = join(root, 'foundation')
    mkdirSync(join(siteDir, 'data', 'products'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })

    // Site: a file collection mapped to a registry Model by name.
    writeFileSync(
      join(siteDir, 'site.yml'),
      [
        'name: Test Site',
        'foundation: "@acme/marketing"',
        'collections:',
        '  products:',
        '    path: data/products',
        '    model: "@acme/product"',
        '',
      ].join('\n')
    )
    writeFileSync(
      join(siteDir, 'package.json'),
      JSON.stringify({ name: 'site', dependencies: { foundation: 'file:../foundation' } })
    )
    writeFileSync(join(siteDir, 'data', 'products', 'widget-x.yml'), 'title: Widget X\nprice: 9.99\n')
    writeFileSync(join(siteDir, 'data', 'products', 'gadget-y.yml'), 'title: Gadget Y\nprice: 19.5\n')

    // Foundation: a built schema.json defining the @acme/product data-schema.
    const schema = {
      _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
      dataSchemas: {
        '@/product': validateAndNormalizeSchema(
          { name: 'product', fields: { title: { type: 'string' }, price: { type: 'decimal' } } },
          '@/product'
        ),
      },
    }
    writeFileSync(join(foundationDir, 'dist', 'meta', 'schema.json'), JSON.stringify(schema))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('emits one by-name `$`-document per record, all of the mapped Model', async () => {
    const { buffer, models, entityCount } = await emitCollectionSyncPackage(siteDir, {
      exportedAt: '2026-05-27T00:00:00Z',
    })
    expect(models).toEqual(['@acme/product'])
    expect(entityCount).toBe(2)

    const { manifest, byFile } = unzip(buffer)
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required).toEqual([
      { uuid: null, name_at_export: '@acme/product', policy_hint: 'validate_existing' },
    ])
    // sync lane: self-owned, so roots is empty (every node is writable).
    expect(manifest.roots).toEqual([])
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entityEntries = manifest.entries.filter((e) => e.kind === 'entity')
    expect(entityEntries).toHaveLength(2)
    for (const entry of entityEntries) {
      // entry.uuid is the `$id` handle label (v1); model is by name.
      expect(entry.model).toBe('@acme/product')
      expect(entry).not.toHaveProperty('model_uuid')
      expect(entry.file).toMatch(/^entities\/products\/.+\.json$/)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)

      const doc = byFile(entry.file)
      expect(doc.$model).toBe('@acme/product')
      expect(doc.$id).toBe(entry.uuid) // entry.uuid mirrors the body's $id
      expect(doc).not.toHaveProperty('$uuid') // first sync — backend mints
      expect(doc).not.toHaveProperty('items')
      // human-text `title` lowers to localized → wrapped `{ en: ... }`; `price` raw.
      expect(doc.product.title).toHaveProperty('en')
      expect(typeof doc.product.price).toBe('number')
    }
  })

  it('round-trips a back-filled $uuid on re-sync', async () => {
    // A second site whose record already carries a $uuid (a prior back-fill).
    const reSite = join(root, 'resync-site')
    mkdirSync(join(reSite, 'data', 'products'), { recursive: true })
    writeFileSync(
      join(reSite, 'site.yml'),
      'name: Re\nfoundation: "@acme/marketing"\ncollections:\n  products:\n    path: data/products\n    model: "@acme/product"\n'
    )
    writeFileSync(
      join(reSite, 'package.json'),
      JSON.stringify({ name: 're', dependencies: { foundation: 'file:../foundation' } })
    )
    writeFileSync(
      join(reSite, 'data', 'products', 'widget-x.yml'),
      '"$uuid": existing-uuid-1\ntitle: Widget X\n'
    )

    const { buffer } = await emitCollectionSyncPackage(reSite)
    const { manifest, byFile } = unzip(buffer)
    const entry = manifest.entries.find((e) => e.kind === 'entity')
    const doc = byFile(entry.file)
    expect(doc.$uuid).toBe('existing-uuid-1')
    expect(Object.keys(doc)).toEqual(['$uuid', '$id', '$model', 'product'])
  })

  it('errors when no collection declares `model:`', async () => {
    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'site.yml'), 'name: Bare\ncollections:\n  posts:\n    path: data/posts\n')
    await expect(emitCollectionSyncPackage(bare)).rejects.toThrow(/no collection declares/)
  })
})

// ── B3: non-local Model resolution via the injected resolveModel ─────────────

describe('emitCollectionSyncPackage — non-local Model via resolveModel', () => {
  let root
  let siteDir

  const productDecl = {
    name: '@std/product',
    brief: 'product',
    sections: [
      {
        name: 'product',
        kind: 'single',
        fields: [
          { key: 'title', type: 'string', localized: true },
          { key: 'price', type: 'decimal' },
        ],
      },
    ],
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'uwx-b3-'))
    siteDir = join(root, 'site')
    mkdirSync(join(siteDir, 'data', 'products'), { recursive: true })
    // NO foundation dependency — the Model is non-local (e.g. a @std schema).
    writeFileSync(
      join(siteDir, 'site.yml'),
      'name: T\ncollections:\n  products:\n    path: data/products\n    model: "@std/product"\n'
    )
    writeFileSync(join(siteDir, 'data', 'products', 'a.yml'), 'title: A\nprice: 5\n')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('fetches the declaration for a Model not in any local foundation', async () => {
    const calls = []
    const resolveModel = async (name) => {
      calls.push(name)
      return name === '@std/product' ? productDecl : null
    }
    const { buffer, models, entityCount } = await emitCollectionSyncPackage(siteDir, { resolveModel })
    expect(calls).toEqual(['@std/product'])
    expect(models).toEqual(['@std/product'])
    expect(entityCount).toBe(1)
    const { manifest, byFile } = unzip(buffer)
    const doc = byFile(manifest.entries[0].file)
    expect(doc.$model).toBe('@std/product')
    expect(doc.product.title).toEqual({ en: 'A' }) // declaration drove the localized wrap
    expect(doc.product.price).toBe(5)
  })

  it('errors clearly when the resolver returns null (Model not registered)', async () => {
    await expect(emitCollectionSyncPackage(siteDir, { resolveModel: async () => null })).rejects.toThrow(
      /register it first/
    )
  })

  it('prefers a local foundation when it defines the Model (resolver untouched)', async () => {
    const localSite = join(root, 'local')
    const foundationDir = join(root, 'local-foundation')
    mkdirSync(join(localSite, 'data', 'products'), { recursive: true })
    mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })
    writeFileSync(
      join(localSite, 'site.yml'),
      'name: L\nfoundation: "@acme/marketing"\ncollections:\n  products:\n    path: data/products\n    model: "@acme/product"\n'
    )
    writeFileSync(
      join(localSite, 'package.json'),
      JSON.stringify({ name: 'l', dependencies: { foundation: 'file:../local-foundation' } })
    )
    writeFileSync(join(localSite, 'data', 'products', 'a.yml'), 'title: A\n')
    writeFileSync(
      join(foundationDir, 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
        dataSchemas: {
          '@/product': validateAndNormalizeSchema({ name: 'product', fields: { title: { type: 'string' } } }, '@/product'),
        },
      })
    )

    let called = false
    const resolveModel = async () => {
      called = true
      throw new Error('resolver should not be called when the Model is local')
    }
    const { models } = await emitCollectionSyncPackage(localSite, { resolveModel })
    expect(models).toEqual(['@acme/product'])
    expect(called).toBe(false)
  })
})
