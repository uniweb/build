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

// A stable in-memory resolver: same key → same uuid (mirrors the sidecar's
// idempotency without touching the filesystem). Records the keys it was asked.
function memoResolver() {
  const e = new Map()
  const i = new Map()
  let n = 0
  const get = (m, k) => {
    if (!m.has(k)) m.set(k, `uuid-${n++}`)
    return m.get(k)
  }
  return {
    entity: (k) => get(e, k),
    item: (k) => get(i, k),
    flush() {},
    entityKeys: () => [...e.keys()],
    itemKeys: () => [...i.keys()],
  }
}

const unzip = (buf) => {
  const files = readZip(buf)
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  const entity = (uuid) =>
    JSON.parse(files.get(`entities/${uuid}.json`).toString('utf8'))
  return { files, manifest, entity }
}

// ── Step A: model-by-name in emitEntityPackage ──────────────────────────────

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

// ── Step B: collectionRecordsToEntities (pure mapper) ───────────────────────

describe('collectionRecordsToEntities — flat record → brief single section', () => {
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

  it('maps each record to one by-name entity with one brief item', () => {
    const id = memoResolver()
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
      idResolver: id,
    })
    expect(entities).toHaveLength(1)
    const [e] = entities
    expect(e.model).toBe('@acme/product')
    expect(e.owner_uuid).toBeNull()
    expect(e.unit_uuid).toBeNull()
    expect(e.items).toHaveLength(1)
    expect(e.items[0]).toMatchObject({
      section: 'product',
      parent_section: null,
      parent_path: null,
      order_number: null,
    })
    // identity keys: entity = col:<name>:<slug>, item = …::<briefSection>
    expect(id.entityKeys()).toEqual(['col:products:widget-x'])
    expect(id.itemKeys()).toEqual(['col:products:widget-x::product'])
  })

  it('wraps localized fields, leaves scalars/dates raw, drops slug', () => {
    const id = memoResolver()
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [
        { slug: 'widget-x', title: 'Widget X', price: 9.99, published: '2026-01-01', sku: 'WX-1' },
      ],
      declaration,
      idResolver: id,
      sourceLocale: 'en',
    })
    const { data } = entities[0].items[0]
    expect(data.title).toEqual({ en: 'Widget X' }) // localized wrap
    expect(data.price).toBe(9.99) // raw scalar
    expect(data.published).toBe('2026-01-01') // date string passthrough
    expect(data.sku).toBe('WX-1') // not localized (translatable:false)
    expect(data).not.toHaveProperty('slug') // identity, not data
  })

  it('normalizes a Date value to an ISO-8601 string', () => {
    const id = memoResolver()
    const { entities } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'd', title: 'D', published: new Date('2026-03-01T00:00:00Z') }],
      declaration,
      idResolver: id,
    })
    expect(entities[0].items[0].data.published).toBe('2026-03-01T00:00:00.000Z')
  })

  it('warns about + drops a field not on the Model', () => {
    const id = memoResolver()
    const { entities, warnings } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ slug: 'g', title: 'G', color: 'red' }],
      declaration,
      idResolver: id,
    })
    expect(entities[0].items[0].data).not.toHaveProperty('color')
    expect(warnings.some((w) => w.includes('color'))).toBe(true)
  })

  it('is idempotent by slug: same resolver → same uuids across runs', () => {
    const id = memoResolver()
    const args = {
      collectionName: 'products',
      records: [{ slug: 'widget-x', title: 'Widget X' }],
      declaration,
      idResolver: id,
    }
    const first = collectionRecordsToEntities(args)
    const second = collectionRecordsToEntities(args)
    expect(second.entities[0].uuid).toBe(first.entities[0].uuid)
    expect(second.entities[0].items[0].uuid).toBe(first.entities[0].items[0].uuid)
  })

  it('skips a record without a slug (with a warning)', () => {
    const id = memoResolver()
    const { entities, warnings } = collectionRecordsToEntities({
      collectionName: 'products',
      records: [{ title: 'No slug' }],
      declaration,
      idResolver: id,
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
        idResolver: memoResolver(),
      })
    ).toThrow(/no brief section/)
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

  it('emits one by-name entity per record, all of the mapped Model', async () => {
    const { buffer, models, entityCount } = await emitCollectionSyncPackage(siteDir, {
      exportedAt: '2026-05-27T00:00:00Z',
    })
    expect(models).toEqual(['@acme/product'])
    expect(entityCount).toBe(2)

    const files = readZip(buffer)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required).toEqual([
      { uuid: null, name_at_export: '@acme/product', policy_hint: 'validate_existing' },
    ])
    expect(manifest.roots).toHaveLength(2)

    const entities = manifest.roots.map((u) =>
      JSON.parse(files.get(`entities/${u}.json`).toString('utf8'))
    )
    for (const e of entities) {
      expect(e.model).toBe('@acme/product')
      expect(e).not.toHaveProperty('model_uuid')
      expect(e.owner_uuid).toBeNull()
      expect(e.unit_uuid).toBeNull()
      expect(e.items[0].section).toBe('product')
      // human-text `title` lowers to localized → wrapped `{ en: ... }`; `price` raw.
      expect(e.items[0].data.title).toHaveProperty('en')
      expect(typeof e.items[0].data.price).toBe('number')
    }
  })

  it('is idempotent: a sidecar re-run yields the same entity uuids', async () => {
    const a = await emitCollectionSyncPackage(siteDir, { sidecar: true })
    const b = await emitCollectionSyncPackage(siteDir, { sidecar: true })
    const roots = (buf) =>
      JSON.parse(readZip(buf).get('manifest.json').toString('utf8')).roots.sort()
    expect(roots(b.buffer)).toEqual(roots(a.buffer))
  })

  it('errors when no collection declares `model:`', async () => {
    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'site.yml'), 'name: Bare\ncollections:\n  posts:\n    path: data/posts\n')
    await expect(emitCollectionSyncPackage(bare)).rejects.toThrow(/no collection declares/)
  })
})
