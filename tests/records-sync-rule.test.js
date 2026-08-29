// ⛔ WHAT SYNCS IS EXACTLY WHAT `records.yml` REFERENCES — and `missing` is not
// `empty`.
//
// This replaces `collections.yml::sync`, which is DELETED rather than ported.
// "Do not sync" is now "reference nothing", which is the actual round trip: the
// referenced set IS the folder IS the payload, identical on both sides.
//
// ⛔ BOTH RULED BEHAVIOURS ARE PINNED HERE, and that is the point. A test
// asserting only one of them would pass for an implementation that conflated the
// two — which is the shape someone reaches for when the empty-file hazard is
// explained to them.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'

const SCHEMA = {
  name: 'article',
  brief: true,
  fields: { title: { type: 'string' }, body: { type: 'text', format: 'markdown' } },
}

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const setup = (recordsYml) => {
  w('site/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('site/entities/article/hello.md', '---\ntitle: Hello\n---\nBody.\n')
  w('site/entities/article/world.md', '---\ntitle: World\n---\nBody2.\n')
  w('fdn/dist/meta/schema.json', { dataSchemas: { '@/article': SCHEMA } })
  if (recordsYml !== null) w('site/records.yml', recordsYml)
  return join(ROOT, 'site')
}
const folderDoc = (pkg) =>
  JSON.parse(readZip(pkg.records.buffer).get('entities/folder.json').toString('utf8'))

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'sync-rule-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('missing vs empty — ruled, and both pinned', () => {
  it('⭐ MISSING is inert: no collections lane at all', async () => {
    const site = setup(null)
    const pkg = await emitSyncPackages(site)
    // Not an empty folder — no folder. The server's is left untouched.
    expect(pkg.records).toBeNull()
  })

  it('⛔ EMPTY is destructive: a folder that holds nothing, so the backend removes', async () => {
    const site = setup('')
    const pkg = await emitSyncPackages(site)
    expect(pkg.records).toBeTruthy()
    const doc = folderDoc(pkg)
    expect(doc.$model).toBe('@uniweb/folder')
    expect(doc.contents).toEqual([])
  })

  // ⛔ CONTROL. Without it, an emitter that never produced a collections lane
  // would pass the first case, and one that always produced an empty folder would
  // pass the second.
  it('CONTROL — a populated records.yml sends its records', async () => {
    const site = setup('- article/*.md\n')
    const pkg = await emitSyncPackages(site)
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents.map((c) => c.$ref)).toEqual([
      'article/hello',
      'article/world',
    ])
  })
})

describe('only what is referenced syncs', () => {
  it('an unreferenced entity is absent from the payload — and REPORTED', async () => {
    const site = setup('- article/hello.md\n')
    const pkg = await emitSyncPackages(site)
    const ids = pkg.records.index.slice(1).map((e) => e.id)
    // the subject
    expect(ids).not.toContain('article/world')
    // ⛔ CONTROL — its referenced sibling IS present, so the absence above is
    // about the rule rather than about nothing being emitted.
    expect(ids).toEqual(['article/hello'])
    expect(pkg.warnings.some((x) => x.includes('world.md') && x.includes('referenced by nothing'))).toBe(true)
  })

  it('the folder references only what it placed', async () => {
    const site = setup('- article/hello.md\n')
    const pkg = await emitSyncPackages(site)
    expect(folderDoc(pkg).contents.map((c) => c.$ref)).toEqual(['article/hello'])
  })

  // ⭐ An unreferenced entity is a DRAFT, for free — the backend's "an entity in
  // no folder exists, but cannot be publicly fetched", true here by construction
  // rather than by convention. No flag, and none to port: `collections.yml::sync`
  // is deleted, not reimplemented.
  it('there is no sync flag to set — the reference is the control', async () => {
    const site = setup('- article/hello.md\n')
    // A stray `sync: false` is now just a query named `sync`, honoured by nothing.
    w('site/queries.yml', 'sync: false\narticles:\n  schema: "@/article"\n')
    const pkg = await emitSyncPackages(site)
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents).toHaveLength(1)
  })
})

// ⛔ THE REGRESSION THAT MADE `declared` A POSITIVE TEST.
//
// `recordsState` has to ride out of the producer on EVERY path, because its
// ABSENCE reads as "not missing" to whoever asks. Measured while building this:
// a site with no queries returned early without a state, the folder builder took
// that for `declared`, and a site with no `records.yml` at all emitted an empty
// folder — one that would have removed everything on the far side.
describe('a site with nothing to sync never emits a removing folder', () => {
  it('no queries and no records.yml → no collections lane', async () => {
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
    w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
    const pkg = await emitSyncPackages(join(ROOT, 'site'))
    expect(pkg.records).toBeNull()
  })

  it('CONTROL — the same site WITH an empty records.yml does emit one', async () => {
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
    w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
    w('site/records.yml', '')
    const pkg = await emitSyncPackages(join(ROOT, 'site'))
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents).toEqual([])
  })
})
