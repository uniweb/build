import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mintResolver,
  sidecarResolver,
  emitSitePackage,
  emitFoundationSchemaPackage,
  readZip,
} from '../src/uwx/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function entityOf(zipBuf) {
  const files = readZip(zipBuf)
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  return JSON.parse(
    files.get(`entities/${manifest.roots[0]}.json`).toString('utf8')
  )
}

describe('uwx/identity mintResolver', () => {
  it('mints distinct v7 uuids and has a no-op flush', () => {
    const r = mintResolver()
    const a = r.item('k')
    const b = r.item('k') // same key, still distinct (no persistence)
    expect(a).toMatch(UUID_RE)
    expect(b).toMatch(UUID_RE)
    expect(a).not.toBe(b)
    expect(() => r.flush()).not.toThrow()
  })
})

describe('uwx/identity sidecarResolver', () => {
  let dir
  beforeEach(() => {
    dir = tmp('uwx-sc-')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is stable per key within a run and persists across runs', () => {
    const path = join(dir, '.uniweb/uwx-ids.json')
    const r1 = sidecarResolver(path)
    const e = r1.entity('site-content')
    const i = r1.item('page:id:home')
    expect(r1.item('page:id:home')).toBe(i) // stable within run
    expect(r1.item('page:id:about')).not.toBe(i)
    r1.flush()
    expect(existsSync(path)).toBe(true)

    const r2 = sidecarResolver(path) // fresh resolver, same file
    expect(r2.entity('site-content')).toBe(e) // persisted
    expect(r2.item('page:id:home')).toBe(i)
  })

  it('only writes when something changed', () => {
    const path = join(dir, '.uniweb/uwx-ids.json')
    const r1 = sidecarResolver(path)
    r1.flush() // nothing resolved → no write
    expect(existsSync(path)).toBe(false)
    r1.item('x')
    r1.flush()
    const first = readFileSync(path, 'utf8')
    sidecarResolver(path).flush() // resolved nothing new → no rewrite
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('persists sorted { entities, items, schemas } JSON', () => {
    const path = join(dir, 'ids.json')
    const r = sidecarResolver(path)
    r.item('z')
    r.item('a')
    r.entity('e')
    r.schema('@/article')
    r.flush()
    const json = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(json)).toEqual(['entities', 'items', 'schemas'])
    expect(Object.keys(json.items)).toEqual(['a', 'z']) // sorted
    expect(json.entities.e).toMatch(UUID_RE)
    expect(json.schemas['@/article']).toMatch(UUID_RE)
  })

  it('data-schema-identity uuids are stable per ref across runs', () => {
    const path = join(dir, 'm.json')
    const r1 = sidecarResolver(path)
    const a = r1.schema('@/article')
    expect(r1.schema('@/article')).toBe(a) // stable within run
    expect(r1.schema('@/member')).not.toBe(a)
    r1.flush()
    // Reused across foundation versions: a fresh resolver yields the same uuid.
    expect(sidecarResolver(path).schema('@/article')).toBe(a)
  })

  it('throws on a corrupt sidecar (not silently reset)', () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{ not json')
    expect(() => sidecarResolver(path)).toThrow()
  })

  it('rejects empty keys', () => {
    const r = sidecarResolver(join(dir, 'k.json'))
    expect(() => r.item('')).toThrow()
  })
})

describe('uwx/identity — syncable round trip (site)', () => {
  let root
  function writeSite(heroBody) {
    writeFileSync(
      join(root, 'site.yml'),
      'name: S\nfoundation: "@a/b@1.0.0"\nindex: home\n'
    )
    writeFileSync(join(root, 'theme.yml'), 'colors: {}\n')
    mkdirSync(join(root, 'pages/1-home'), { recursive: true })
    writeFileSync(join(root, 'pages/1-home/page.yml'), 'id: home\n')
    writeFileSync(
      join(root, 'pages/1-home/1-hero.md'),
      `---\ntype: Hero\nid: hero\n---\n${heroBody}\n`
    )
  }
  beforeEach(() => {
    root = tmp('uwx-rt-')
    writeSite('# First body')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('without a sidecar, every export mints fresh uuids (submit-once)', async () => {
    const a = entityOf(await emitSitePackage(root))
    const b = entityOf(await emitSitePackage(root))
    expect(a.uuid).not.toBe(b.uuid)
  })

  it('with a sidecar, re-export reuses entity + item uuids (update not duplicate)', async () => {
    const a = entityOf(await emitSitePackage(root, { sidecar: true }))
    expect(existsSync(join(root, '.uniweb/uwx-ids.json'))).toBe(true)

    // Edit the hero body; keep its frontmatter `id: hero`.
    writeSite('# Rewritten body, same id')
    const b = entityOf(await emitSitePackage(root, { sidecar: true }))

    expect(b.uuid).toBe(a.uuid) // same site entity
    const heroA = a.items.find(
      (i) => i.section === 'page_sections' && i.data.stable_id === 'hero'
    )
    const heroB = b.items.find(
      (i) => i.section === 'page_sections' && i.data.stable_id === 'hero'
    )
    expect(heroB.uuid).toBe(heroA.uuid) // stable → restore updates, not dupes
    // ...but the content actually changed (it's an update).
    expect(JSON.stringify(heroB.data.content)).not.toBe(
      JSON.stringify(heroA.data.content)
    )
    // info + page items also stable.
    const info = (e) => e.items.find((i) => i.section === 'info').uuid
    expect(info(b)).toBe(info(a))
  })

  it('accepts an explicit sidecar path', async () => {
    const path = join(tmpdir(), `ids-${Date.now()}.json`)
    await emitSitePackage(root, { sidecar: path })
    expect(existsSync(path)).toBe(true)
    rmSync(path, { force: true })
  })
})

describe('uwx/identity — foundation idempotency (keyed by name@version)', () => {
  const schema = {
    _self: { name: '@acme/x', version: '2.0.0' },
    Hero: { name: 'Hero', title: 'Hero v1' },
  }

  it('re-emitting the same version reuses uuids; a label edit keeps the schema Section uuid', () => {
    const path = join(tmpdir(), `fnd-${Date.now()}.json`)
    const a = entityOf(emitFoundationSchemaPackage(schema, { sidecar: path }))
    const edited = {
      _self: { name: '@acme/x', version: '2.0.0' },
      Hero: { name: 'Hero', title: 'Hero v2 (edited)' },
    }
    const b = entityOf(emitFoundationSchemaPackage(edited, { sidecar: path }))

    expect(b.uuid).toBe(a.uuid) // same name@version
    const sch = (e) => e.items.find((i) => i.section === 'schema')
    expect(sch(b).uuid).toBe(sch(a).uuid) // keyed by ::schema
    expect(sch(b).data.schema.Hero.title).toBe('Hero v2 (edited)')
    rmSync(path, { force: true })
  })

  it('without a sidecar, mints fresh (submit-once)', () => {
    const a = entityOf(emitFoundationSchemaPackage(schema))
    const b = entityOf(emitFoundationSchemaPackage(schema))
    expect(a.uuid).not.toBe(b.uuid)
  })
})
