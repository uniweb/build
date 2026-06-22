import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitSyncPackages,
  siteProjectToDocument,
  writeSiteEntityUuid,
  readZip,
} from '../src/uwx/index.js'

// The two directional sync lanes: site-content (static) and collections (folder +
// records). Each fires independently on "send only changed"; the entity uuids live
// in files (site.yml / collections.yml / record files), and site-content carries no
// per-item uuids on the wire.

let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-sync-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  mkdirSync(SITE, { recursive: true })

  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing@1"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { foundation: 'file:../foundation' } }))
  // pages
  w('pages/1-home/page.yml', ['id: home', 'nest:', '  hero: [detail]', ''].join('\n'))
  w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n')
  w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# More\n')
  w('layout/header.md', '---\ntype: Header\n---\n# H\n')
  // a syncable collection (resolvable @/article schema) + collections.yml
  w('collections/collections.yml', 'collections:\n  articles:\n    schema: "@/article"\n    sort: date desc\n')
  w('collections/articles/hello.md', '---\ntitle: Hello\ndate: 2026-01-01\n---\nBody\n')
  w('collections/articles/world.md', '---\ntitle: World\ndate: 2026-02-01\n---\nBody2\n')
  writeFileSync(
    join(fdn, 'dist', 'meta', 'schema.json'),
    JSON.stringify({
      _self: { name: '@acme/marketing', version: '1', role: 'foundation' },
      dataSchemas: {
        '@/article': {
          name: 'article',
          sections: {
            main: { brief: true, fields: { title: { type: 'string' }, date: { type: 'date' }, body: { type: 'text', format: 'markdown' } } },
          },
        },
      },
    })
  )
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('emitSyncPackages — two directional lanes', () => {
  it('first build: both lanes fire (folder + records, folder first)', async () => {
    const pkg = await emitSyncPackages(SITE)

    // site-content lane: one entity
    expect(pkg.siteContent).toBeTruthy()
    expect(pkg.siteContent.entityCount).toBe(1)
    expect(pkg.siteContent.models).toEqual(['@uniweb/site-content'])
    expect(pkg.siteContent.index).toEqual([{ kind: 'site' }])

    // collections lane: folder + 2 records, folder first (the leading { kind: 'folder' }
    // is a positional placeholder so record back-fill stays aligned)
    expect(pkg.collections).toBeTruthy()
    expect(pkg.collections.entityCount).toBe(3)
    expect(pkg.collections.models).toContain('@uniweb/folder')
    expect(pkg.collections.index[0]).toEqual({ kind: 'folder' })
    expect(pkg.collections.index.slice(1).map((e) => e.id)).toEqual(['articles/hello', 'articles/world'])

    // the folder references both records by $ref (uuid-less first push) and carries no
    // $uuid of its own (the backend owns it, keyed by the site-content uuid)
    const folder = JSON.parse(readZip(pkg.collections.buffer).get('entities/folder.json').toString('utf8'))
    expect(folder.$model).toBe('@uniweb/folder')
    expect(folder).not.toHaveProperty('$uuid')
    const leaves = folder.contents[0].$children
    expect(leaves.map((l) => l.$ref)).toEqual(['articles/hello', 'articles/world'])
  })

  it('the site-content .uwx carries $id but no per-item $uuid', async () => {
    const pkg = await emitSyncPackages(SITE)
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.$model).toBe('@uniweb/site-content')
    expect(body).not.toHaveProperty('$uuid')
    const home = body.pages.find((p) => p.slug?.en === 'home')
    expect(home.$id).toBe('home')
    expect(home).not.toHaveProperty('$uuid')
    expect(home.page_sections[0].$children[0].$id).toBe('detail') // @-nested
  })

  it('send-only-changed: an unchanged second build pushes nothing on either lane', async () => {
    const first = await emitSyncPackages(SITE)
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
    expect(second.collections).toBeNull()
    expect(second.skipped).toBe(4) // site + folder + 2 records
  })

  it('editing a record fires ONLY the collections lane', async () => {
    const first = await emitSyncPackages(SITE)
    w('collections/articles/hello.md', '---\ntitle: Hello edited\ndate: 2026-01-01\n---\nBody\n')
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
    expect(second.collections).toBeTruthy()
    // folder (always, for $ref closure) + the one changed record
    expect(second.collections.index.map((e) => e.kind ?? e.id)).toEqual(['folder', 'articles/hello'])
  })

  it('editing a page fires ONLY the site-content lane', async () => {
    const first = await emitSyncPackages(SITE)
    w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# Much more\n')
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeTruthy()
    expect(second.collections).toBeNull()
  })

  it('the folder never carries a $uuid, even when collections.yml has one', async () => {
    // A stray collections.yml::$uuid (e.g. left over from an old project) is ignored —
    // the backend owns the folder, keyed by the site-content uuid.
    w('collections/collections.yml', '$uuid: folder-existing\ncollections:\n  articles:\n    schema: "@/article"\n')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.collections).not.toHaveProperty('bind')
    const folder = JSON.parse(readZip(pkg.collections.buffer).get('entities/folder.json').toString('utf8'))
    expect(folder).not.toHaveProperty('$uuid')
  })

  it('a collection that resolves no schema is reported in `schemaless` (not synced)', async () => {
    // `notes` declares no schema and the foundation defines none → it resolves via
    // the subfolder-name convention, finds nothing, and soft-skips the sync. It
    // surfaces in `schemaless` so the composite deploy can deliver it via the ball.
    w('collections/collections.yml', 'collections:\n  articles:\n    schema: "@/article"\n  notes: {}\n')
    w('collections/notes/first.md', '---\ntitle: First\n---\nNote body\n')
    const pkg = await emitSyncPackages(SITE)

    expect(pkg.schemaless).toEqual([{ name: 'notes' }])
    // articles still syncs as entities — the partition routes each collection to one lane
    expect(pkg.collections.index.slice(1).map((e) => e.id)).toEqual(['articles/hello', 'articles/world'])
  })
})

describe('site-content entity uuid → site.yml', () => {
  it('writeSiteEntityUuid records the uuid, preserving the file; re-read carries it', async () => {
    writeSiteEntityUuid(SITE, 'u-entity-1')
    const after = readFileSync(join(SITE, 'site.yml'), 'utf8')
    expect(after).toMatch(/^\$uuid: u-entity-1$/m)
    expect(after).toContain('name: Acme')
    const doc = await siteProjectToDocument(SITE)
    expect(doc.$uuid).toBe('u-entity-1')
    expect(doc.pages.find((p) => p.slug?.en === 'home')).not.toHaveProperty('$uuid')
  })

  it('the producer surfaces siteContentUuid for collections binding', async () => {
    writeSiteEntityUuid(SITE, 'u-entity-9')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.siteContentUuid).toBe('u-entity-9')
  })
})

describe('emitSyncPackages — injectInfo (deploy-derived info)', () => {
  it('stamps injectInfo fields (data_bundle) onto the site-content document info', async () => {
    const pkg = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/abc/base.json' } })
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.info.data_bundle).toBe('http://h/asset/dist/abc/base.json')
    // it is part of the hashed content, so changing the bundle URL re-fires the lane
    const same = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/abc/base.json' }, priorHashes: pkg.hashes })
    expect(same.siteContent).toBeNull()
    const changed = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/DEF/base.json' }, priorHashes: pkg.hashes })
    expect(changed.siteContent).toBeTruthy()
  })

  it('without injectInfo, the site-content info carries no data_bundle', async () => {
    const pkg = await emitSyncPackages(SITE)
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.info.data_bundle).toBeUndefined()
  })
})
