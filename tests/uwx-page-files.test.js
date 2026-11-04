/**
 * ⭐ A PULL WRITES EACH PAGE WHERE THE FILES KEEP IT (`src/uwx/page-files.js`) — found by the build's
 * rules, never computed from the document: a numbered folder keeps its number, and a folder-mode `.md`
 * page is written back into its file.
 *
 * ⛔ Until 2026-11-04 a pull named a page's folder by its slug, so `pages/2-about/` came back as
 * `pages/about/` with the numbered folder pruned (measured that day), and it left every folder-mode
 * `.md` page alone, so an edit made to one in the app was undone by the next push.
 *
 * The parity test holds the file map to the push: every page the push sends has a place, and each of
 * its sections was read from that place.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'
import { sitePageFiles } from '../src/uwx/page-files.js'
import { sectionFileOf } from '../src/site/file-links.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const siteDir = () => join(ROOT, 'site')
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-page-files-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const snapshot = () => {
  const files = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.uniweb') continue
      if (statSync(p).isDirectory()) walk(p)
      else files[relative(ROOT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(ROOT)
  return files
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort()
// Each page of a document with its slug path (the pull's route) and the build's route.
const pagesOf = (doc) => {
  const out = []
  const walk = (records, prefix, parent) => {
    for (const r of records || []) {
      const slug = r.slug?.en ?? r.slug
      const route = prefix ? `${prefix}/${slug}` : slug
      const canon = buildRouteOf(r, parent, 'en')
      out.push({ route, canon, record: r })
      walk(r.$children, route, canon)
    }
  }
  walk(doc.pages, '', '/')
  return out
}
const at = (doc, canon) => pagesOf(doc).find((p) => p.canon === canon)?.record
const para = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const built = async () => (await collectSiteContent(siteDir(), {})).pages.map((p) => p.route)

// A site with every way a page is kept: numbered page folders, a child section, a parametric page,
// a folder-mode folder of numbered `.md` pages with a folder inside it, and a mount.
function everyKind() {
  w('site/site.yml', 'name: S\nfoundation: "@acme/base@1.0.0"\nindex: home\npaths:\n  pages/docs: ../docs-repo\n')
  w('site/pages/1-home/page.yml', 'title: Home\nnest:\n  grid: [card-a]\n')
  w('site/pages/1-home/1-hero.md', '---\ntype: Hero\n---\n\n# Welcome\n')
  w('site/pages/1-home/2-grid.md', '# Grid\n')
  w('site/pages/1-home/@card-a.md', '# Card A\n')
  w('site/pages/2-about/page.yml', 'title: About\n')
  w('site/pages/2-about/1-story.md', '## Our story\n\nIt began in 2008.\n')
  w('site/pages/blog/page.yml', 'title: Blog\n')
  w('site/pages/blog/list.md', '# Posts\n')
  w('site/pages/blog/[slug]/page.yml', 'title: Post\n')
  w('site/pages/blog/[slug]/body.md', '# A post\n')
  w('site/pages/guide/folder.yml', 'title: Guide\n')
  w('site/pages/guide/1-install.md', '# Install it\n\nRun the command.\n')
  w('site/pages/guide/2-use.md', '# Use it\n')
  w('site/pages/guide/more/folder.yml', 'title: More\n')
  w('site/pages/guide/more/tips.md', '# Tips\n')
  w('docs-repo/folder.yml', 'title: Docs\n')
  w('docs-repo/intro.md', '# Intro\n')
}

describe('the file map and the push say one thing', () => {
  it('⭐ every page the push sends has a place, and its sections were read from it', async () => {
    everyKind()
    const doc = await siteProjectToDocument(siteDir())
    const files = sitePageFiles(yaml.load(readFileSync(join(siteDir(), 'site.yml'), 'utf8')), join(siteDir(), 'pages'))
    const seen = []
    for (const { route, record } of pagesOf(doc)) {
      const place = files.page(route)
      expect(place, route).toBeTruthy()
      seen.push(`${route}:${place.kind}`)
      for (const section of record.page_sections || []) {
        const file = sectionFileOf(section)
        if (place.kind === 'md') expect(file, route).toBe(place.file)
        else if (place.kind === 'folder') expect(dirname(file), route).toBe(place.dir)
      }
    }
    expect(seen).toEqual(expect.arrayContaining([
      'home:folder', 'about:folder', 'blog:folder', 'blog/slug:folder', 'guide:folder',
      'guide/install:md', 'guide/use:md', 'guide/more:folder', 'guide/more/tips:md', 'docs:mounted', 'docs/intro:mounted',
    ]))
    expect(files.page('about').dir).toBe(join(siteDir(), 'pages/2-about'))
  })
})

describe('⭐ a pull writes each page where the files keep it', () => {
  it('a pull of what was pushed changes no file — numbered folders, a child section, `.md` pages and all', async () => {
    everyKind()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual([])
  })

  it('an app edit to a section in a numbered folder lands in that folder\'s file', async () => {
    everyKind()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/about').page_sections[0].content = { en: para('It began in 2009.') }
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })
    expect(changed(before, snapshot())).toEqual(['site/pages/2-about/1-story.md'])
    expect(readFileSync(join(siteDir(), 'pages/2-about/1-story.md'), 'utf8')).toContain('It began in 2009.')
  })

  it('an app edit to a folder-mode page comes back into its `.md` file, and the next push sends it', async () => {
    everyKind()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    const install = at(doc, '/guide/install')
    install.page_sections[0].content = { en: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Install it' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Run the command twice.' }] },
    ] } }
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(changed(before, snapshot())).toEqual(['site/pages/guide/1-install.md'])
    expect(readFileSync(join(siteDir(), 'pages/guide/1-install.md'), 'utf8')).toContain('Run the command twice.')
    const again = await siteProjectToDocument(siteDir())
    expect(JSON.stringify(at(again, '/guide/install').page_sections[0].content)).toContain('Run the command twice.')
  })

  it('a page added in the app to a folder-mode folder comes back as an `.md` file', async () => {
    everyKind()
    const doc = await siteProjectToDocument(siteDir())
    const guide = at(doc, '/guide')
    guide.$children.push({
      $id: 'faq', slug: { en: 'faq' }, mode: 'page', title: { en: 'FAQ' },
      page_sections: [{ $id: 'faq', stable_id: 'faq', type: 'Section', content: { en: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'FAQ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Asked often.' }] },
      ] } } }],
    })
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true, sectionType: 'Section' })

    expect(readFileSync(join(siteDir(), 'pages/guide/faq.md'), 'utf8')).toContain('Asked often.')
    expect(existsSync(join(siteDir(), 'pages/guide/faq'))).toBe(false)
    expect(await built()).toContain('/guide/faq')
  })

  it('a title the first heading does not give is left as written, and said', async () => {
    everyKind()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/guide/use').title = { en: 'Using it well' }
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(changed(before, snapshot())).toEqual([])
    expect(report.held).toEqual([{ route: 'guide/use', uuids: [], what: ['a title its first heading does not give'] }])
  })

  it('a folder-mode folder reordered in the app says it in its `pages:`, and the build and the push follow it', async () => {
    everyKind()
    const doc = await siteProjectToDocument(siteDir())
    const guide = at(doc, '/guide')
    guide.$children = [...guide.$children].reverse() // more, use, install
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(yaml.load(readFileSync(join(siteDir(), 'pages/guide/folder.yml'), 'utf8')).pages).toEqual(['more', 'use', 'install', '...'])
    const again = await siteProjectToDocument(siteDir())
    expect(at(again, '/guide').$children.map((c) => c.$id)).toEqual(['more', 'use', 'install'])
  })

  it('⭐ the report names each page by its outcome, with its items: held, and a mount\'s', async () => {
    everyKind()
    const doc = await siteProjectToDocument(siteDir())
    // As a backend hands it back: every item with its uuid.
    let n = 0
    const stamp = (r) => {
      r.$uuid = `u${n++}`
      for (const s of r.page_sections || []) stamp(s)
      for (const c of r.$children || []) stamp(c)
    }
    for (const p of doc.pages) stamp(p)
    const use = at(doc, '/guide/use')
    use.title = { en: 'Using it well' }
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(report.held).toEqual([{ route: 'guide/use', uuids: [use.$uuid, use.page_sections[0].$uuid], what: ['a title its first heading does not give'] }])
    // A mount's page by page, each with its own items.
    expect(report.mountedPages).toEqual([
      { route: 'docs', uuids: [at(doc, '/docs').$uuid] },
      { route: 'docs/intro', uuids: [at(doc, '/docs/intro').$uuid, at(doc, '/docs/intro').page_sections[0].$uuid] },
    ])
  })

  it('a route the files give two pages for is left alone', async () => {
    everyKind()
    w('site/pages/guide/topics.md', '# Topics, the file\n')
    w('site/pages/guide/topics/folder.yml', 'title: Topics\n')
    w('site/pages/guide/topics/a.md', '# A\n')
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    for (const p of pagesOf(doc).filter((p) => p.route === 'guide/topics')) p.record.title = { en: 'Changed' }
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(changed(before, snapshot())).toEqual([])
    expect(report.leftAlone).toContain('guide/topics')
  })
})

// A site whose docs are a mounted folder it may write: the route's stub says how this site presents
// them, the mounted folder's config what they are.
function writableMount() {
  w('site/site.yml', 'name: S\nfoundation: "@acme/base@1.0.0"\nindex: home\npaths:\n  pages/docs: ../docs-repo\n')
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Welcome\n')
  w('site/pages/about/page.yml', 'title: About\n')
  w('site/pages/about/story.md', '## Our story\n')
  w('site/pages/docs/folder.yml', 'title: Docs\nlayout: DocsLayout\n')
  w('docs-repo/folder.yml', 'title: Help\npages:\n  - intro\n  - guide\n  - ...\n')
  w('docs-repo/intro.md', '# Intro\n\nRead this first,\nthen the guide.\n')
  w('docs-repo/guide/folder.yml', 'title: Guide\n')
  w('docs-repo/guide/1-start.md', '# Start\n\nBegin here.\n')
  w('docs-repo/guide/2-next.md', '# Next\n')
  w('docs-repo/README.md', '# The repository\n')
}
const pullInto = (doc, opts = {}) => siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true, writableMounts: ['docs'], ...opts })
const config = (rel) => yaml.load(readFileSync(join(ROOT, rel), 'utf8'))

describe('⭐ a writable mount: a pull writes its pages where the push reads them', () => {
  it('every page the push sends has a place, the mount\'s in the mounted folder', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    const files = sitePageFiles(yaml.load(readFileSync(join(siteDir(), 'site.yml'), 'utf8')), join(siteDir(), 'pages'), { siteRoot: siteDir(), writable: ['docs'] })
    const seen = []
    for (const { route, record } of pagesOf(doc)) {
      const place = files.page(route)
      expect(place, route).toBeTruthy()
      seen.push(`${route}:${place.kind}`)
      for (const section of record.page_sections || []) {
        const file = sectionFileOf(section)
        if (place.kind === 'md') expect(file, route).toBe(place.file)
        else if (place.kind === 'folder') expect(dirname(file), route).toBe(place.dir)
      }
    }
    expect(seen).toEqual(expect.arrayContaining(['docs:folder', 'docs/intro:md', 'docs/guide:folder', 'docs/guide/start:md', 'docs/guide/next:md']))
    expect(files.page('docs/guide/start').file).toBe(join(realpathSync(ROOT), 'docs-repo/guide/1-start.md'))
  })

  it('a pull of what was pushed changes no file, in the site or the mounted folder', async () => {
    writableMount()
    const before = snapshot()
    pullInto(await siteProjectToDocument(siteDir()))
    expect(changed(before, snapshot())).toEqual([])
  })

  it('⭐ an app edit to a mounted page comes back into its file, which the next push sends', async () => {
    writableMount()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    const intro = at(doc, '/docs/intro')
    intro.page_sections[0].content = { en: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Intro' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Read this first, then the guide, then the rest.' }] },
    ] } }
    const report = pullInto(doc)

    expect(changed(before, snapshot())).toEqual(['docs-repo/intro.md'])
    expect(readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')).toContain('then the guide, then the rest.')
    expect(report.mountedPages).toEqual([])
    const again = await siteProjectToDocument(siteDir())
    expect(JSON.stringify(at(again, '/docs/intro').page_sections[0].content)).toContain('then the rest.')
  })

  it('a page added in the app is a new file in the mounted folder, in its form', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/docs').$children.push({
      $id: 'faq', slug: { en: 'faq' }, mode: 'page', title: { en: 'FAQ' },
      page_sections: [{ $id: 'faq', stable_id: 'faq', type: 'Section', content: { en: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'FAQ' }] },
      ] } } }],
    })
    pullInto(doc, { sectionType: 'Section' })

    expect(readFileSync(join(ROOT, 'docs-repo/faq.md'), 'utf8')).toContain('# FAQ')
    expect(existsSync(join(siteDir(), 'pages/docs/faq'))).toBe(false)
    expect(await built()).toContain('/docs/faq')
  })

  it('a page deleted in the app goes from the mounted folder, where this copy saw the backend hold it', async () => {
    writableMount()
    const origin = 'https://backend.test'
    const items = Object.fromEntries(['docs', 'docs/intro', 'docs/guide', 'docs/guide/start', 'docs/guide/next'].map((r, i) => [`pages/${r}/${['docs', 'docs/guide'].includes(r) ? 'folder' : 'page'}.yml`, `u-${i}`]))
    w('site/sync.json', JSON.stringify({ backends: { [origin]: { items } } }))
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/docs/guide').$children = at(doc, '/docs/guide').$children.filter((c) => c.$id !== 'next')
    pullInto(doc, { backend: origin })

    expect(existsSync(join(ROOT, 'docs-repo/guide/2-next.md'))).toBe(false)
    expect(existsSync(join(ROOT, 'docs-repo/guide/1-start.md'))).toBe(true)
    expect(existsSync(join(ROOT, 'docs-repo/README.md'))).toBe(true)
  })

  it('the mount\'s pages reordered in the app say it in the `pages:` the mounted folder keeps', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    const docs = at(doc, '/docs')
    docs.$children = [...docs.$children].reverse() // guide, intro
    pullInto(doc)

    expect(config('docs-repo/folder.yml').pages).toEqual(['guide', 'intro', '...'])
    expect(readFileSync(join(siteDir(), 'pages/docs/folder.yml'), 'utf8')).toBe('title: Docs\nlayout: DocsLayout\n')
    const again = await siteProjectToDocument(siteDir())
    expect(at(again, '/docs').$children.map((c) => c.$id)).toEqual(['guide', 'intro'])
  })

  it('⭐ the route\'s own settings go to the file that says each — a new one by what it is', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    const docs = at(doc, '/docs')
    docs.title = { en: 'Documentation' } // both files say a title, and the stub's wins
    docs.layout = 'Wide' // the stub's
    docs.description = { en: 'All of it.' } // neither says one: what the content is, the mounted folder's
    pullInto(doc)

    expect(config('site/pages/docs/folder.yml')).toEqual({ title: 'Documentation', layout: 'Wide' })
    expect(config('docs-repo/folder.yml')).toEqual({ title: 'Help', description: 'All of it.', pages: ['intro', 'guide', '...'] })
    const again = await siteProjectToDocument(siteDir())
    expect(at(again, '/docs')).toMatchObject({ title: { en: 'Documentation' }, layout: 'Wide', description: { en: 'All of it.' } })
  })

  it('the site\'s pages reordered with the mount\'s route among them: its place is the stub\'s to say', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    const docs = doc.pages.find((p) => p.$id === 'docs')
    doc.pages = [docs, ...doc.pages.filter((p) => p !== docs)]
    const order = doc.pages.map((p) => p.$id)
    pullInto(doc)

    expect(config('site/pages/docs/folder.yml').order).toBe(1)
    expect(config('docs-repo/folder.yml').order).toBeUndefined()
    const again = await siteProjectToDocument(siteDir())
    expect(again.pages.map((p) => p.$id)).toEqual(order)
  })

  it('a route the app gave another form is held whole, and said', async () => {
    writableMount()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/docs').mode = 'page'
    at(doc, '/docs/intro').title = { en: 'Changed' }
    const report = pullInto(doc)

    expect(changed(before, snapshot())).toEqual([])
    expect(report.held.map((h) => [h.route, h.what])).toEqual([['docs', ['a page where its files keep a folder']]])
  })

  it('⛔ a mount the caller does not name is left alone: a pull names each one it can merge into', async () => {
    writableMount()
    const before = snapshot()
    const doc = await siteProjectToDocument(siteDir())
    at(doc, '/docs/intro').page_sections[0].content = { en: para('Changed in the app.') }
    const report = pullInto(doc, { writableMounts: [] })
    expect(changed(before, snapshot())).toEqual([])
    expect(report.mountedPages.map((p) => p.route)).toEqual(['docs', 'docs/intro', 'docs/guide', 'docs/guide/start', 'docs/guide/next'])
  })
})

describe('⭐ a link a file writes as a file stays as the file wrote it', () => {
  // Docs that link each other by file, the way a repository's docs do for GitHub and an editor.
  function linkedDocs() {
    writableMount()
    w('docs-repo/intro.md', '# Intro\n\nRead this first,\nthen [the guide](./guide/1-start.md).\n\nOr [the next step](guide/2-next.md#next).\n')
    w('docs-repo/guide/1-start.md', '# Start\n\nBegin here, then go [back](../intro.md).\n')
  }

  it('CONTROL — the push sends each as the page it leads to', async () => {
    linkedDocs()
    const doc = await siteProjectToDocument(siteDir())
    const hrefs = JSON.stringify(at(doc, '/docs/intro').page_sections[0].content).match(/"href":"[^"]+"/g)
    expect(hrefs).toEqual(['"href":"/docs/guide/start"', '"href":"/docs/guide/next#next"'])
  })

  it('a pull of what was pushed changes no file', async () => {
    linkedDocs()
    const before = snapshot()
    pullInto(await siteProjectToDocument(siteDir()))
    expect(changed(before, snapshot())).toEqual([])
  })

  it('⭐ an app edit to a paragraph holding one writes the edit, and the link as the file wrote it', async () => {
    linkedDocs()
    const doc = await siteProjectToDocument(siteDir())
    const intro = at(doc, '/docs/intro').page_sections[0].content
    const body = intro.type === 'doc' ? intro : intro.en
    const para = body.content.find((n) => n.type === 'paragraph')
    para.content.unshift({ type: 'text', text: 'Please: ' })
    pullInto(doc)

    expect(readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')).toBe('# Intro\n\nPlease: Read this first, then [the guide](./guide/1-start.md).\n\nOr [the next step](guide/2-next.md#next).\n')
    expect(readFileSync(join(ROOT, 'docs-repo/guide/1-start.md'), 'utf8')).toBe('# Start\n\nBegin here, then go [back](../intro.md).\n')
  })

  it('a link the app adds to a page the file links by file is written as the file writes it; to another, as the app\'s page link', async () => {
    linkedDocs()
    const doc = await siteProjectToDocument(siteDir())
    const start = at(doc, '/docs/guide/start').page_sections[0].content
    const body = start.type === 'doc' ? start : start.en
    const link = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
    body.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, link('the intro', '/docs/intro'), { type: 'text', text: ' and ' }, link('the next step', '/docs/guide/next'), { type: 'text', text: '.' }] })
    pullInto(doc)

    expect(readFileSync(join(ROOT, 'docs-repo/guide/1-start.md'), 'utf8')).toBe('# Start\n\nBegin here, then go [back](../intro.md).\n\nSee [the intro](../intro.md) and [the next step](/docs/guide/next).\n')
  })
})

describe('⭐ a mount\'s own route renamed or removed in the app is said in paths:', () => {
  const ORIGIN = 'https://backend.test'
  // As a backend hands the site back: each item with its uuid, the mount's route among them known to
  // this copy (`sync.json`'s `items`).
  async function synced() {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    let n = 0
    const stamp = (r) => {
      r.$uuid = `u${n++}`
      for (const s of r.page_sections || []) stamp(s)
      for (const c of r.$children || []) stamp(c)
    }
    for (const p of doc.pages) stamp(p)
    w('site/sync.json', JSON.stringify({ backends: { [ORIGIN]: { items: { 'pages/docs/folder.yml': at(doc, '/docs').$uuid } } } }))
    return doc
  }
  const pullBack = (doc, opts = {}) => pullInto(doc, { backend: ORIGIN, ...opts })
  const siteYml = () => yaml.load(readFileSync(join(siteDir(), 'site.yml'), 'utf8'))

  it('⭐ renamed: its key and its local folder follow, its pages stay in the mounted folder, and none is copied', async () => {
    const doc = await synced()
    const docs = doc.pages.find((p) => p.$id === 'docs')
    docs.slug = { en: 'help' }
    const intro = docs.$children.find((c) => c.$id === 'intro')
    intro.page_sections[0].content = { en: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Intro' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Read this first, please.' }] },
    ] } }
    const report = pullBack(doc)

    expect(siteYml().paths).toEqual({ 'pages/help': '../docs-repo' })
    expect(readFileSync(join(siteDir(), 'pages/help/folder.yml'), 'utf8')).toBe('title: Docs\nlayout: DocsLayout\n')
    expect(existsSync(join(siteDir(), 'pages/docs'))).toBe(false)
    expect(existsSync(join(siteDir(), 'pages/help/intro.md'))).toBe(false)
    // Still written under its new name: the app's edit is in the mounted folder.
    expect(readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')).toContain('Read this first, please.')
    expect(report.mountRoutes).toEqual([{ from: 'docs', to: 'help' }])
    expect((await built()).filter((r) => r.includes('help') || r.includes('docs')).sort()).toEqual(['/help', '/help/guide', '/help/guide/next', '/help/guide/start', '/help/intro'])
  })

  it('renamed, a mount the pull does not write: the same, and its folder is as it was', async () => {
    const doc = await synced()
    const before = readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')
    doc.pages.find((p) => p.$id === 'docs').slug = { en: 'help' }
    pullBack(doc, { writableMounts: [] })

    expect(siteYml().paths).toEqual({ 'pages/help': '../docs-repo' })
    expect(existsSync(join(siteDir(), 'pages/help/intro.md'))).toBe(false)
    expect(readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')).toBe(before)
  })

  it('⭐ removed: the mount leaves the site — its key and its local folder — and the mounted folder is untouched', async () => {
    const doc = await synced()
    const mounted = readdirSync(join(ROOT, 'docs-repo'))
    doc.pages = doc.pages.filter((p) => p.$id !== 'docs')
    const report = pullBack(doc)

    expect(siteYml().paths).toBeUndefined()
    expect(existsSync(join(siteDir(), 'pages/docs'))).toBe(false)
    expect(readdirSync(join(ROOT, 'docs-repo'))).toEqual(mounted)
    expect(report.mountRoutes).toEqual([{ from: 'docs', to: null }])
    expect((await built()).some((r) => r.startsWith('/docs'))).toBe(false)
  })

  it('removed, with nothing pruned: it is left as it is', async () => {
    const doc = await synced()
    const before = snapshot()
    doc.pages = doc.pages.filter((p) => p.$id !== 'docs')
    pullBack(doc, { prune: false })
    expect(changed(before, snapshot())).toEqual([])
  })

  it('moved below another page, where a mount cannot sit: held whole, and nothing copied', async () => {
    const doc = await synced()
    const before = snapshot()
    const docs = doc.pages.find((p) => p.$id === 'docs')
    doc.pages = doc.pages.filter((p) => p !== docs)
    doc.pages.find((p) => p.$id === 'about').$children = [docs]
    const report = pullBack(doc)

    expect(changed(before, snapshot())).toEqual([])
    expect(report.held.map((h) => h.route)).toEqual(['about/docs'])
  })

  it('CONTROL — a route this copy never saw the backend hold is no mount\'s: an app page of that name is a page', async () => {
    writableMount()
    const doc = await siteProjectToDocument(siteDir())
    doc.pages.find((p) => p.$id === 'docs').slug = { en: 'help' }
    pullInto(doc) // no backend: nothing tells this page from a new one
    expect(siteYml().paths).toEqual({ 'pages/docs': '../docs-repo' })
  })
})
