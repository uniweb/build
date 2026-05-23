import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  siteProjectToEntity,
  emitSitePackage,
  readZip,
  SITE_CONTENT_TYPE_UUID,
} from '../src/uwx/index.js'

let ROOT

function w(rel, body) {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-site-'))

  w(
    'site.yml',
    [
      'name: Acme Site',
      'description: A test site',
      'defaultLanguage: en',
      'languages: [en, fr]',
      'foundation: "@acme/marketing@1.2.3"',
      'base: /docs/',
      'index: home',
      'build: { prerender: true }',
      'extensions:',
      '  - https://cdn.example.com/stats/entry.js',
      'collections:',
      '  articles:',
      '    path: collections/articles',
      '    sort: date desc',
      '    deferred: [body]',
      '    detailUrl: /api/articles/{slug}',
      '',
    ].join('\n')
  )
  w('theme.yml', 'colors:\n  primary: "#0099ff"\n')
  w('head.html', '<meta name="x" content="y">\n')

  // 1-home (page) with a section carrying background/theme + an inset
  w('pages/1-home/page.yml', 'id: home\ntitle: Home\n')
  w(
    'pages/1-home/1-hero.md',
    [
      '---',
      'type: Hero',
      'background:',
      '  image: /img/bg.jpg',
      'theme: dark',
      'cta: Get Started',
      '---',
      '# Welcome',
      '',
      'Intro ![Logo](@Gallery){cols=3} here.',
      '',
    ].join('\n')
  )

  // 2-about (page)
  w('pages/2-about/page.yml', 'title: About\n')
  w('pages/2-about/about.md', '---\ntype: Prose\n---\n# About us\n')

  // 3-docs (folder container) with a child page
  w('pages/3-docs/folder.yml', 'title: Docs\n')
  w('pages/3-docs/1-intro/page.yml', 'title: Intro\n')
  w('pages/3-docs/1-intro/intro.md', '---\ntype: Prose\n---\n# Intro\n')

  // layout areas: default + a named layout
  w('layout/header.md', '---\ntype: Header\n---\n# Site\n')
  w('layout/marketing/footer.md', '---\ntype: Footer\n---\n# Footer\n')
})

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('uwx/site siteProjectToEntity', () => {
  it('maps to the @uniweb/site-content Model shape', async () => {
    const e = await siteProjectToEntity(ROOT)
    expect(e.model_uuid).toBe(SITE_CONTENT_TYPE_UUID)
    expect(e.owner_uuid).toBeNull()
    const count = (s) => e.items.filter((i) => i.section === s).length
    expect(count('info')).toBe(1)
    expect(count('pages')).toBe(4) // home, about, docs, docs/intro
    expect(count('page_sections')).toBe(3) // hero, about, intro
    expect(count('layout_sections')).toBe(2) // header, footer
    expect(count('extensions')).toBe(1)
    expect(count('collections')).toBe(1)
  })

  it('builds info with foundation_ref (the Model change), not an entity_ref', async () => {
    const info = (await siteProjectToEntity(ROOT)).items.find(
      (i) => i.section === 'info'
    ).data
    expect(info.name).toEqual({ en: 'Acme Site' }) // localized wrap
    expect(info.foundation_ref).toBe('@acme/marketing@1.2.3')
    expect(info).not.toHaveProperty('foundation') // backend resolves it
    expect(info.theme).toEqual({ colors: { primary: '#0099ff' } })
    expect(info.locales).toEqual(['en', 'fr'])
    expect(info.default_locale).toBe('en')
    expect(info.base_path).toBe('/docs/')
    expect(info.head_html).toContain('<meta')
    expect(info.build_options).toEqual({ prerender: true })
  })

  it('throws when name or foundation is missing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'uwx-bad-'))
    writeFileSync(join(bare, 'site.yml'), 'name: X\n') // no foundation
    await expect(siteProjectToEntity(bare)).rejects.toThrow(/foundation/)
    writeFileSync(join(bare, 'site.yml'), 'foundation: "@a/b@1"\n') // no name
    await expect(siteProjectToEntity(bare)).rejects.toThrow(/name/)
    rmSync(bare, { recursive: true, force: true })
  })

  it('maps the page tree with mode, slug, order, positional parent_path', async () => {
    const pages = (await siteProjectToEntity(ROOT)).items.filter(
      (i) => i.section === 'pages'
    )
    const bySlug = Object.fromEntries(pages.map((p) => [p.data.slug, p]))

    expect(bySlug.home.data.mode).toBe('page')
    expect(bySlug.home.data.is_index).toBe(true) // site.yml index: home
    expect(bySlug.home.parent_path).toBeNull() // top-level
    expect(bySlug.home.order_number).toBe(0)
    expect(bySlug.about.order_number).toBe(1)

    expect(bySlug.docs.data.mode).toBe('folder') // folder.yml present
    const docsOrder = bySlug.docs.order_number
    // child page nests under docs via positional parent_path
    expect(bySlug.intro.parent_path).toEqual([['pages', docsOrder]])
    expect(bySlug.intro.data.mode).toBe('page')
  })

  it('maps page_sections: type, raw ProseMirror, background/theme lifted', async () => {
    const e = await siteProjectToEntity(ROOT)
    const home = e.items.find(
      (i) => i.section === 'pages' && i.data.slug === 'home'
    )
    const hero = e.items.find(
      (i) => i.section === 'page_sections' && i.data.type === 'Hero'
    )
    expect(hero.parent_section).toBe('pages')
    // parent_path ends at the home page item (positional chain)
    expect(hero.parent_path).toEqual([['pages', home.order_number]])
    expect(hero.order_number).toBe(0)
    expect(hero.data.content.type).toBe('doc') // raw ProseMirror
    expect(hero.data.background).toEqual({ image: '/img/bg.jpg' }) // lifted out of params
    expect(hero.data.theme_override).toBe('dark') // lifted out of params
    expect(hero.data.params).toEqual({ cta: 'Get Started' }) // remainder
    expect(hero.data).not.toHaveProperty('theme')
  })

  it('maps layout_sections with layout_name + area', async () => {
    const ls = (await siteProjectToEntity(ROOT)).items.filter(
      (i) => i.section === 'layout_sections'
    )
    const header = ls.find((i) => i.data.area === 'header')
    const footer = ls.find((i) => i.data.area === 'footer')
    expect(header.data.layout_name).toBe('default')
    expect(footer.data.layout_name).toBe('marketing')
    expect(header.data.content.type).toBe('doc')
  })

  it('maps extensions (url is the round-trip source of truth) and collections', async () => {
    const e = await siteProjectToEntity(ROOT)
    const ext = e.items.find((i) => i.section === 'extensions')
    expect(ext.data).toEqual({ url: 'https://cdn.example.com/stats/entry.js' })
    const col = e.items.find((i) => i.section === 'collections')
    expect(col.data.name).toBe('articles')
    expect(col.data.source).toEqual({ path: 'collections/articles' })
    expect(col.data.sort).toBe('date desc')
    expect(col.data.deferred).toEqual(['body'])
    expect(col.data.detail_url).toBe('/api/articles/{slug}')
  })

  it('honors entityUuid and sourceLocale options', async () => {
    const u = '019e2500-0000-7000-8000-000000000000'
    const e = await siteProjectToEntity(ROOT, {
      entityUuid: u,
      sourceLocale: 'fr',
    })
    expect(e.uuid).toBe(u)
    expect(e.items.find((i) => i.section === 'info').data.name).toEqual({
      fr: 'Acme Site',
    })
  })
})

describe('uwx/site emitSitePackage', () => {
  it('produces a valid @uniweb/site-content .uwx end-to-end', async () => {
    const zip = await emitSitePackage(ROOT, {
      exportedAt: '2026-01-01T00:00:00Z',
    })
    const files = readZip(zip)
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
    expect(manifest.format).toBe('uwx/1')
    expect(manifest.subtype).toBe('entity')
    expect(manifest.models_required[0].uuid).toBe(SITE_CONTENT_TYPE_UUID)
    expect(manifest.package_sha256).toMatch(/^[0-9a-f]{64}$/)

    const entity = JSON.parse(
      files.get(`entities/${manifest.roots[0]}.json`).toString('utf8')
    )
    expect(entity.model_uuid).toBe(SITE_CONTENT_TYPE_UUID)
    expect(
      entity.items.find((i) => i.section === 'info').data.foundation_ref
    ).toBe('@acme/marketing@1.2.3')
  })
})
