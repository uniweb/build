// Site-content projection — info → config files (P2, config slice).
//
// Includes a round-trip against the REAL producer (siteProjectToDocument) so the
// inverse is exercised against the exact document shape it inverts.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import yaml from 'js-yaml'
import {
  siteInfoToConfig,
  sectionRecordToFile,
  pageSectionsToFiles,
  siteContentDocumentToProject,
  siteProjectToDocument,
  declarationsToCollectionsYml,
} from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-site-project-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('siteInfoToConfig — info → config files', () => {
  it('writes site.yml from info, unwrapping localized fields and mapping field names', () => {
    const document = {
      info: {
        name: { en: 'My Site' },
        description: { en: 'A description' },
        foundation: '@acme/base@1.2.3',
        languages: ['en', 'fr'],
        default_language: 'en',
        base: '/docs/',
        build: { split: true },
      },
      extensions: [{ $id: 'https://cdn.example.com/fx/entry.js', url: 'https://cdn.example.com/fx/entry.js' }],
    }

    const report = siteInfoToConfig({ document, siteRoot: dir })
    expect(report.siteConfig).toBe('updated')

    expect(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))).toEqual({
      name: 'My Site',
      description: 'A description',
      foundation: '@acme/base@1.2.3',
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      base: '/docs/',
      build: { split: true },
      extensions: ['https://cdn.example.com/fx/entry.js'],
    })
  })

  it('writes theme.yml (whole object) and head.html (raw file)', () => {
    const document = {
      info: {
        name: { en: 'S' },
        foundation: '@acme/base',
        theme: { vars: { accent: 'red' }, mode: 'dark' },
        head_html: '<meta name="x" content="y">\n',
      },
    }
    const report = siteInfoToConfig({ document, siteRoot: dir })

    expect(report.theme).toBe('updated')
    expect(yaml.load(readFileSync(join(dir, 'theme.yml'), 'utf8'))).toEqual({ vars: { accent: 'red' }, mode: 'dark' })
    expect(report.headHtml).toBe('updated')
    expect(readFileSync(join(dir, 'head.html'), 'utf8')).toBe('<meta name="x" content="y">\n')
  })

  it('preserves untouched site.yml keys and is idempotent', () => {
    writeFileSync(join(dir, 'site.yml'), "foundation: '@acme/base'\npaths:\n  pages: content\nname: Old\n")
    const document = { info: { name: { en: 'New' }, foundation: '@acme/base' } }

    siteInfoToConfig({ document, siteRoot: dir })
    const obj = yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))
    expect(obj.name).toBe('New')
    expect(obj.paths).toEqual({ pages: 'content' }) // untouched key preserved

    // second projection makes no change
    expect(siteInfoToConfig({ document, siteRoot: dir }).siteConfig).toBe('unchanged')
  })

  it('does not write theme.yml / head.html when the document omits them', () => {
    siteInfoToConfig({ document: { info: { name: { en: 'S' }, foundation: '@acme/base' } }, siteRoot: dir })
    expect(existsSync(join(dir, 'theme.yml'))).toBe(false)
    expect(existsSync(join(dir, 'head.html'))).toBe(false)
  })
})

describe('sectionRecordToFile — section record → .md', () => {
  const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

  it('writes frontmatter (type + flat params + background/theme/id) and a markdown body', () => {
    const record = {
      type: 'Hero',
      stable_id: 'hero',
      params: { align: 'center', cta: 'Start' },
      background: '/bg.jpg',
      theme_override: 'dark',
      content: { type: 'doc', content: [para('Hello world')] },
    }
    const f = join(dir, 'hero.md')
    expect(sectionRecordToFile({ filePath: f, record })).toBe('updated')

    const text = readFileSync(f, 'utf8')
    expect(text).toMatch(/^---\n/)
    const fm = yaml.load(text.slice(4, text.indexOf('\n---', 4)))
    expect(fm).toEqual({ type: 'Hero', align: 'center', cta: 'Start', background: '/bg.jpg', theme: 'dark', id: 'hero' })
    expect(text.trimEnd().endsWith('Hello world')).toBe(true)
  })

  it('re-inlines a block-level inset back to ![](@Component){params}', () => {
    const record = {
      type: 'Section',
      content: {
        type: 'doc',
        content: [para('Intro'), { type: 'inset_placeholder', attrs: { refId: 'inset_0', embedKind: 'visual' } }],
      },
      insets: [{ refId: 'inset_0', type: 'Chart', embedKind: 'visual', params: { variant: 'compact' }, title: 'A chart' }],
    }
    const f = join(dir, 'with-inset.md')
    sectionRecordToFile({ filePath: f, record })

    const text = readFileSync(f, 'utf8')
    expect(text).toContain('![A chart](@Chart){variant=compact}')
    // embedKind=visual (the extractor default) is omitted — no spurious attr.
    expect(text).not.toContain('embedKind')
  })

  it('is idempotent', () => {
    const record = { type: 'Hero', content: { type: 'doc', content: [para('Hi')] } }
    const f = join(dir, 'hero.md')
    sectionRecordToFile({ filePath: f, record })
    expect(sectionRecordToFile({ filePath: f, record })).toBe('unchanged')
  })
})

describe('pageSectionsToFiles — clean files + nested sections: array', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  it('writes <stableId>.md files and a nested sections: array (no prefixes)', () => {
    const dirP = join(dir, 'home')
    const pageSections = [
      { $id: 'hero', stable_id: 'hero', type: 'Hero', content: docOf('Welcome') },
      {
        $id: 'features',
        stable_id: 'features',
        type: 'Features',
        content: docOf('Things'),
        $children: [{ $id: 'card-a', stable_id: 'card-a', type: 'Card', content: docOf('A') }],
      },
    ]
    const { sections } = pageSectionsToFiles({ pageDir: dirP, pageSections })

    expect(sections).toEqual(['hero', { features: ['card-a'] }])
    expect(existsSync(join(dirP, 'hero.md'))).toBe(true)
    expect(existsSync(join(dirP, 'features.md'))).toBe(true)
    expect(existsSync(join(dirP, 'card-a.md'))).toBe(true) // child is a clean sibling file
    // no numeric-prefixed files
    expect(existsSync(join(dirP, '1-hero.md'))).toBe(false)
  })
})

describe('siteContentDocumentToProject — pages tree + layout', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const document = {
    info: { name: { en: 'Site' }, foundation: '@a/base' },
    pages: [
      {
        $id: 'home',
        slug: 'home',
        mode: 'page',
        stable_id: 'home',
        is_index: true,
        title: { en: 'Home' },
        page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: docOf('Hi') }],
      },
      {
        $id: 'blog',
        slug: 'blog',
        mode: 'folder',
        title: { en: 'Blog' },
        $children: [
          {
            $id: 'post',
            slug: 'slug',
            mode: 'page',
            is_dynamic: true,
            param_name: 'slug',
            page_sections: [{ $id: 'article', stable_id: 'article', type: 'Article', content: docOf('Body') }],
          },
        ],
      },
    ],
    layout_sections: [{ $id: 'header', area: 'header', layout_name: 'default', type: 'Header', content: docOf('Nav') }],
  }

  it('projects pages (with sections:), a folder, a dynamic [param] page, and layout', () => {
    const report = siteContentDocumentToProject({ document, siteRoot: dir })

    // home page (page mode): page.yml with index + sections, + the section file
    const homeYml = yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8'))
    expect(homeYml).toMatchObject({ id: 'home', index: true, title: 'Home', sections: ['hero'] })
    expect(existsSync(join(dir, 'pages/home/hero.md'))).toBe(true)

    // blog (folder mode): folder.yml, no page.yml
    expect(existsSync(join(dir, 'pages/blog/folder.yml'))).toBe(true)
    expect(existsSync(join(dir, 'pages/blog/page.yml'))).toBe(false)

    // dynamic child page → [slug]/ directory
    expect(existsSync(join(dir, 'pages/blog/[slug]/page.yml'))).toBe(true)
    expect(existsSync(join(dir, 'pages/blog/[slug]/article.md'))).toBe(true)

    // layout (default layout) → layout/<area>.md
    expect(existsSync(join(dir, 'layout/header.md'))).toBe(true)

    // and site.yml was written from info
    expect(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))).toMatchObject({ name: 'Site', foundation: '@a/base' })
    expect(report.pages.length).toBe(3) // home, blog (folder), [slug]
  })

  it('is idempotent across a second projection', () => {
    siteContentDocumentToProject({ document, siteRoot: dir })
    // second run changes nothing on disk (spot-check the section file)
    const before = readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')).toBe(before)
  })

  it('persists per-item uuids in the gitignored .uniweb/ index, NOT in authored files', () => {
    const withUuids = {
      info: { name: { en: 'S' }, foundation: '@a/base' },
      pages: [
        {
          $id: 'home',
          $uuid: '0192-page',
          slug: 'home',
          mode: 'page',
          stable_id: 'home',
          page_sections: [
            { $id: 'hero', $uuid: '0192-hero', stable_id: 'hero', type: 'Hero', content: docOf('Hi') },
            {
              $id: 'features',
              $uuid: '0192-feat',
              stable_id: 'features',
              type: 'Features',
              content: docOf('F'),
              $children: [{ $id: 'card-a', $uuid: '0192-card', stable_id: 'card-a', type: 'Card', content: docOf('A') }],
            },
          ],
        },
      ],
    }
    siteContentDocumentToProject({ document: withUuids, siteRoot: dir })

    // page.yml is clean — no uuid, no ids map.
    const pageYml = yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8'))
    expect(pageYml.uuid).toBeUndefined()
    expect(pageYml.ids).toBeUndefined()
    // the .md body carries no uuid either
    expect(readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')).not.toContain('0192-hero')

    // the uuid → relative-path map lives in the gitignored .uniweb/ index.
    const index = JSON.parse(readFileSync(join(dir, '.uniweb/pull-index.json'), 'utf8'))
    expect(index.items['0192-page']).toBe(join('pages', 'home'))
    expect(index.items['0192-hero']).toBe(join('pages', 'home', 'hero.md'))
    expect(index.items['0192-card']).toBe(join('pages', 'home', 'card-a.md'))
  })
})

describe('siteContentDocumentToProject — reconcile (prune)', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }
  const section = (id, text) => ({ $id: id, stable_id: id, type: 'Sec', content: docOf(text) })
  const page = (slug, sections) => ({ $id: slug, slug, mode: 'page', stable_id: slug, page_sections: sections })

  it('deletes an orphaned section file and drops it from page.yml::sections:', () => {
    const v1 = { info, pages: [page('home', [section('hero', 'Hi'), section('features', 'F')])] }
    siteContentDocumentToProject({ document: v1, siteRoot: dir })
    expect(existsSync(join(dir, 'pages/home/features.md'))).toBe(true)

    const v2 = { info, pages: [page('home', [section('hero', 'Hi')])] }
    const report = siteContentDocumentToProject({ document: v2, siteRoot: dir, prune: true })

    expect(existsSync(join(dir, 'pages/home/features.md'))).toBe(false)
    expect(report.deleted).toContain(join(dir, 'pages/home/features.md'))
    expect(yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8')).sections).toEqual(['hero'])
  })

  it('deletes an orphaned page directory', () => {
    const v1 = { info, pages: [page('home', [section('hero', 'Hi')]), page('about', [section('intro', 'X')])] }
    siteContentDocumentToProject({ document: v1, siteRoot: dir })
    expect(existsSync(join(dir, 'pages/about'))).toBe(true)

    const v2 = { info, pages: [page('home', [section('hero', 'Hi')])] }
    siteContentDocumentToProject({ document: v2, siteRoot: dir, prune: true })
    expect(existsSync(join(dir, 'pages/about'))).toBe(false)
  })

  it('without prune, orphans are left in place', () => {
    siteContentDocumentToProject({ document: { info, pages: [page('home', [section('hero', 'Hi'), section('features', 'F')])] }, siteRoot: dir })
    siteContentDocumentToProject({ document: { info, pages: [page('home', [section('hero', 'Hi')])] }, siteRoot: dir, prune: false })
    expect(existsSync(join(dir, 'pages/home/features.md'))).toBe(true)
  })

  it('safety: an empty incoming set does not wipe an existing level', () => {
    siteContentDocumentToProject({ document: { info, pages: [page('home', [section('hero', 'Hi')])] }, siteRoot: dir })
    siteContentDocumentToProject({ document: { info, pages: [] }, siteRoot: dir, prune: true })
    expect(existsSync(join(dir, 'pages/home'))).toBe(true) // guard: not nuked
  })
})

describe('siteContentDocumentToProject — uuid-anchored rename detection', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }
  const sec = (id, uuid, text) => ({ $id: id, $uuid: uuid, stable_id: id, type: 'Sec', content: docOf(text) })
  const homePage = (sections) => ({ $id: 'home', $uuid: 'P1', slug: 'home', mode: 'page', stable_id: 'home', page_sections: sections })

  it('renames a section .md in place when its uuid maps to a new stable_id (not delete + create)', () => {
    siteContentDocumentToProject({ document: { info, pages: [homePage([sec('hero', 'S1', 'Hi'), sec('features', 'S2', 'F')])] }, siteRoot: dir })
    assert_exists('pages/home/features.md')

    // The app renamed section S2: features → capabilities (same uuid).
    const report = siteContentDocumentToProject({
      document: { info, pages: [homePage([sec('hero', 'S1', 'Hi'), sec('capabilities', 'S2', 'F')])] },
      siteRoot: dir,
      prune: true,
    })

    expect(existsSync(join(dir, 'pages/home/features.md'))).toBe(false)
    expect(existsSync(join(dir, 'pages/home/capabilities.md'))).toBe(true)
    expect(report.renamed).toContainEqual({ from: join(dir, 'pages/home/features.md'), to: join(dir, 'pages/home/capabilities.md') })
    expect(report.deleted).toEqual([]) // a rename is NOT a delete
    const pageYml = yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8'))
    expect(pageYml.sections).toEqual(['hero', 'capabilities'])
    expect(pageYml.ids).toBeUndefined() // identity lives in .uniweb/, not page.yml
  })

  it('relocates a section moved across pages (A→B) instead of delete + create (A7)', () => {
    const pg = (slug, uuid, sections) => ({ $id: slug, $uuid: uuid, slug, mode: 'page', stable_id: slug, page_sections: sections })

    // v1: home has hero + features; about has intro.
    siteContentDocumentToProject({
      document: { info, pages: [pg('home', 'P1', [sec('hero', 'S1', 'Hi'), sec('features', 'S2', 'F')]), pg('about', 'P2', [sec('intro', 'S3', 'X')])] },
      siteRoot: dir,
    })
    assert_exists('pages/home/features.md')

    // v2: the app moved section S2 (features) from home to about. Same uuid.
    const report = siteContentDocumentToProject({
      document: { info, pages: [pg('home', 'P1', [sec('hero', 'S1', 'Hi')]), pg('about', 'P2', [sec('intro', 'S3', 'X'), sec('features', 'S2', 'F')])] },
      siteRoot: dir,
      prune: true,
    })

    expect(existsSync(join(dir, 'pages/home/features.md'))).toBe(false)
    expect(existsSync(join(dir, 'pages/about/features.md'))).toBe(true)
    expect(report.renamed).toContainEqual({ from: join(dir, 'pages/home/features.md'), to: join(dir, 'pages/about/features.md') })
    expect(report.deleted).toEqual([]) // a cross-page move is a relocation, not a delete
    expect(yaml.load(readFileSync(join(dir, 'pages/about/page.yml'), 'utf8')).sections).toEqual(['intro', 'features'])
  })

  it('renames a page directory in place when its uuid maps to a new slug', () => {
    siteContentDocumentToProject({ document: { info, pages: [homePage([sec('hero', 'S1', 'Hi')])] }, siteRoot: dir })
    assert_exists('pages/home/hero.md')

    // The app renamed the page slug: home → start (same uuid P1).
    const renamed = { $id: 'home', $uuid: 'P1', slug: 'start', mode: 'page', stable_id: 'home', page_sections: [sec('hero', 'S1', 'Hi')] }
    const report = siteContentDocumentToProject({ document: { info, pages: [renamed] }, siteRoot: dir, prune: true })

    expect(existsSync(join(dir, 'pages/home'))).toBe(false)
    expect(existsSync(join(dir, 'pages/start/hero.md'))).toBe(true) // sections moved with the dir
    expect(report.renamed).toContainEqual({ from: join(dir, 'pages/home'), to: join(dir, 'pages/start') })
    expect(report.deleted).toEqual([])
  })

  function assert_exists(rel) {
    expect(existsSync(join(dir, rel))).toBe(true)
  }
})

describe('pages lane fixed point — project → re-produce', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  // The section tree as the `sections:` nested shape, for comparison.
  const treeOf = (sections) =>
    (sections || []).map((s) => {
      const id = s.stable_id || s.$id
      const kids = Array.isArray(s.$children) ? treeOf(s.$children) : []
      return kids.length ? { [id]: kids } : id
    })

  it('projecting page sections to page.yml::sections: round-trips through the producer (order + nesting)', async () => {
    const document = {
      info: { name: { en: 'S' }, foundation: '@a/base' },
      pages: [
        {
          $id: 'home',
          slug: 'home',
          mode: 'page',
          stable_id: 'home',
          is_index: true,
          page_sections: [
            { $id: 'hero', stable_id: 'hero', type: 'Hero', content: docOf('Hi') },
            {
              $id: 'features',
              stable_id: 'features',
              type: 'Features',
              content: docOf('F'),
              $children: [{ $id: 'card-a', stable_id: 'card-a', type: 'Card', content: docOf('A') }],
            },
          ],
        },
      ],
    }

    const site = join(dir, 'site')
    mkdirSync(site, { recursive: true })
    siteContentDocumentToProject({ document, siteRoot: site })

    // The producer must read page.yml::sections: to recover order + nesting.
    const reproduced = await siteProjectToDocument(site)
    const home = reproduced.pages.find((p) => p.$id === 'home')
    expect(treeOf(home.page_sections)).toEqual(['hero', { features: ['card-a'] }])
  })
})

describe('siteInfoToConfig — round-trip against the real producer', () => {
  it('a site.yml/theme.yml/head.html projected from the produced document matches the source config', async () => {
    // Author a source site, with no pages (the producer tolerates an absent pages/).
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'site.yml'),
      "name: Round Trip\nfoundation: '@acme/base@2.0.0'\nlanguages:\n  - en\n  - fr\ndefaultLanguage: en\nbase: /app/\n"
    )
    writeFileSync(join(src, 'theme.yml'), 'vars:\n  accent: blue\n')
    writeFileSync(join(src, 'head.html'), '<link rel="icon" href="/f.ico">\n')

    const document = await siteProjectToDocument(src)

    // Project into a fresh, empty destination.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })

    const siteYml = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(siteYml).toMatchObject({
      name: 'Round Trip',
      foundation: '@acme/base@2.0.0',
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      base: '/app/',
    })
    expect(yaml.load(readFileSync(join(dest, 'theme.yml'), 'utf8'))).toEqual({ vars: { accent: 'blue' } })
    expect(readFileSync(join(dest, 'head.html'), 'utf8')).toBe('<link rel="icon" href="/f.ico">\n')
  })
})

describe('collection declarations — round-trip against the real producer', () => {
  const SITE_YML =
    "name: Decls\nfoundation: '@acme/base@1.0.0'\n"

  // A source collections.yml exercising: a default-schema collection (no schema
  // key, default path), an explicit-schema collection with a path override, and a
  // full set of query/display fields incl. detailUrl (camelCase on the file side).
  const COLLECTIONS_YML =
    'collections:\n' +
    '  articles:\n' +
    '    where:\n' +
    '      published: true\n' +
    '    sort: -date\n' +
    '    deferred:\n' +
    '      - body\n' +
    '    detailUrl: /api/articles/{slug}\n' +
    '  products:\n' +
    '    path: items\n' +
    "    schema: '@acme/product'\n" +
    '    limit: 20\n' +
    '    queryable:\n' +
    '      category:\n' +
    '        type: enum\n'

  it('projecting document.collections back to collections.yml is a producer fixed point', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'collections'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), SITE_YML)
    writeFileSync(join(src, 'collections', 'collections.yml'), COLLECTIONS_YML)

    const document = await siteProjectToDocument(src)
    expect(document.collections.length).toBe(2)

    // Project into a fresh destination, then re-produce and compare the wire decls.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'site.yml'), SITE_YML)
    siteContentDocumentToProject({ document, siteRoot: dest })

    const reproduced = await siteProjectToDocument(dest)
    expect(reproduced.collections).toEqual(document.collections)

    // The projected file stays terse: the default-schema collection gains no
    // explicit schema, and the default-path collection gains no path.
    const projected = yaml.load(readFileSync(join(dest, 'collections', 'collections.yml'), 'utf8'))
    expect(projected.collections.articles.schema).toBeUndefined()
    expect(projected.collections.articles.path).toBeUndefined()
    expect(projected.collections.articles.detailUrl).toBe('/api/articles/{slug}')
    expect(projected.collections.products).toMatchObject({ path: 'items', schema: '@acme/product', limit: 20 })
  })

  it('preserves sibling keys ($uuid, sync) when rewriting the collections: block', () => {
    const site = join(dir, 'site')
    mkdirSync(join(site, 'collections'), { recursive: true })
    writeFileSync(
      join(site, 'collections', 'collections.yml'),
      '$uuid: F-123\nsync: false\ncollections:\n  old:\n    schema: stale\n'
    )

    const document = {
      collections: [{ $id: 'articles', name: 'articles', source: { path: 'collections/articles' }, schema: '@/article' }],
    }
    const report = declarationsToCollectionsYml({ document, siteRoot: site })
    expect(report.collections).toBe('updated')

    const out = yaml.load(readFileSync(join(site, 'collections', 'collections.yml'), 'utf8'))
    expect(out.$uuid).toBe('F-123')
    expect(out.sync).toBe(false)
    // the incoming `articles` is added; the pre-existing `old` is left in place
    expect(out.collections.articles).toEqual({})
    expect(out.collections.old).toEqual({ schema: 'stale' })
  })
})

describe('localized scalar projection → locales/{locale}.json (B)', () => {
  const info = (extra) => ({ name: { en: 'Atlas', es: 'Atlas ES', fr: 'Atlas FR' }, foundation: '@a/base', ...extra })

  it('writes the source value inline and target locales to locales/{locale}.json keyed by source hash', () => {
    const document = {
      info: info(),
      pages: [
        { $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', title: { en: 'Home', es: 'Inicio' }, page_sections: [] },
      ],
    }
    const report = siteContentDocumentToProject({ document, siteRoot: dir })

    // source locale stays inline in the config files
    expect(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8')).name).toBe('Atlas')
    expect(yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8')).title).toBe('Home')

    // target locales → locales/{locale}.json keyed by hash(source)
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'))
    expect(es[computeHash('Atlas')]).toBe('Atlas ES')
    expect(es[computeHash('Home')]).toBe('Inicio')
    const fr = JSON.parse(readFileSync(join(dir, 'locales/fr.json'), 'utf8'))
    expect(fr[computeHash('Atlas')]).toBe('Atlas FR')
    expect(fr[computeHash('Home')]).toBeUndefined() // 'Home' only had an es translation
    expect(report.locales.es).toBe('updated')
  })

  it('merges into an existing locales/{locale}.json, preserving other entries', () => {
    mkdirSync(join(dir, 'locales'), { recursive: true })
    writeFileSync(join(dir, 'locales/es.json'), JSON.stringify({ existinghash: 'kept' }))

    siteContentDocumentToProject({ document: { info: { name: { en: 'Atlas', es: 'Atlas ES' }, foundation: '@a/base' } }, siteRoot: dir })

    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'))
    expect(es.existinghash).toBe('kept')
    expect(es[computeHash('Atlas')]).toBe('Atlas ES')
  })

  it('a source-only document writes no locale files (backward compatible)', () => {
    siteContentDocumentToProject({ document: { info: { name: { en: 'Atlas' }, foundation: '@a/base' } }, siteRoot: dir })
    expect(existsSync(join(dir, 'locales'))).toBe(false)
  })

  it('projects a section content structural map to locales/{locale}.json and writes the source body', () => {
    const srcDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] }
    const document = {
      info: { name: { en: 'S' }, foundation: '@a/base' },
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home',
          page_sections: [
            { $id: 'hero', stable_id: 'hero', type: 'Hero', content: { en: srcDoc, es: { 'Hello world': 'Hola mundo' } } },
          ],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: dir })

    // source-locale doc → the .md body
    expect(readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')).toContain('Hello world')
    // structural map → locales/es.json keyed by hash(source text)
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'))
    expect(es[computeHash('Hello world')]).toBe('Hola mundo')
  })

  it('tracks (does not silently drop) a target-locale free-form body override', () => {
    const srcDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] }
    const ffDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hola distinto' }] }] }
    const report = siteContentDocumentToProject({
      document: {
        info: { name: { en: 'S' }, foundation: '@a/base' },
        pages: [{ $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: { en: srcDoc, es: ffDoc } }] }],
      },
      siteRoot: dir,
    })
    expect(readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')).toContain('Hi') // source body still written
    expect(report.freeformPending).toContain('es') // freeform target surfaced, not dropped
  })
})

describe('localized scalar round-trip: producer ⇄ projector (B)', () => {
  it('produce → project → produce recovers multi-locale scalars', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'locales'), { recursive: true })
    mkdirSync(join(src, 'pages/home'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: Atlas\nfoundation: '@a/base'\nlanguages: [en, es]\n")
    writeFileSync(join(src, 'pages/home/page.yml'), 'title: Home\nindex: true\n')
    writeFileSync(
      join(src, 'locales/es.json'),
      JSON.stringify({ [computeHash('Atlas')]: 'Atlas ES', [computeHash('Home')]: 'Inicio' })
    )

    // Producer wraps scalars per-locale by reading locales/es.json.
    const doc1 = await siteProjectToDocument(src)
    expect(doc1.info.name).toEqual({ en: 'Atlas', es: 'Atlas ES' })
    const home1 = doc1.pages.find((p) => p.$id === 'home')
    expect(home1.title).toEqual({ en: 'Home', es: 'Inicio' })

    // Project to a fresh dir, then re-produce — the multi-locale scalars survive.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    const doc2 = await siteProjectToDocument(dest)
    expect(doc2.info.name).toEqual(doc1.info.name)
    expect(doc2.pages.find((p) => p.$id === 'home').title).toEqual(home1.title)
  })
})

describe('info.favicon / info.assets (A5)', () => {
  it('round-trips site.yml::favicon and never produces or projects assets', async () => {
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: S\nfoundation: '@a/base'\nfavicon: /assets/icon.png\n")

    const document = await siteProjectToDocument(src)
    expect(document.info.favicon).toBe('/assets/icon.png')
    expect(document.info.assets).toBeUndefined() // assets are build-derived, never produced

    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).favicon).toBe('/assets/icon.png')

    // an info.assets on a pulled document is ignored (not written anywhere)
    siteInfoToConfig({ document: { info: { assets: { 'v1/x.jpg': {} } } }, siteRoot: dest })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).assets).toBeUndefined()
  })
})

describe('siteContentDocumentToProject — unsafe stable_id filename safety (A8)', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }

  it('uses a safe filename, keeps the true id in frontmatter, and round-trips the real stable_id', async () => {
    const document = {
      info,
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home',
          page_sections: [{ $id: 'odd', stable_id: 'odd id/with spaces', type: 'Sec', content: docOf('X') }],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: dir })

    // Exactly one section file, with a filesystem-safe name (no space, no slash).
    const files = readdirSync(join(dir, 'pages/home')).filter((f) => f.endsWith('.md'))
    expect(files.length).toBe(1)
    const fname = files[0]
    expect(fname).toMatch(/^[A-Za-z0-9._-]+\.md$/)

    // The page.yml::sections leaf is the safe base (so producer resolution matches).
    const pageYml = yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8'))
    expect(pageYml.sections[0]).toBe(basename(fname, '.md'))

    // Round trip: the producer recovers the TRUE stable_id from frontmatter id:.
    const reproduced = await siteProjectToDocument(dir)
    const sec = reproduced.pages.find((p) => p.$id === 'home').page_sections[0]
    expect(sec.stable_id).toBe('odd id/with spaces')
  })

  it('leaves an already-safe stable_id as its filename (backward compatible)', () => {
    const document = { info, pages: [{ $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Sec', content: docOf('X') }] }] }
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(existsSync(join(dir, 'pages/home/hero.md'))).toBe(true)
  })
})

describe('siteContentDocumentToProject — page.yml surgical merge (A9)', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }

  it('preserves author-added keys and drops removed managed keys', () => {
    const home = join(dir, 'pages/home')
    mkdirSync(home, { recursive: true })
    // An existing page.yml: a managed key (hidden), a managed key being updated
    // (title), an author-added unknown key (customNote), and sections.
    writeFileSync(join(home, 'page.yml'), 'title: Old\nhidden: true\ncustomNote: keep-me\nsections:\n  - stale\n')

    const document = {
      info,
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', title: { en: 'New Title' },
          page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: docOf('Hi') }],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: dir })

    const yml = yaml.load(readFileSync(join(home, 'page.yml'), 'utf8'))
    expect(yml.customNote).toBe('keep-me') // author-added key preserved
    expect(yml.title).toBe('New Title') // managed key updated
    expect(yml.sections).toEqual(['hero']) // managed sections replaced wholesale
    expect(yml.hidden).toBeUndefined() // managed key absent from the record → dropped
  })
})

describe('siteContentDocumentToProject — layout reconcile (A6)', () => {
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const info = { name: { en: 'S' }, foundation: '@a/base' }
  const lsec = (area, layoutName, uuid, text) => ({ $id: area, $uuid: uuid, stable_id: area, layout_name: layoutName, area, type: 'L', content: docOf(text) })

  it('prunes an orphaned default-layout file and an emptied named-layout dir', () => {
    const v1 = { info, layout_sections: [lsec('header', 'default', 'L1', 'H'), lsec('footer', 'default', 'L2', 'F'), lsec('nav', 'mobile', 'L3', 'N')] }
    siteContentDocumentToProject({ document: v1, siteRoot: dir })
    expect(existsSync(join(dir, 'layout/footer.md'))).toBe(true)
    expect(existsSync(join(dir, 'layout/mobile/nav.md'))).toBe(true)

    // v2 keeps only the default header; footer + the whole mobile layout are gone.
    const report = siteContentDocumentToProject({ document: { info, layout_sections: [lsec('header', 'default', 'L1', 'H')] }, siteRoot: dir, prune: true })

    expect(existsSync(join(dir, 'layout/header.md'))).toBe(true)
    expect(existsSync(join(dir, 'layout/footer.md'))).toBe(false)
    expect(existsSync(join(dir, 'layout/mobile'))).toBe(false) // emptied named-layout dir removed
    expect(report.deleted).toContain(join(dir, 'layout/footer.md'))
  })

  it('renames a layout file in place when its uuid maps to a new area (not delete + create)', () => {
    siteContentDocumentToProject({ document: { info, layout_sections: [lsec('header', 'default', 'L1', 'H')] }, siteRoot: dir })
    expect(existsSync(join(dir, 'layout/header.md'))).toBe(true)

    // The app renamed the layout area header → topbar (same uuid L1).
    const report = siteContentDocumentToProject({ document: { info, layout_sections: [lsec('topbar', 'default', 'L1', 'H')] }, siteRoot: dir, prune: true })

    expect(existsSync(join(dir, 'layout/header.md'))).toBe(false)
    expect(existsSync(join(dir, 'layout/topbar.md'))).toBe(true)
    expect(report.renamed).toContainEqual({ from: join(dir, 'layout/header.md'), to: join(dir, 'layout/topbar.md') })
    expect(report.deleted).toEqual([])
  })

  it('safety: an empty incoming layout set does not wipe existing layout files', () => {
    siteContentDocumentToProject({ document: { info, layout_sections: [lsec('header', 'default', 'L1', 'H')] }, siteRoot: dir })
    siteContentDocumentToProject({ document: { info, layout_sections: [] }, siteRoot: dir, prune: true })
    expect(existsSync(join(dir, 'layout/header.md'))).toBe(true) // guard: not nuked
  })
})

describe('whole-site framework-dialect round-trip is a producer fixed point (A10)', () => {
  // Bootstrap valid source files by projecting a seed document, then assert the
  // canonical loop — produce → project → produce — recovers the SAME wire
  // document. Combines config, collection declarations, a nested section tree, an
  // inline inset (an inline cite — exercising the inline-inset codec end to end),
  // a second page, and a layout section. Single-locale; the multi-locale facet
  // joins once the localization round-trip (B) lands.
  const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  // A body with an inline cite — the construct the inline-inset fix restored.
  const bodyWithCite = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'As shown ' },
          { type: 'inset_ref', attrs: { component: 'Cite', embedKind: 'text', key: '@darwin', alt: null } },
          { type: 'text', text: ' in the literature.' },
        ],
      },
    ],
  }

  it('produce → project → produce recovers the same document', async () => {
    const seed = {
      info: { name: { en: 'Atlas' }, foundation: '@acme/base@3.0.0', languages: ['en'], base: '/atlas/' },
      collections: [
        { $id: 'articles', name: 'articles', source: { path: 'collections/articles' }, schema: '@/article', sort: '-date' },
      ],
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', is_index: true,
          page_sections: [
            { $id: 'hero', stable_id: 'hero', type: 'Hero', content: bodyWithCite },
            {
              $id: 'features', stable_id: 'features', type: 'Features', content: docOf('Our features'),
              $children: [{ $id: 'card-a', stable_id: 'card-a', type: 'Card', content: docOf('Card A') }],
            },
          ],
        },
        {
          $id: 'about', slug: 'about', mode: 'page', stable_id: 'about', title: { en: 'About' },
          page_sections: [{ $id: 'intro', stable_id: 'intro', type: 'Text', content: docOf('Hello') }],
        },
      ],
      layout_sections: [
        { $id: 'header', stable_id: 'header', area: 'header', layout_name: 'default', type: 'Header', content: docOf('Nav') },
      ],
    }

    // Bootstrap valid files from the seed.
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    siteContentDocumentToProject({ document: seed, siteRoot: src })

    // The canonical loop: first produce is the reference; project it to a fresh
    // dir; second produce must equal the first.
    const doc1 = await siteProjectToDocument(src)
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    const doc2 = await siteProjectToDocument(dest)

    expect(doc2).toEqual(doc1)

    // And the inline cite survived: the producer extracts it to an inline
    // inset_placeholder + an insets[] entry; projection re-inlines it and the
    // (A1) inline-inset serializer writes `[@darwin]` — recovered identically.
    const home = doc1.pages.find((p) => p.$id === 'home')
    const hero = home.page_sections.find((s) => s.stable_id === 'hero')
    const placeholder = hero.content.content[0].content.find((n) => n.type === 'inset_placeholder')
    expect(placeholder).toBeDefined()
    expect(hero.insets).toContainEqual(expect.objectContaining({ type: 'Cite', embedKind: 'text', params: { key: '@darwin' } }))
    // the projected source markdown carries the inline cite, not a dropped inset
    expect(readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')).toContain('As shown [@darwin] in the literature.')
  })
})
