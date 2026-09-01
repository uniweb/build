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
  declarationsToQueriesYml,
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
        keywords: ['saas', 'tools'],
        seo: { image: '/og.png', ogTitle: 'My Site OG' },
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
      keywords: ['saas', 'tools'], // site-level keywords (unwrapped to source locale)
      seo: { image: '/og.png', ogTitle: 'My Site OG' }, // site-level social/SEO block (verbatim)
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
    expect(homeYml).toMatchObject({ id: 'home', index: true, title: 'Home', sections: ['hero', '...'] })
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
    expect(yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8')).sections).toEqual(['hero', '...'])
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
    expect(pageYml.sections).toEqual(['hero', 'capabilities', '...'])
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
    expect(yaml.load(readFileSync(join(dir, 'pages/about/page.yml'), 'utf8')).sections).toEqual(['intro', 'features', '...'])
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
      "name: Round Trip\nfoundation: '@acme/base@2.0.0'\nlanguages:\n  - en\n  - fr\ndefaultLanguage: en\nbase: /app/\nkeywords:\n  - marketing\n  - docs\nseo:\n  image: /og-default.png\n  ogTitle: Round Trip Social\n"
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
      keywords: ['marketing', 'docs'], // localized list survives produce → project
      seo: { image: '/og-default.png', ogTitle: 'Round Trip Social' }, // verbatim social/SEO block
    })
    expect(yaml.load(readFileSync(join(dest, 'theme.yml'), 'utf8'))).toEqual({ vars: { accent: 'blue' } })
    expect(readFileSync(join(dest, 'head.html'), 'utf8')).toBe('<link rel="icon" href="/f.ico">\n')
  })

  // This lane is an explicit allowlist while the bundle lane spreads all of
  // site.yml, so a key that reaches the runtime for free on a static host is
  // dropped in silence here unless it is listed. Both spellings are asserted
  // because the object form is the one that would survive a `typeof === string`
  // shortcut in either direction.
  it.each([
    ['shorthand string', '/forms'],
    ['object form', { endpoint: '/forms' }],
    ['absolute URL', 'https://forms.example.com/intake'],
  ])('carries site.yml::submit through produce → project (%s)', async (_label, submit) => {
    const src = join(dir, `src-submit-${_label.replace(/\W/g, '')}`)
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'site.yml'),
      `name: Forms\nfoundation: '@acme/base@2.0.0'\ndefaultLanguage: en\nsubmit: ${JSON.stringify(submit)}\n`
    )

    const document = await siteProjectToDocument(src)
    expect(document.info.submit).toEqual(submit)

    const dest = join(dir, `dest-submit-${_label.replace(/\W/g, '')}`)
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })

    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).submit).toEqual(submit)
  })

  /**
   * `forms:` is what a HOST reports about a site, read by the runtime from the
   * served payload config. The bundle lane spreads all of site.yml, so writing
   * it there is the local way to exercise that path without a host — and this
   * asserts the property that makes doing so safe: the allowlist does not carry
   * it, so a synced site's `forms` can only have come from its host. If someone
   * ever adds it to the allowlist "for symmetry", a site file starts
   * impersonating the host and this fails.
   */
  it('does NOT carry site.yml::forms across the sync wire', async () => {
    const src = join(dir, 'src-forms')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'site.yml'),
      "name: Mock Host\nfoundation: '@acme/base@2.0.0'\nforms:\n  endpoint: /_submit\n"
    )

    const document = await siteProjectToDocument(src)

    expect(document.info).not.toHaveProperty('forms')
  })

  it('omits submit entirely when the site declares none', async () => {
    const src = join(dir, 'src-nosubmit')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: No Forms\nfoundation: '@acme/base@2.0.0'\n")

    const document = await siteProjectToDocument(src)

    // Absent, not null — the runtime distinguishes "declared nothing" from a
    // declaration whose value happens to be empty.
    expect(document.info).not.toHaveProperty('submit')
  })
})

describe('collection declarations — round-trip against the real producer', () => {
  const SITE_YML =
    "name: Decls\nfoundation: '@acme/base@1.0.0'\n"

  // A source queries.yml exercising: a default-schema file-based query (no schema
  // key, no path — the pool answers), a REMOTE query whose `url:` is the one source
  // that survives the round trip, and a full set of query/display fields incl.
  // detailUrl (camelCase on the file side).
  const QUERIES_YML =
    'articles:\n' +
    '  where:\n' +
    '    published: true\n' +
    '  sort: -date\n' +
    '  deferred:\n' +
    '    - body\n' +
    '  detailUrl: /api/articles/{slug}\n' +
    'products:\n' +
    "  url: https://api.example.com/products\n" +
    "  schema: '@acme/product'\n" +
    '  limit: 20\n' +
    '  queryable:\n' +
    '    category:\n' +
    '      type: enum\n'

  it('projecting document.queries back to queries.yml is a producer fixed point', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'collections'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), SITE_YML)
    writeFileSync(join(src, 'queries.yml'), QUERIES_YML)

    const document = await siteProjectToDocument(src)
    expect(document.queries.length).toBe(2)

    // Project into a fresh destination, then re-produce and compare the wire decls.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'site.yml'), SITE_YML)
    siteContentDocumentToProject({ document, siteRoot: dest })

    const reproduced = await siteProjectToDocument(dest)
    expect(reproduced.queries).toEqual(document.queries)

    // The projected file stays terse: the default-schema query gains no explicit
    // schema, and the default-path query gains no path. A BARE map — no root key.
    const projected = yaml.load(readFileSync(join(dest, 'queries.yml'), 'utf8'))
    expect(projected.articles.schema).toBeUndefined()
    expect(projected.articles.path).toBeUndefined()
    expect(projected.articles.detailUrl).toBe('/api/articles/{slug}')
    // ⭐ A REMOTE source is the one that still round-trips a `source`. A file-based
    // query emits none: `entities/{schema}/` is the pool and `schema:` addresses it,
    // so a path on the wire would be a derivation written back as authored config.
    expect(projected.products).toMatchObject({
      url: 'https://api.example.com/products',
      schema: '@acme/product',
      limit: 20,
    })
    expect(projected.articles.path).toBeUndefined()
  })

  it('preserves untouched queries when rewriting the ones it carries', () => {
    const site = join(dir, 'site')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'queries.yml'), 'old:\n  schema: stale\n')

    const document = {
      // `@/articles` IS the convention default for a query named `articles`
      // (identity, not a singular guess), so the projection drops it as redundant —
      // which is what this case is asserting. Same for the default pool path.
      queries: [{ $id: 'articles', name: 'articles', schema: '@/articles' }],
    }
    const report = declarationsToQueriesYml({ document, siteRoot: site })
    expect(report.queries).toBe('updated')

    const out = yaml.load(readFileSync(join(site, 'queries.yml'), 'utf8'))
    // the incoming `articles` is added; the pre-existing `old` is left in place
    expect(out.articles).toEqual({})
    expect(out.old).toEqual({ schema: 'stale' })
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

  it('writes a target-locale free-form body override to locales/freeform/', () => {
    const srcDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] }
    // A genuine free-form override DIVERGES structurally from the source (here two
    // paragraphs vs the source's one). A structurally congruent body would instead be
    // recovered as a structural map (whole-element keying) — see unwrapLocalizedContent.
    const ffDoc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hola distinto uno' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hola distinto dos' }] },
    ] }
    const report = siteContentDocumentToProject({
      document: {
        info: { name: { en: 'S' }, foundation: '@a/base' },
        pages: [{ $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: { en: srcDoc, es: ffDoc } }] }],
      },
      siteRoot: dir,
    })
    expect(readFileSync(join(dir, 'pages/home/hero.md'), 'utf8')).toContain('Hi') // source body still written
    const ff = join(dir, 'locales/freeform/es/page-ids/home/hero.md')
    expect(report.freeform.written).toContain(ff)
    expect(readFileSync(ff, 'utf8')).toContain('Hola distinto uno')
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

    // Producer wraps localized scalars per-locale by reading locales/es.json — but
    // the site `name` is an identity label, so it stays a plain string regardless.
    const doc1 = await siteProjectToDocument(src)
    expect(doc1.info.name).toBe('Atlas') // identity label — plain, not localized
    const home1 = doc1.pages.find((p) => p.$id === 'home')
    expect(home1.title).toEqual({ en: 'Home', es: 'Inicio' }) // content scalar — localized

    // Project to a fresh dir, then re-produce — the multi-locale scalars survive.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    const doc2 = await siteProjectToDocument(dest)
    expect(doc2.info.name).toEqual(doc1.info.name)
    expect(doc2.pages.find((p) => p.$id === 'home').title).toEqual(home1.title)
  })
})

describe('localized keywords array: producer ⇄ projector (B-2)', () => {
  it('projects a localized keywords array: source elements inline, targets to locales/{locale}.json', () => {
    const document = {
      info: { name: { en: 'S' }, foundation: '@a/base' },
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home',
          keywords: [
            { en: 'alpha', es: 'alfa' },
            { en: 'beta', es: 'beta-es' },
          ],
          page_sections: [],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: dir })

    // source elements stay inline in page.yml as a plain string array
    expect(yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8')).keywords).toEqual([
      'alpha',
      'beta',
    ])
    // each element's target locale → locales/es.json keyed by hash(source element)
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'))
    expect(es[computeHash('alpha')]).toBe('alfa')
    expect(es[computeHash('beta')]).toBe('beta-es')
  })

  it('produce → project → produce recovers multi-locale keywords', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'locales'), { recursive: true })
    mkdirSync(join(src, 'pages/home'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: S\nfoundation: '@a/base'\nlanguages: [en, es]\n")
    writeFileSync(join(src, 'pages/home/page.yml'), 'title: Home\nindex: true\nkeywords: [alpha, beta]\n')
    writeFileSync(
      join(src, 'locales/es.json'),
      JSON.stringify({ [computeHash('alpha')]: 'alfa', [computeHash('beta')]: 'beta-es' })
    )

    // Producer wraps each keyword element per-locale by reading locales/es.json.
    const doc1 = await siteProjectToDocument(src)
    const home1 = doc1.pages.find((p) => p.$id === 'home')
    expect(home1.keywords).toEqual([
      { en: 'alpha', es: 'alfa' },
      { en: 'beta', es: 'beta-es' },
    ])

    // Project to a fresh dir, then re-produce — the multi-locale keywords survive.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    const doc2 = await siteProjectToDocument(dest)
    expect(doc2.pages.find((p) => p.$id === 'home').keywords).toEqual(home1.keywords)
  })
})

describe('localized content body round-trip: producer ⇄ projector (B)', () => {
  it('round-trips a multi-locale section content body via a self-contained per-locale doc', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'pages/home'), { recursive: true })
    mkdirSync(join(src, 'locales'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: S\nfoundation: '@a/base'\nlanguages: [en, es]\n")
    writeFileSync(join(src, 'pages/home/page.yml'), 'index: true\nsections: [hero]\n')
    writeFileSync(join(src, 'pages/home/hero.md'), '---\ntype: Hero\n---\n\nHello world\n')
    writeFileSync(join(src, 'locales/es.json'), JSON.stringify({ [computeHash('Hello world')]: 'Hola mundo' }))

    // Producer wraps the content: source doc + a self-contained es DOC resolved from
    // locales/es.json (the structural map lives on disk, never on the wire).
    const doc1 = await siteProjectToDocument(src)
    const hero1 = doc1.pages.find((p) => p.$id === 'home').page_sections.find((s) => s.stable_id === 'hero')
    expect(hero1.content.en.type).toBe('doc')
    expect(hero1.content.es.type).toBe('doc')
    expect(JSON.stringify(hero1.content.es)).toContain('Hola mundo')

    // Project, then re-produce — the whole document is a fixed point.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    expect(readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')).toContain('Hello world')
    expect(JSON.parse(readFileSync(join(dest, 'locales/es.json'), 'utf8'))[computeHash('Hello world')]).toBe('Hola mundo')

    const doc2 = await siteProjectToDocument(dest)
    expect(doc2).toEqual(doc1)
  })
})

describe('free-form body localization round-trip: producer ⇄ projector (B)', () => {
  it('reads a free-form override on produce and writes it back on project (fixed point)', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'pages/home'), { recursive: true })
    mkdirSync(join(src, 'locales/freeform/es/page-ids/home'), { recursive: true })
    writeFileSync(join(src, 'site.yml'), "name: S\nfoundation: '@a/base'\nlanguages: [en, es]\n")
    writeFileSync(join(src, 'pages/home/page.yml'), 'id: home\nindex: true\nsections: [hero]\n')
    writeFileSync(join(src, 'pages/home/hero.md'), '---\ntype: Hero\n---\n\nSource body\n')
    // A free-form override that DIVERGES structurally from the source (two paragraphs
    // vs one) — so it stays free-form rather than being recovered as a structural map.
    writeFileSync(join(src, 'locales/freeform/es/page-ids/home/hero.md'), 'Cuerpo libre uno\n\nCuerpo libre dos\n')

    // Producer: the es value is the free-form DOC (not a {src:tgt} map).
    const doc1 = await siteProjectToDocument(src)
    const hero1 = doc1.pages.find((p) => p.$id === 'home').page_sections.find((s) => s.stable_id === 'hero')
    expect(hero1.content.en.type).toBe('doc')
    expect(hero1.content.es.type).toBe('doc') // a full body, not a map
    expect(JSON.stringify(hero1.content.es)).toContain('Cuerpo libre uno')

    // Project, then re-produce — fixed point, and the override file is written back.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    expect(readFileSync(join(dest, 'locales/freeform/es/page-ids/home/hero.md'), 'utf8')).toContain('Cuerpo libre uno')
    const doc2 = await siteProjectToDocument(dest)
    expect(doc2).toEqual(doc1)
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

// ⛔ `info.app` is RETIRED. It named a separate entity a host bound to the site;
// that entity is gone and NOTHING replaces it. (uwx-format.md → info.app.)
//
// These two cases used to assert the round trip; they now assert its absence, in
// BOTH directions, because reintroducing it fails differently on each side:
//
//   - producing it again is LOUD but late — a host refuses a key it does not
//     declare, so every push of every site fails, not just this one;
//   - projecting it again is SILENT — a stray key reappears in the author's
//     site.yml, and the next push is the loud half.
describe('info.app — retired, and must not come back', () => {
  it('does not emit info.app even when site.yml still carries an app: key', async () => {
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    // An old project that was pulled while the key still round-tripped. The key on
    // disk is not an instruction to send it.
    writeFileSync(
      join(src, 'site.yml'),
      "name: S\nfoundation: '@a/base'\napp: '019e3c01-0000-7c0d-8a03-000000000002'\n"
    )
    const document = await siteProjectToDocument(src)
    expect(document.info.app).toBeUndefined()
    expect('app' in document.info).toBe(false)
  })

  it('does not write app: into site.yml when a document still carries info.app', async () => {
    // A backend that has not yet dropped the declaration may still return the field.
    // The projection is an explicit allowlist, so an unlisted key is simply ignored.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({
      document: {
        info: {
          name: 'S',
          foundation: '@a/base',
          app: '019e3c01-0000-7c0d-8a03-000000000002'
        }
      },
      siteRoot: dest
    })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).app).toBeUndefined()
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
    expect(yml.sections).toEqual(['hero', '...']) // managed sections replaced wholesale
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
      queries: [
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
    const placeholder = hero.content.en.content[0].content.find((n) => n.type === 'inset_placeholder')
    expect(placeholder).toBeDefined()
    expect(hero.insets).toContainEqual(expect.objectContaining({ type: 'Cite', embedKind: 'text', params: { key: '@darwin' } }))
    // the projected source markdown carries the inline cite, not a dropped inset
    expect(readFileSync(join(dest, 'pages/home/hero.md'), 'utf8')).toContain('As shown [@darwin] in the literature.')
  })

  it('round-trips a MULTI-LOCALE whole site (scalars + content + nesting + layout)', async () => {
    const seed = {
      info: { name: { en: 'Atlas', es: 'Atlas ES' }, foundation: '@acme/base@3.0.0', languages: ['en', 'es'] },
      pages: [
        {
          $id: 'home', slug: 'home', mode: 'page', stable_id: 'home', is_index: true,
          title: { en: 'Home', es: 'Inicio' },
          page_sections: [
            { $id: 'hero', stable_id: 'hero', type: 'Hero', content: { en: docOf('Welcome'), es: { Welcome: 'Bienvenido' } } },
            {
              $id: 'features', stable_id: 'features', type: 'Features', content: { en: docOf('Features'), es: { Features: 'Caracteristicas' } },
              $children: [{ $id: 'card', stable_id: 'card', type: 'Card', content: { en: docOf('Card'), es: { Card: 'Tarjeta' } } }],
            },
          ],
        },
      ],
      layout_sections: [
        { $id: 'header', stable_id: 'header', area: 'header', layout_name: 'default', type: 'Header', content: { en: docOf('Nav'), es: { Nav: 'Navegacion' } } },
      ],
    }

    // Bootstrap multi-locale source files: the projection writes the source bodies
    // + scalars AND locales/es.json (target translations by hash).
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    siteContentDocumentToProject({ document: seed, siteRoot: src })
    const es = JSON.parse(readFileSync(join(src, 'locales/es.json'), 'utf8'))
    expect(es[computeHash('Welcome')]).toBe('Bienvenido')
    expect(es[computeHash('Atlas')]).toBe('Atlas ES')
    expect(es[computeHash('Nav')]).toBe('Navegacion')

    // produce → project → produce is a fixed point with all locales intact.
    const doc1 = await siteProjectToDocument(src)
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteContentDocumentToProject({ document: doc1, siteRoot: dest })
    const doc2 = await siteProjectToDocument(dest)
    expect(doc2).toEqual(doc1)

    // and the multi-locale shape is what we expect (not just self-consistent).
    // The site `name` is an identity label → plain string; content scalars stay localized.
    expect(doc1.info.name).toBe('Atlas')
    const hero = doc1.pages[0].page_sections.find((s) => s.stable_id === 'hero')
    // produced es value is a self-contained DOC (not a map): dynamic delivery ships
    // content[locale] verbatim; the structural map lives only in locales/es.json.
    expect(hero.content.es.type).toBe('doc')
    expect(JSON.stringify(hero.content.es)).toContain('Bienvenido')
    expect(doc1.layout_sections[0].content.es.type).toBe('doc')
    expect(JSON.stringify(doc1.layout_sections[0].content.es)).toContain('Navegacion')
  })
})

describe('pulled pages stay open to new sections', () => {
  const pmDoc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  // `sections:` exists to carry order and nesting, which the projected filenames
  // can't. It must not also decide membership: a bare list is STRICT to the
  // collector ("only listed sections processed"), so a pulled page silently
  // excluded anything added afterwards — you'd create the file, push, and be told
  // "nothing to push", with nothing explaining why.
  it('writes a rest marker so a section added after a pull is picked up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uwx-open-'))
    try {
      siteContentDocumentToProject({
        document: {
          $id: 'site-content', $model: '@uniweb/site-content', info: { name: 'S' },
          pages: [{
            $id: 'home', slug: 'home', mode: 'page', stable_id: 'home',
            page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: pmDoc('Hi') }],
          }],
        },
        siteRoot: dir,
      })
      expect(yaml.load(readFileSync(join(dir, 'pages/home/page.yml'), 'utf8')).sections)
        .toEqual(['hero', '...'])

      // An author adds a section the way they always would.
      writeFileSync(join(dir, 'pages/home/2-extra.md'), '---\ntype: Section\n---\n# Extra\n')
      writeFileSync(join(dir, 'site.yml'), 'name: S\nfoundation: "@a/b"\n')
      const doc = await siteProjectToDocument(dir)
      const ids = doc.pages.find((p) => p.$id === 'home').page_sections.map((s) => s.$id)
      expect(ids).toContain('hero')
      expect(ids).toContain('extra') // would be missing with a bare (strict) list
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appending the rest marker does not flatten nesting', async () => {
    // The producer used to treat `...` as disqualifying the explicit path, falling
    // back to a directory scan — which promoted every nested child to a sibling of
    // its own parent, destroying exactly what the list exists to preserve.
    const dir = mkdtempSync(join(tmpdir(), 'uwx-open-nest-'))
    try {
      mkdirSync(join(dir, 'pages/home'), { recursive: true })
      writeFileSync(join(dir, 'site.yml'), 'name: S\nfoundation: "@a/b"\n')
      writeFileSync(join(dir, 'pages/home/page.yml'), "sections:\n  - hero\n  - features:\n      - card-a\n  - '...'\n")
      writeFileSync(join(dir, 'pages/home/hero.md'), '---\ntype: Hero\n---\n# H\n')
      writeFileSync(join(dir, 'pages/home/features.md'), '---\ntype: Features\n---\n# F\n')
      writeFileSync(join(dir, 'pages/home/card-a.md'), '---\ntype: Card\n---\n# C\n')
      writeFileSync(join(dir, 'pages/home/late.md'), '---\ntype: Section\n---\n# L\n')

      const doc = await siteProjectToDocument(dir)
      const secs = doc.pages.find((p) => p.$id === 'home').page_sections
      expect(secs.map((s) => s.$id)).toEqual(['hero', 'features', 'late'])
      // card-a stays a CHILD, and is not also promoted alongside its parent
      expect(secs.find((s) => s.$id === 'features').$children.map((c) => c.$id)).toEqual(['card-a'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('knowledge: survives the round trip', () => {
  /**
   * A page prop that pushes but does not pull is worse than one that does
   * neither: the author's marker is silently removed from their `page.yml` the
   * first time they run `uniweb pull`. So both directions are asserted here, in
   * one test, on purpose — splitting them lets one side ship alone.
   *
   * ⚠️ The cascade is deliberately NOT carried. Only the marked page emits the
   * field; descendants inherit by route prefix, and computing that is the
   * consumer's job. A consumer that filters on this field alone honours the
   * branch root and misses every child — which is the trap worth having a
   * fixture for.
   */
  it('emits knowledge on the marked page only, and never on its descendants', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uwx-knowledge-'))
    writeFileSync(join(root, 'site.yml'), "name: kb-site\nfoundation: '@acme/base'\n")
    const kb = join(root, 'pages', 'kb')
    mkdirSync(join(kb, 'pricing'), { recursive: true })
    writeFileSync(join(kb, 'page.yml'), 'title: Agent Knowledge\nknowledge: true\n')
    writeFileSync(join(kb, '1-body.md'), '# KB\n\nFor the agent.\n')
    writeFileSync(join(kb, 'pricing', 'page.yml'), 'title: Pricing\n')
    writeFileSync(join(kb, 'pricing', '1-body.md'), '# Pricing\n\nHow to answer.\n')

    const doc = await siteProjectToDocument(root)
    const find = (nodes, slug) => {
      for (const n of nodes || []) {
        if (n.slug && Object.values(n.slug)[0] === slug) return n
        const hit = find(n.$children || n.pages, slug)
        if (hit) return hit
      }
      return null
    }

    expect(find(doc.pages, 'kb').knowledge).toBe(true)
    // The child inherits at read time; it must not carry the flag itself.
    expect(find(doc.pages, 'pricing').knowledge).toBeUndefined()

    rmSync(root, { recursive: true, force: true })
  })

  it('writes knowledge back into page.yml on pull', () => {
    const out = mkdtempSync(join(tmpdir(), 'uwx-knowledge-pull-'))
    const document = {
      info: { name: { en: 'kb-site' }, foundation: '@acme/base' },
      pages: [
        {
          $id: 'kb',
          slug: { en: 'kb' },
          mode: 'page',
          title: { en: 'Agent Knowledge' },
          knowledge: true,
          page_sections: [],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: out })

    const yml = yaml.load(readFileSync(join(out, 'pages', 'kb', 'page.yml'), 'utf8'))
    expect(yml.knowledge).toBe(true)
    // Control: an ordinary field round-trips the same way, so a failure above is
    // about `knowledge` and not about the writer.
    expect(yml.title).toBe('Agent Knowledge')

    rmSync(out, { recursive: true, force: true })
  })
})

/**
 * `trackSections` — per-page section instrumentation opt-in.
 *
 * ⭐ **Both directions in one test, for the reason `knowledge` states above**: a
 * page prop that pushes and does not pull silently deletes the author's flag on
 * their next `uniweb pull`. Splitting them lets one side ship alone.
 *
 * ⚠️ The interesting part is the CASE CROSSING — authored `trackSections`
 * (camelCase, like `hideIn`) against the wire's `track_sections` (snake_case,
 * like every field the backend declares). Two spellings of one field is exactly
 * the shape that cost the analytics lane a week (`collection_started` /
 * `analyticsEnabledAt`), so it is pinned in both directions rather than trusted.
 *
 * ⛔ And it must cross AT ALL: without the producer line the flag works on the
 * `--bundle` / `--link` lanes and is silently ignored on a backend-hosted site,
 * whose page config comes from the backend's projection — the one lane the
 * feature is sold on.
 */
describe('trackSections: crosses the wire, in both directions, changing case', () => {
  it('emits track_sections on the opted-in page ONLY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uwx-tracksections-'))
    writeFileSync(join(root, 'site.yml'), "name: ts-site\nfoundation: '@acme/base'\n")
    const shop = join(root, 'pages', 'shop')
    mkdirSync(join(shop, 'about'), { recursive: true })
    writeFileSync(join(shop, 'page.yml'), 'title: Shop\ntrackSections: true\n')
    writeFileSync(join(shop, '1-body.md'), '# Shop\n\nBuy things.\n')
    writeFileSync(join(shop, 'about', 'page.yml'), 'title: About\n')
    writeFileSync(join(shop, 'about', '1-body.md'), '# About\n\nWho we are.\n')

    const doc = await siteProjectToDocument(root)
    const find = (nodes, slug) => {
      for (const n of nodes || []) {
        if (n.slug && Object.values(n.slug)[0] === slug) return n
        const hit = find(n.$children || n.pages, slug)
        if (hit) return hit
      }
      return null
    }

    expect(find(doc.pages, 'shop').track_sections).toBe(true)
    // ⛔ Page-level only — it must NOT cascade to a descendant. A site-wide or
    // inherited form is the unscoped mode whose cardinality a counter-based
    // collector cannot store.
    expect(find(doc.pages, 'about').track_sections).toBeUndefined()
    // Control: the authored camelCase spelling is not what crosses.
    expect(find(doc.pages, 'shop').trackSections).toBeUndefined()

    rmSync(root, { recursive: true, force: true })
  })

  it('writes trackSections back into page.yml on pull', () => {
    const out = mkdtempSync(join(tmpdir(), 'uwx-tracksections-pull-'))
    const document = {
      info: { name: { en: 'ts-site' }, foundation: '@acme/base' },
      pages: [
        {
          $id: 'shop',
          slug: { en: 'shop' },
          mode: 'page',
          title: { en: 'Shop' },
          track_sections: true,
          page_sections: [],
        },
      ],
    }
    siteContentDocumentToProject({ document, siteRoot: out })

    const yml = yaml.load(readFileSync(join(out, 'pages', 'shop', 'page.yml'), 'utf8'))
    expect(yml.trackSections).toBe(true)
    // The wire spelling must not leak into an authored file.
    expect(yml.track_sections).toBeUndefined()
    // Control, as above: an ordinary field proves the writer ran.
    expect(yml.title).toBe('Shop')

    rmSync(out, { recursive: true, force: true })
  })
})

/**
 * `tracking:` — where a site's usage events go. Same allowlist hazard as
 * `submit:`: the bundle lane spreads all of site.yml, so a missing line here
 * would make an authored destination work on a static host and vanish in
 * silence on the synced lane.
 */
describe('site.yml::tracking across the sync wire', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uwx-tracking-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['shorthand string', '/_t'],
    ['object form with consent', { endpoint: 'https://collector.example.com/events', consent: 'required' }],
    // `scripts` rides INSIDE the block, so nothing carries it by name. Pinned
    // because the whole vendor-tag capability depends on it reaching a hosted
    // site, and a later key allowlist inside `tracking:` would drop it in
    // silence — the exact shape of the hazard this describe block exists for.
    //
    // ⛔ **A FIXTURE IS AN ALLOWLIST WEARING A COMPARISON'S CLOTHES.** These
    // cases assert the *whole* value, which reads like a verbatim guard and is
    // not one: they can only prove what the fixture happens to contain. The
    // consumer's matching test had this exact hole and passed for months —
    // whole-value compare, two-key fixture, blind to the block growing (channel
    // `framework-backend-a1c8`; they added the nested key, watched it fail,
    // restored). ⚠️ Their fixture pins the key under its ORIGINAL name, `tags`,
    // renamed here to `scripts` afterwards. Harmless — their forward is
    // wholesale, so what it proves is that a nested key survives at all, which
    // is name-independent — but worth knowing before reading their test.
    //
    // ⭐ The tell, which generalises past `tracking`: an **open-ended value
    // whose contents are authored elsewhere**. Nothing local changes as the
    // guarded value grows, so the fixture ages into a narrower assertion with
    // no commit, no diff and no failing test to mark the moment. ⇒ **Adding a
    // key inside an author block means adding it here**, and that is not
    // optional tidiness — it is the only thing that keeps this honest.
    [
      'nested scripts, the vendor case',
      {
        endpoint: '/collect',
        scripts: ['https://vendor.example.com/tag.js', { src: '/js/local.js' }]
      }
    ]
  ])('carries it through produce → project (%s)', async (label, tracking) => {
    const src = join(dir, `src-${label.replace(/\W/g, '')}`)
    mkdirSync(src, { recursive: true })
    writeFileSync(
      src + '/site.yml',
      `name: Tracked\nfoundation: '@acme/base@2.0.0'\ndefaultLanguage: en\ntracking: ${JSON.stringify(tracking)}\n`
    )

    const document = await siteProjectToDocument(src)
    expect(document.info.tracking).toEqual(tracking)

    const dest = join(dir, `dest-${label.replace(/\W/g, '')}`)
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })

    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).tracking).toEqual(tracking)
  })

  it('omits it entirely when the site declares none', async () => {
    const src = join(dir, 'src-none')
    mkdirSync(src, { recursive: true })
    writeFileSync(src + '/site.yml', "name: Untracked\nfoundation: '@acme/base@2.0.0'\n")

    const document = await siteProjectToDocument(src)
    expect(document.info).not.toHaveProperty('tracking')
  })

  it('strips a credential-shaped key, like assistant does', async () => {
    const src = join(dir, 'src-cred')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      src + '/site.yml',
      "name: Keyed\nfoundation: '@acme/base@2.0.0'\ntracking:\n  endpoint: /_t\n  apiKey: super-secret\n"
    )

    const document = await siteProjectToDocument(src)
    expect(document.info.tracking).toEqual({ endpoint: '/_t' })
    expect(JSON.stringify(document)).not.toContain('super-secret')
  })

  /**
   * The invariant that makes writing a `services:` block in site.yml a SAFE way
   * to simulate a host locally (the bundle lane spreads it; this lane must not).
   * Without this, a site file could impersonate its host on the synced lane —
   * and `tracking` now resolves through that same host tier, so the property is
   * load-bearing for two services rather than one.
   */
  it('does NOT carry site.yml::services across the wire', async () => {
    const src = join(dir, 'src-services')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      src + '/site.yml',
      "name: Mock Host\nfoundation: '@acme/base@2.0.0'\nservices:\n  tracking:\n    endpoint: /_t\n  submit:\n    endpoint: /_submit\n"
    )

    const document = await siteProjectToDocument(src)
    expect(document.info).not.toHaveProperty('services')
  })
})

// ─── a round trip must not mangle what the author wrote ──────────────────────
// `publish` stamps the RELEASED, version-pinned ref into `info.foundation`, because
// delivery is version-pinned end to end. Projecting the stored value straight back
// turns a workspace project's `foundation: src` into `@org/x@1.2.3` — which the
// build REFUSES to resolve (a build is offline and does not guess where a
// foundation is served), leaving the project unable to `build`, `dev` or `export`.
// It stays publishable throughout, so nothing surfaces it. Measured 2026-08-19.
//
// ⚖️ Not a blanket "never project it": a project from `uniweb clone` has no local
// foundation on disk, and there the pinned ref is exactly what site.yml should say.
// Hence a caller's decision — the caller being the only one who can tell the two
// project shapes apart. Same principle as restoring authored asset paths.
describe('siteInfoToConfig — the authored foundation', () => {
  const STORED = '@acme/flow-mszfnd41-0-src@0.1.0'
  const project = (keepAuthoredFoundation) => {
    const root = mkdtempSync(join(tmpdir(), 'authored-fnd-'))
    writeFileSync(join(root, 'site.yml'), 'name: Acme\nfoundation: src\nindex: home\n')
    siteInfoToConfig({
      document: { $model: '@uniweb/site-content', $id: 'site-content', info: { foundation: STORED } },
      siteRoot: root,
      keepAuthoredFoundation,
    })
    const out = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'))
    rmSync(root, { recursive: true, force: true })
    return out.foundation
  }

  it('is preserved when the caller says the project resolves one locally', () => {
    expect(project(true)).toBe('src')
  })

  it('CONTROL: is overwritten otherwise — the fresh-clone case, and proof the flag is what does it', () => {
    // Without this, the assertion above would also pass if the projection had
    // simply stopped writing `foundation` at all.
    expect(project(false)).toBe(STORED)
  })

  it('other info fields still project either way', () => {
    // The suppression must be surgical: it is one key, not a switch that quietly
    // stops the config projection doing its job.
    const root = mkdtempSync(join(tmpdir(), 'authored-fnd-'))
    writeFileSync(join(root, 'site.yml'), 'name: Old\nfoundation: src\n')
    siteInfoToConfig({
      document: {
        $model: '@uniweb/site-content', $id: 'site-content',
        info: { foundation: STORED, base: '/docs/', defaultLanguage: undefined, default_language: 'fr' },
      },
      siteRoot: root,
      keepAuthoredFoundation: true,
    })
    const out = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'))
    rmSync(root, { recursive: true, force: true })
    expect(out.foundation).toBe('src')
    expect(out.base).toBe('/docs/')
    expect(out.defaultLanguage).toBe('fr')
  })
})
