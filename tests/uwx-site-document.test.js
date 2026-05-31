import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  siteProjectToDocument,
  emitSiteSyncPackage,
  readZip,
} from '../src/uwx/index.js'

// Phase 0 de-flatten: the nested `$`-document lane for @uniweb/site-content.
// Asserts the shape the backend Model declares — page_sections as an inline
// field on each page, $children for folder→pages self-nesting, layout_sections
// top-level, $id identity (= stableId), and NO parent_path / positional tuples.

let ROOT

function w(rel, body) {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-site-doc-'))

  w(
    'site.yml',
    [
      'name: Acme Site',
      'defaultLanguage: en',
      'languages: [en, fr]',
      'foundation: "@acme/marketing@1.2.3"',
      'index: home',
      'extensions:',
      '  - https://cdn.example.com/stats/entry.js',
      'collections:',
      '  articles:',
      '    path: collections/articles',
      '    sort: date desc',
      '',
    ].join('\n')
  )
  w('theme.yml', 'colors:\n  primary: "#0099ff"\n')

  // home (page) with a section carrying background/theme
  w('pages/1-home/page.yml', 'id: home\ntitle: Home\n')
  w(
    'pages/1-home/1-hero.md',
    [
      '---',
      'type: Hero',
      'id: hero',
      'background:',
      '  image: /img/bg.jpg',
      'theme: dark',
      'cta: Get Started',
      '---',
      '# Welcome',
      '',
    ].join('\n')
  )

  // docs (folder container) with a child page that has a section
  w('pages/2-docs/folder.yml', 'title: Docs\n')
  w('pages/2-docs/1-intro/page.yml', 'id: intro\ntitle: Intro\n')
  w('pages/2-docs/1-intro/intro.md', '---\ntype: Prose\nid: body\n---\n# Intro\n')

  // features (page) with @-prefix child sections attached via nest:
  w(
    'pages/3-features/page.yml',
    ['id: features', 'title: Features', 'nest:', '  grid: [card-a, card-b]', ''].join('\n')
  )
  w('pages/3-features/1-grid.md', '---\ntype: Grid\nid: grid\n---\n# Our features\n')
  w('pages/3-features/@card-a.md', '---\ntype: Card\nid: card-a\n---\n# A\n')
  w('pages/3-features/@card-b.md', '---\ntype: Card\nid: card-b\n---\n# B\n')

  // layout areas: default + a named layout
  w('layout/header.md', '---\ntype: Header\n---\n# Site\n')
  w('layout/marketing/footer.md', '---\ntype: Footer\n---\n# Footer\n')
})

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('uwx/site siteProjectToDocument (nested $-document)', () => {
  it('produces a section-keyed $-document, not a flat items[] entity', async () => {
    const doc = await siteProjectToDocument(ROOT)
    expect(doc).not.toHaveProperty('items') // not the flat lane
    expect(doc.$id).toBe('site-content')
    expect(doc.$model).toBe('@uniweb/site-content')
    expect(doc).not.toHaveProperty('$uuid') // no sidecar → first-sync shape
    // top-level sections present (Model-declared order)
    expect(Object.keys(doc)).toEqual([
      '$id',
      '$model',
      'info',
      'pages',
      'layout_sections',
      'extensions',
      'collections',
    ])
  })

  it('carries info with foundation (the round-trip source of truth)', async () => {
    const { info } = await siteProjectToDocument(ROOT)
    expect(info.name).toEqual({ en: 'Acme Site' }) // localized wrap
    expect(info.foundation).toBe('@acme/marketing@1.2.3')
    expect(info.theme).toEqual({ colors: { primary: '#0099ff' } })
    expect(info.languages).toEqual(['en', 'fr'])
  })

  it('nests page_sections as an INLINE field on the page record (no top-level page_sections, no parent_path)', async () => {
    const doc = await siteProjectToDocument(ROOT)
    expect(doc).not.toHaveProperty('page_sections') // not a top-level section
    const home = doc.pages.find((p) => p.slug === 'home')
    expect(home.$id).toBe('home') // stableId from page.yml id:
    expect(home.is_index).toBe(true) // site.yml index: home
    expect(Array.isArray(home.page_sections)).toBe(true)
    const hero = home.page_sections[0]
    expect(hero.$id).toBe('hero')
    expect(hero.type).toBe('Hero')
    expect(hero.content.type).toBe('doc') // raw ProseMirror
    expect(hero.background).toEqual({ image: '/img/bg.jpg' }) // lifted from params
    expect(hero.theme_override).toBe('dark')
    expect(hero.params).toEqual({ cta: 'Get Started' })
    // no positional bookkeeping anywhere
    expect(hero).not.toHaveProperty('parent_path')
    expect(hero).not.toHaveProperty('parent_section')
    expect(home).not.toHaveProperty('parent_path')
  })

  it('reconstructs @-prefix nest: children under a section’s $children', async () => {
    const doc = await siteProjectToDocument(ROOT)
    const features = doc.pages.find((p) => p.slug === 'features')
    // The @-prefixed children are NOT top-level sections of the page.
    expect(features.page_sections).toHaveLength(1)
    const grid = features.page_sections[0]
    expect(grid.$id).toBe('grid')
    expect(grid.type).toBe('Grid')
    // They ride under the parent's $children (page_sections self-nesting).
    expect(Array.isArray(grid.$children)).toBe(true)
    expect(grid.$children.map((c) => c.$id)).toEqual(['card-a', 'card-b'])
    expect(grid.$children.map((c) => c.type)).toEqual(['Card', 'Card'])
    // Children carry no parent_path / back-reference — pure structure.
    expect(grid.$children[0]).not.toHaveProperty('parent_path')
  })

  it('nests a folder’s child pages under $children (same-section self-nesting)', async () => {
    const doc = await siteProjectToDocument(ROOT)
    const docs = doc.pages.find((p) => p.slug === 'docs')
    expect(docs.mode).toBe('folder')
    expect(docs).not.toHaveProperty('page_sections') // folders host no sections
    expect(Array.isArray(docs.$children)).toBe(true)
    const intro = docs.$children[0]
    expect(intro.$id).toBe('intro')
    expect(intro.mode).toBe('page')
    expect(intro.page_sections[0].$id).toBe('body') // its inline section
    expect(intro.page_sections[0].type).toBe('Prose')
  })

  it('emits layout_sections top-level with layout_name + area', async () => {
    const { layout_sections } = await siteProjectToDocument(ROOT)
    const header = layout_sections.find((s) => s.area === 'header')
    const footer = layout_sections.find((s) => s.area === 'footer')
    expect(header.layout_name).toBe('default')
    expect(footer.layout_name).toBe('marketing')
    expect(header.content.type).toBe('doc')
  })

  it('emits extensions (url = $id) and collections (name = $id)', async () => {
    const doc = await siteProjectToDocument(ROOT)
    expect(doc.extensions).toEqual([
      { $id: 'https://cdn.example.com/stats/entry.js', url: 'https://cdn.example.com/stats/entry.js' },
    ])
    const col = doc.collections[0]
    expect(col.$id).toBe('articles')
    expect(col.name).toBe('articles')
    expect(col.source).toEqual({ path: 'collections/articles' })
    expect(col.sort).toBe('date desc')
  })

  it('the ENTITY $uuid leads the document; nested items never carry $uuid', async () => {
    // First sync: site.yml has no $uuid → no entity uuid, no item uuids anywhere.
    const first = await siteProjectToDocument(ROOT)
    expect(first).not.toHaveProperty('$uuid')
    const home0 = first.pages.find((p) => p.slug === 'home')
    expect(home0).not.toHaveProperty('$uuid')
    expect(home0.page_sections[0]).not.toHaveProperty('$uuid')

    // The entity uuid (back-filled into site.yml; here via opts.entityUuid) leads the
    // document in canonical key order — but no item ever gets a $uuid on the wire.
    const doc = await siteProjectToDocument(ROOT, {
      entityUuid: '019e0000-0000-7000-8000-0000000000ee',
    })
    expect(doc.$uuid).toBe('019e0000-0000-7000-8000-0000000000ee')
    expect(Object.keys(doc).slice(0, 3)).toEqual(['$uuid', '$id', '$model'])
    const home = doc.pages.find((p) => p.slug === 'home')
    expect(home).not.toHaveProperty('$uuid')
    expect(home.$id).toBe('home') // identity handle stays
    expect(home.page_sections[0]).not.toHaveProperty('$uuid')
  })

  it('reads the entity $uuid from site.yml::$uuid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uwx-site-uuid-'))
    writeFileSync(
      join(dir, 'site.yml'),
      '$uuid: 019e0000-0000-7000-8000-00000000abcd\nname: X\nfoundation: "@a/b@1"\n'
    )
    const doc = await siteProjectToDocument(dir)
    expect(doc.$uuid).toBe('019e0000-0000-7000-8000-00000000abcd')
    rmSync(dir, { recursive: true, force: true })
  })

  it('requires name and foundation', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'uwx-doc-bad-'))
    writeFileSync(join(bare, 'site.yml'), 'name: X\n')
    await expect(siteProjectToDocument(bare)).rejects.toThrow(/foundation/)
    writeFileSync(join(bare, 'site.yml'), 'foundation: "@a/b@1"\n')
    await expect(siteProjectToDocument(bare)).rejects.toThrow(/name/)
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('uwx/site emitSiteSyncPackage', () => {
  it('produces a valid sync-lane .uwx whose body is the nested document', async () => {
    const zip = await emitSiteSyncPackage(ROOT, {
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const files = readZip(zip)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    // names-only Model resolution (sync lane) — no uuid pinned in modelsRequired
    expect(manifest.models_required[0].name_at_export).toBe('@uniweb/site-content')
    expect(manifest.models_required[0].uuid).toBeNull()
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const body = JSON.parse(files.get('entities/site-content.json').toString('utf8'))
    expect(body.$model).toBe('@uniweb/site-content')
    expect(body.info.foundation).toBe('@acme/marketing@1.2.3')
    expect(body.pages.find((p) => p.slug === 'home').page_sections[0].type).toBe('Hero')
  })
})
