// Site-content projection — info → config files (P2, config slice).
//
// Includes a round-trip against the REAL producer (siteProjectToDocument) so the
// inverse is exercised against the exact document shape it inverts.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  siteInfoToConfig,
  sectionRecordToFile,
  pageSectionsToFiles,
  siteContentDocumentToProject,
  siteProjectToDocument,
  declarationsToCollectionsYml,
} from '../src/uwx/index.js'

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
