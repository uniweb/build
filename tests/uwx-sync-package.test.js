import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitSyncPackage,
  siteProjectToDocument,
  siteSidecarEntries,
  writeSiteSidecar,
  readZip,
} from '../src/uwx/index.js'

// The combined site-content + collections sync package, and the site-content
// sidecar back-fill round trip. The load-bearing property under test: the keys
// the PRODUCER reads uuids by (sidecarLookup) are exactly the keys the back-fill
// WRITES uuids to (siteSidecarEntries) — derived from the same helpers, walked in
// lockstep. If they ever drift, a re-sync stops finding prior uuids and dupes.

let ROOT
function w(rel, body) {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-sync-'))
  w(
    'site.yml',
    [
      'name: Acme',
      'foundation: "@acme/marketing@1"',
      'index: home',
      'extensions:',
      '  - https://cdn.example.com/x/entry.js',
      'collections:',
      '  articles:',
      '    path: collections/articles',
      '',
    ].join('\n')
  )
  // home page with a section that has an @-nested child
  w('pages/1-home/page.yml', ['id: home', 'nest:', '  hero: [detail]', ''].join('\n'))
  w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n')
  w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# More\n')
  // a folder with a child page
  w('pages/2-docs/folder.yml', 'title: Docs\n')
  w('pages/2-docs/1-intro/page.yml', 'id: intro\n')
  w('pages/2-docs/1-intro/intro.md', '---\ntype: Prose\nid: body\n---\n# Intro\n')
  w('layout/header.md', '---\ntype: Header\n---\n# H\n')
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

// Simulate the backend: deep-clone the submitted document and inject a `$uuid`
// at every record level (entity, pages, page_sections, $children, layout,
// extensions, collections) — exactly what the restore lane echoes in
// finalized[].document. Deterministic uuids so assertions are stable.
function fakeBackendFinalize(doc) {
  let n = 0
  const uuid = () => `u-${String(++n).padStart(4, '0')}`
  const clone = (v) => JSON.parse(JSON.stringify(v))
  const out = clone(doc)
  out.$uuid = uuid()
  const stampRecords = (arr) => {
    for (const r of arr || []) {
      r.$uuid = uuid()
      if (Array.isArray(r.page_sections)) stampRecords(r.page_sections)
      if (Array.isArray(r.$children)) stampRecords(r.$children)
    }
  }
  stampRecords(out.pages)
  stampRecords(out.layout_sections)
  stampRecords(out.extensions)
  stampRecords(out.collections)
  return out
}

describe('uwx/sync-package emitSyncPackage', () => {
  it('includes the site-content entity even with no model: collections', async () => {
    // `articles` has no `model:`, so it is NOT a record entity — but the site
    // itself still syncs.
    const pkg = await emitSyncPackage(ROOT)
    expect(pkg.siteIncluded).toBe(true)
    expect(pkg.models).toContain('@uniweb/site-content')
    expect(pkg.entityCount).toBe(1) // just the site entity
    const idx = pkg.index.find((e) => e.kind === 'site')
    expect(idx).toBeTruthy()
    expect(idx.document.$model).toBe('@uniweb/site-content')
  })

  it('send-only-changed skips an unchanged site on the second build', async () => {
    const first = await emitSyncPackage(ROOT)
    expect(first.entityCount).toBe(1)
    // Feed the prior hashes back: nothing changed → nothing to send.
    const second = await emitSyncPackage(ROOT, { priorHashes: first.hashes })
    expect(second.entityCount).toBe(0)
    expect(second.buffer).toBeNull()
    expect(second.skipped).toBe(1)
  })

  it('a content edit re-sends the site (hash includes nested $children)', async () => {
    const first = await emitSyncPackage(ROOT)
    // Edit the @-nested child's body — a change buried in $children.
    w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# Much more\n')
    const second = await emitSyncPackage(ROOT, { priorHashes: first.hashes })
    expect(second.entityCount).toBe(1) // nesting change was NOT invisible
  })

  it('the .uwx body is the nested site document', async () => {
    const pkg = await emitSyncPackage(ROOT)
    const files = readZip(pkg.buffer)
    const body = JSON.parse(files.get('entities/site-content.json').toString('utf8'))
    expect(body.$model).toBe('@uniweb/site-content')
    const home = body.pages.find((p) => p.slug === 'home')
    expect(home.page_sections[0].$id).toBe('hero')
    expect(home.page_sections[0].$children[0].$id).toBe('detail') // @-nested
  })
})

describe('uwx/site sidecar back-fill round trip', () => {
  it('records a minted $uuid for every record under the producer key', async () => {
    const producer = await siteProjectToDocument(ROOT)
    const finalized = fakeBackendFinalize(producer)
    const { entities, items } = siteSidecarEntries(producer, finalized)

    // entity
    expect(entities['site-content']).toBe(finalized.$uuid)
    // a page (by stable_id), its section, the @-nested child, a folder child page
    expect(items['page:id:home']).toBeTruthy()
    expect(items['page:id:home::sec:hero']).toBeTruthy()
    expect(items['page:id:home::sec:hero::sec:detail']).toBeTruthy()
    expect(items['page:id:intro']).toBeTruthy()
    expect(items['page:id:intro::sec:body']).toBeTruthy()
    // layout, extension, collection
    expect(items['layout:default/header:header']).toBeTruthy()
    expect(items['ext:https://cdn.example.com/x/entry.js']).toBeTruthy()
    expect(items['col:articles']).toBeTruthy()

    // every recorded uuid is one the fake backend minted (no key→uuid drift)
    const minted = new Set()
    const collect = (v) => {
      if (Array.isArray(v)) v.forEach(collect)
      else if (v && typeof v === 'object') {
        if (v.$uuid) minted.add(v.$uuid)
        Object.values(v).forEach(collect)
      }
    }
    collect(finalized)
    for (const u of Object.values(items)) expect(minted.has(u)).toBe(true)
  })

  it('CLOSED LOOP: back-filled sidecar makes the next producer doc carry those $uuids', async () => {
    // 1. first sync — producer has no uuids
    const producer1 = await siteProjectToDocument(ROOT)
    expect(producer1).not.toHaveProperty('$uuid')
    // 2. backend mints; verb records into the sidecar
    const finalized = fakeBackendFinalize(producer1)
    const sidecarPath = join(ROOT, '.uniweb', 'uwx-ids.json')
    writeSiteSidecar(sidecarPath, producer1, finalized)
    expect(existsSync(sidecarPath)).toBe(true)
    // 3. re-sync — producer reads the sidecar and carries the SAME uuids back
    const producer2 = await siteProjectToDocument(ROOT, { sidecar: true })
    expect(producer2.$uuid).toBe(finalized.$uuid)
    const home2 = producer2.pages.find((p) => p.slug === 'home')
    const home1f = finalized.pages.find((p) => p.slug === 'home')
    expect(home2.$uuid).toBe(home1f.$uuid) // page uuid round-trips
    expect(home2.page_sections[0].$uuid).toBe(home1f.page_sections[0].$uuid) // section
    expect(home2.page_sections[0].$children[0].$uuid).toBe(
      home1f.page_sections[0].$children[0].$uuid
    ) // @-nested child — the deepest round trip
    // authored files never gained a uuid (it lives only in the sidecar)
    expect(readFileSync(join(ROOT, 'pages/1-home/1-hero.md'), 'utf8')).not.toMatch(/\$uuid/)
  })

  it('preserves existing sidecar keys when merging new ones', async () => {
    const sidecarPath = join(ROOT, '.uniweb', 'uwx-ids.json')
    mkdirSync(join(ROOT, '.uniweb'), { recursive: true })
    writeFileSync(
      sidecarPath,
      JSON.stringify({ entities: { 'old-key': 'keep-me' }, items: { 'old:item': 'keep-too' } })
    )
    const producer = await siteProjectToDocument(ROOT)
    writeSiteSidecar(sidecarPath, producer, fakeBackendFinalize(producer))
    const store = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(store.entities['old-key']).toBe('keep-me') // preserved
    expect(store.items['old:item']).toBe('keep-too')
    expect(store.entities['site-content']).toBeTruthy() // and the new one added
  })
})
