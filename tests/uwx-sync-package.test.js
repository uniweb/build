import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitSyncPackage,
  siteProjectToDocument,
  writeSiteEntityUuid,
  recordSiteIdLedger,
  SITE_ID_LEDGER_RELPATH,
  readZip,
} from '../src/uwx/index.js'

// The combined site-content (+ folder + collections) sync package, and the revised
// identity model: the site-content ENTITY uuid lives in site.yml; nested items carry
// `$id` but no `$uuid` (they sync wholesale); per-page/section local ids live in our
// own committed, backend-invisible move-tracking ledger (.uniweb/site-ids.json).

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

describe('uwx/sync-package emitSyncPackage', () => {
  it('includes the site-content entity even with no syncable collections', async () => {
    // `articles` has no resolvable schema here, so it is NOT a record entity (and
    // there is no @uniweb/folder) — but the site itself still syncs.
    const pkg = await emitSyncPackage(ROOT)
    expect(pkg.siteIncluded).toBe(true)
    expect(pkg.models).toContain('@uniweb/site-content')
    expect(pkg.models).not.toContain('@uniweb/folder')
    expect(pkg.entityCount).toBe(1) // just the site entity
    const idx = pkg.index.find((e) => e.kind === 'site')
    expect(idx).toBeTruthy()
    expect(idx.document.$model).toBe('@uniweb/site-content')
  })

  it('send-only-changed skips an unchanged site on the second build', async () => {
    const first = await emitSyncPackage(ROOT)
    expect(first.entityCount).toBe(1)
    const second = await emitSyncPackage(ROOT, { priorHashes: first.hashes })
    expect(second.entityCount).toBe(0)
    expect(second.buffer).toBeNull()
    expect(second.skipped).toBe(1)
  })

  it('a content edit re-sends the site (hash includes nested $children)', async () => {
    const first = await emitSyncPackage(ROOT)
    w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# Much more\n')
    const second = await emitSyncPackage(ROOT, { priorHashes: first.hashes })
    expect(second.entityCount).toBe(1) // nesting change was NOT invisible
  })

  it('the .uwx body is the nested site document, items carry $id but no $uuid', async () => {
    const pkg = await emitSyncPackage(ROOT)
    const files = readZip(pkg.buffer)
    const body = JSON.parse(files.get('entities/site-content.json').toString('utf8'))
    expect(body.$model).toBe('@uniweb/site-content')
    expect(body).not.toHaveProperty('$uuid') // first sync — no entity uuid yet
    const home = body.pages.find((p) => p.slug === 'home')
    expect(home.$id).toBe('home')
    expect(home).not.toHaveProperty('$uuid')
    expect(home.page_sections[0].$id).toBe('hero')
    expect(home.page_sections[0]).not.toHaveProperty('$uuid')
    expect(home.page_sections[0].$children[0].$id).toBe('detail') // @-nested
  })
})

describe('uwx/site identity — entity uuid → site.yml, local move-tracking ledger', () => {
  it('writeSiteEntityUuid records the entity uuid in site.yml, preserving the file', async () => {
    writeSiteEntityUuid(ROOT, 'u-entity-1')
    const after = readFileSync(join(ROOT, 'site.yml'), 'utf8')
    expect(after).toMatch(/^\$uuid: u-entity-1$/m)
    expect(after).toContain('name: Acme') // the rest is untouched
    expect(after).toContain('foundation: "@acme/marketing@1"')
    // a re-read carries that entity uuid; nested items stay uuid-less
    const doc = await siteProjectToDocument(ROOT)
    expect(doc.$uuid).toBe('u-entity-1')
    const home = doc.pages.find((p) => p.slug === 'home')
    expect(home).not.toHaveProperty('$uuid')
  })

  it('updates an existing $uuid in place (single home, idempotent)', () => {
    writeSiteEntityUuid(ROOT, 'u-1')
    writeSiteEntityUuid(ROOT, 'u-2')
    const text = readFileSync(join(ROOT, 'site.yml'), 'utf8')
    expect(text.match(/\$uuid:/g)).toHaveLength(1) // not duplicated
    expect(text).toMatch(/^\$uuid: u-2$/m)
  })

  it('recordSiteIdLedger writes a committed, key-sorted, backend-invisible ledger', async () => {
    const doc = await siteProjectToDocument(ROOT)
    const ledgerPath = join(ROOT, SITE_ID_LEDGER_RELPATH)
    const n = recordSiteIdLedger(ledgerPath, doc)
    expect(n).toBeGreaterThan(0)
    expect(existsSync(ledgerPath)).toBe(true)
    const store = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    // one local id per page / section / @-nested child / folder child / layout / ext
    expect(store.items['page:id:home']).toBeTruthy()
    expect(store.items['page:id:home::sec:hero']).toBeTruthy()
    expect(store.items['page:id:home::sec:hero::sec:detail']).toBeTruthy()
    expect(store.items['page:id:intro::sec:body']).toBeTruthy()
    expect(store.items['layout:default/header:header']).toBeTruthy()
    expect(store.items['ext:https://cdn.example.com/x/entry.js']).toBeTruthy()
    // key-sorted for clean diffs
    const keys = Object.keys(store.items)
    expect(keys).toEqual([...keys].sort())
  })

  it('ledger is byte-stable across re-records; authored files never gain $uuid', async () => {
    const ledgerPath = join(ROOT, SITE_ID_LEDGER_RELPATH)
    recordSiteIdLedger(ledgerPath, await siteProjectToDocument(ROOT))
    const first = readFileSync(ledgerPath, 'utf8')
    recordSiteIdLedger(ledgerPath, await siteProjectToDocument(ROOT))
    expect(readFileSync(ledgerPath, 'utf8')).toBe(first) // fixpoint — same ids reused
    expect(readFileSync(join(ROOT, 'pages/1-home/1-hero.md'), 'utf8')).not.toMatch(/\$uuid/)
  })
})
