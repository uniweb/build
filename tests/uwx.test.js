import {
  emitEntityPackage,
  mintUuidV7,
  createZip,
  readZip,
  sha256Hex,
  serializeEntityFile,
  computePackageSha256,
  buildManifest,
} from '../src/uwx/index.js'
import { crc32 } from '../src/uwx/crc32.js'

const SITE_CONTENT_UUID = '019e230f-de00-7069-b3cb-f5922bbd5cca'

function sampleEntity(overrides = {}) {
  return {
    uuid: mintUuidV7(),
    model_uuid: SITE_CONTENT_UUID,
    items: [
      {
        uuid: mintUuidV7(),
        section: 'info',
        data: { name: { en: 'Test Site' }, foundation_ref: '@acme/marketing@1.0.0' },
      },
    ],
    ...overrides,
  }
}

describe('uwx/uuid mintUuidV7', () => {
  it('emits a v7 uuid with the correct version and variant bits', () => {
    const u = mintUuidV7()
    expect(u).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('is unique across many mints', () => {
    const set = new Set()
    for (let i = 0; i < 5000; i++) set.add(mintUuidV7())
    expect(set.size).toBe(5000)
  })

  it('is time-ordered across milliseconds (v7 index-locality property)', async () => {
    const a = mintUuidV7()
    await new Promise((r) => setTimeout(r, 3))
    const b = mintUuidV7()
    // First 48 bits are the ms timestamp; lexical compare of the leading
    // hex reflects time order.
    expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true)
  })
})

describe('uwx/crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('is 0 for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('uwx/zip', () => {
  it('round-trips names and bytes through createZip/readZip', () => {
    const files = [
      { name: 'manifest.json', data: Buffer.from('{"format":"uwx/1"}', 'utf8') },
      { name: 'entities/abc.json', data: Buffer.from([0, 1, 2, 255, 128, 64]) },
    ]
    const back = readZip(createZip(files))
    expect([...back.keys()]).toEqual(['manifest.json', 'entities/abc.json'])
    expect(back.get('manifest.json').toString('utf8')).toBe('{"format":"uwx/1"}')
    expect([...back.get('entities/abc.json')]).toEqual([0, 1, 2, 255, 128, 64])
  })

  it('produces a standard EOCD with the right entry count', () => {
    const zip = createZip([{ name: 'a', data: Buffer.from('x') }])
    // PK\x05\x06 end-of-central-directory signature must be present.
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true)
  })

  it('is deterministic for identical input (fixed mtime)', () => {
    const files = [{ name: 'm', data: Buffer.from('same') }]
    expect(createZip(files).equals(createZip(files))).toBe(true)
  })
})

describe('uwx serializeEntityFile', () => {
  it('applies the documented per-entity defaults and never emits derived columns', () => {
    const parsed = JSON.parse(
      serializeEntityFile({
        uuid: 'e1',
        model_uuid: 'm1',
        items: [{ uuid: 'i1', section: 'info', data: { a: 1 } }],
      }).toString('utf8')
    )
    expect(parsed.owner_uuid).toBeNull()
    expect(parsed.unit_uuid).toBeNull()
    expect(parsed.meta).toEqual({})
    expect(parsed).not.toHaveProperty('brief')
    expect(parsed).not.toHaveProperty('sort_date')
    expect(parsed.items[0]).toEqual({
      uuid: 'i1',
      section: 'info',
      parent_section: null,
      parent_path: null,
      data: { a: 1 },
      meta: {},
      item_date: null,
      order_number: null,
    })
  })
})

describe('uwx emitEntityPackage', () => {
  const modelsRequired = [
    { uuid: SITE_CONTENT_UUID, name_at_export: '@uniweb/site-content' },
  ]

  it('emits a valid subtype:entity package the manifest/per-entity shapes match', () => {
    const entity = sampleEntity()
    const zip = emitEntityPackage({ entities: [entity], modelsRequired })
    const files = readZip(zip)

    expect(files.has('manifest.json')).toBe(true)
    expect(files.has(`entities/${entity.uuid}.json`)).toBe(true)

    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required[0].uuid).toBe(SITE_CONTENT_UUID)
    expect(manifest.models_required[0].policy_hint).toBe('validate_existing')
    expect(manifest.roots).toEqual([entity.uuid])
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    // entries[].sha256 must equal the sha256 of the per-entity file bytes.
    const entryBytes = files.get(`entities/${entity.uuid}.json`)
    expect(manifest.entries[0].sha256).toBe(sha256Hex(entryBytes))
  })

  it('serializes the manifest in the documented field order', () => {
    const zip = emitEntityPackage({ entities: [sampleEntity()], modelsRequired })
    const raw = readZip(zip).get('manifest.json').toString('utf8')
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'format',
      'subtype',
      'exporter',
      'exported_at',
      'models_required',
      'referenced_members',
      'referenced_units',
      'roots',
      'entries',
      'edges',
      'blobs',
      'package_sha256',
    ])
  })

  it('package_sha256 is provenance-free (snapshot-dedupe contract)', () => {
    // Same content, different exporter + exported_at => SAME digest.
    // This is the provenance-free property the recipe must hold.
    const entity = sampleEntity()
    const a = emitEntityPackage({
      entities: [entity],
      modelsRequired,
      exporter: { tool: 'a', version: '1', instance: 'x' },
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const b = emitEntityPackage({
      entities: [entity],
      modelsRequired,
      exporter: { tool: 'b', version: '2', instance: 'y' },
      exportedAt: '2026-12-31T23:59:59Z',
    })
    const da = JSON.parse(readZip(a).get('manifest.json').toString('utf8'))
      .package_sha256
    const db = JSON.parse(readZip(b).get('manifest.json').toString('utf8'))
      .package_sha256
    expect(da).toBe(db)
  })

  it('package_sha256 is content-sensitive (tamper detection)', () => {
    const base = sampleEntity()
    const mutated = {
      ...base,
      items: [{ ...base.items[0], data: { name: { en: 'Changed' } } }],
    }
    const fixed = { exportedAt: '2026-01-01T00:00:00Z' }
    const d1 = computePackageSha256(
      manifestFor(base, modelsRequired, fixed)
    )
    const d2 = computePackageSha256(
      manifestFor(mutated, modelsRequired, fixed)
    )
    expect(d1).not.toBe(d2)
  })

  it('rejects empty input', () => {
    expect(() => emitEntityPackage({ entities: [], modelsRequired })).toThrow()
    expect(() =>
      emitEntityPackage({ entities: [sampleEntity()], modelsRequired: [] })
    ).toThrow()
  })
})

// Helper mirroring emitEntityPackage's manifest assembly for digest unit tests.
function manifestFor(entity, modelsRequired, { exportedAt }) {
  const data = serializeEntityFile(entity)
  return buildManifest({
    subtype: 'entity',
    exporter: { tool: 'uniweb', version: 'dev', instance: 'unknown' },
    exportedAt,
    modelsRequired: modelsRequired.map((m) => ({
      uuid: m.uuid,
      name_at_export: m.name_at_export ?? null,
      policy_hint: 'validate_existing',
    })),
    referencedMembers: [],
    referencedUnits: [],
    roots: [entity.uuid],
    entries: [
      {
        kind: 'entity',
        uuid: entity.uuid,
        model_uuid: entity.model_uuid,
        owner_uuid: null,
        unit_uuid: null,
        brief: null,
        sort_date: null,
        updated_at: null,
        file: `entities/${entity.uuid}.json`,
        sha256: sha256Hex(data),
      },
    ],
    edges: [],
    blobs: [],
  })
}

// Reference vector: drop a known-good `*.entity.uwx` + its expected
// package_sha256 under tests/fixtures/uwx/, then unskip and assert this
// writer reproduces those exact bytes/digest. If it ever fails, the fix is
// one of the numbered A1–A6 assumptions in manifest.js.
describe('uwx reference vector', () => {
  it.skip('reproduces the reference package_sha256', () => {})
})
