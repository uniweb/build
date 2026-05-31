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
        foundation_name: '@acme/base@1.2.3',
        locales: ['en', 'fr'],
        default_locale: 'en',
        base_path: '/docs/',
        build_options: { split: true },
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
        foundation_name: '@acme/base',
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
    const document = { info: { name: { en: 'New' }, foundation_name: '@acme/base' } }

    siteInfoToConfig({ document, siteRoot: dir })
    const obj = yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))
    expect(obj.name).toBe('New')
    expect(obj.paths).toEqual({ pages: 'content' }) // untouched key preserved

    // second projection makes no change
    expect(siteInfoToConfig({ document, siteRoot: dir }).siteConfig).toBe('unchanged')
  })

  it('does not write theme.yml / head.html when the document omits them', () => {
    siteInfoToConfig({ document: { info: { name: { en: 'S' }, foundation_name: '@acme/base' } }, siteRoot: dir })
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
    info: { name: { en: 'Site' }, foundation_name: '@a/base' },
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
      info: { name: { en: 'S' }, foundation_name: '@a/base' },
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
