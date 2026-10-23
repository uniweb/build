/**
 * ⭐ FOLDER-MODE `.md` PAGES AND `paths: { pages/<segment> }` MOUNTS REACH THE BACKEND — read by
 * the build's own rules, so a push sends the page tree the build makes. Decided and built
 * 2026-10-23 [Diego]; a pull leaves those pages alone, since they are written in git.
 *
 * ⛔ Until then the sync lane sent neither and warned (these tests pinned the warnings). Measured
 * 2026-09-18 on a documentation site whose pages are a mounted repo of folder-mode `.md` files:
 * 49 pages built, 2 pushed, with every CLI instrument reporting success.
 *
 * ⇒ The assertion that matters is PARITY: the routes the push sends, in their order, are the
 * routes `collectSiteContent` builds. A gap in the push shows up as a route missing from one side.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-folder-mounts-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const SITE = 'name: test-site\nfoundation: "@acme/base@1.0.0"\n'
const site = (extra = '') => w('site/site.yml', `${SITE}${extra}`)
const siteDir = () => join(ROOT, 'site')

// The build's routes, in its order.
const built = async () => (await collectSiteContent(siteDir(), {})).pages.map((p) => p.route)

// The pushed tree, flattened in document order, each node with the route the build gives it.
const pushed = (doc) => {
  const out = []
  const walk = (records, parent) => {
    for (const r of records || []) {
      const route = buildRouteOf(r, parent, 'en')
      out.push({ route, record: r })
      walk(r.$children, route)
    }
  }
  walk(doc.pages, '/')
  return out
}
const routes = (doc) => pushed(doc).map((p) => p.route)
const at = (doc, route) => pushed(doc).find((p) => p.route === route)?.record

// Every file under the site and the mount, with its bytes — what a pull must leave as it was.
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

// The shape of a documentation site: a local stub for /docs and the docs themselves mounted from
// another repository, folder mode throughout.
const docsSite = () => {
  site('index: home\npaths:\n    pages/docs: ../docs-repo\n')
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Hi\n')
  w('site/pages/docs/folder.yml', 'title: Documentation\nlabel: Docs\nlayout: DocsLayout\n')
  w('docs-repo/folder.yml', 'title: Repo Docs\npages: [start, reference, ...]\n')
  w('docs-repo/intro.md', '# Welcome\n\nHello.\n')
  w('docs-repo/start/folder.yml', 'title: Start\npages: [install, ...]\n')
  w('docs-repo/start/2-quick.md', '# Quickstart: first site\n')
  w('docs-repo/start/1-install.md', '---\nid: install-page\n---\n# Install\n')
  w('docs-repo/reference/folder.yml', 'title: Reference\n')
  w('docs-repo/reference/b.md', '# B\n')
  w('docs-repo/reference/a.md', '# A\n')
  w('docs-repo/reference/deep/c.md', '# C\n')
  w('docs-repo/README.md', '# Repo readme\n')
  w('docs-repo/_draft.md', '# Draft\n')
}

describe('folder-mode `.md` pages are pushed as the build makes them', () => {
  it('each file is a page — its one section the file, titled by its first heading', async () => {
    site('index: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('site/pages/guide/folder.yml', 'title: Guide\n')
    w('site/pages/guide/1-install.md', '# Install it\n\nRun the command.\n')
    w('site/pages/guide/2-use.md', 'No heading here.\n')

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    const guide = at(doc, '/guide')
    expect(guide.mode).toBe('folder')
    expect(guide.page_sections).toBeUndefined()

    const install = at(doc, '/guide/install')
    expect(install.mode).toBe('page')
    expect(install.title).toEqual({ en: 'Install it' })
    expect(install.page_sections).toHaveLength(1)
    expect(install.page_sections[0].$id).toBe('install')
    expect(JSON.stringify(install.page_sections[0].content)).toContain('Run the command.')
    // No heading: the build's own fallback, the slug prettified.
    expect(at(doc, '/guide/use').title).toEqual({ en: 'Use' })
  })

  it('follows the build through inherited folder mode, numeric prefixes, `pages:` and the files it ignores', async () => {
    site('index: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('site/pages/docs/folder.yml', 'title: Docs\npages: [zeta, ...]\n')
    w('site/pages/docs/alpha.md', '# Alpha\n')
    w('site/pages/docs/zeta.md', '# Zeta\n')
    // A folder with no config of its own under a folder-mode parent is folder mode too.
    w('site/pages/docs/start/2-quick.md', '# Quick\n')
    w('site/pages/docs/start/1-install.md', '# Install\n')
    w('site/pages/docs/_draft.md', '# Draft\n')
    w('site/pages/docs/README.md', '# Readme\n')

    const doc = await siteProjectToDocument(siteDir())

    const r = routes(doc)
    expect(r).toEqual(await built())
    expect(r).toEqual(expect.arrayContaining(['/docs/zeta', '/docs/alpha', '/docs/start/install', '/docs/start/quick']))
    // `pages:` first, then by filename; a level's pages before its folders — the build's order.
    expect(r.indexOf('/docs/zeta')).toBeLessThan(r.indexOf('/docs/alpha'))
    expect(r.indexOf('/docs/alpha')).toBeLessThan(r.indexOf('/docs/start'))
    expect(r.indexOf('/docs/start/install')).toBeLessThan(r.indexOf('/docs/start/quick'))
    expect(r.join(' ')).not.toMatch(/draft|readme/i)
  })

  it('a file\'s `hidden: true` drafts its page, and its `id:` names its section', async () => {
    site('index: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('site/pages/notes/folder.yml', 'title: Notes\n')
    w('site/pages/notes/soon.md', '---\nhidden: true\nid: coming-soon\n---\n# Soon\n')

    const doc = await siteProjectToDocument(siteDir())

    const soon = at(doc, '/notes/soon')
    expect(soon.hidden).toBe(true)
    expect(soon.page_sections[0].$id).toBe('coming-soon')
  })

  it('`pages/folder.yml` puts the whole site in folder mode — its top-level files are pages, and `index:` is the homepage', async () => {
    site('index: intro\n')
    w('site/pages/folder.yml', 'title: Site\n')
    w('site/pages/intro.md', '# Intro\n')
    w('site/pages/about/about.md', '# About\n')
    w('site/pages/contact/page.yml', 'title: Contact\n')
    w('site/pages/contact/form.md', '# Form\n')

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    expect(doc.pages.find((p) => p.$id === 'intro').is_index).toBe(true)
    expect(at(doc, '/about/about').mode).toBe('page')
    // A `page.yml` opts back into page mode, at the root as anywhere.
    expect(at(doc, '/contact').page_sections).toHaveLength(1)
  })

  it('CONTROL — a page-mode tree is unchanged, at any depth', async () => {
    // A declared homepage, so the build does not promote `a` to `/`.
    site('index: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    for (const dir of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      w(`site/pages/${dir}/page.yml`, `title: ${dir}\n`)
      w(`site/pages/${dir}/hero.md`, '---\ntype: Hero\n---\n\n# Hi\n')
    }

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    for (const route of ['/a', '/a/b', '/a/b/c', '/a/b/c/d']) {
      expect(at(doc, route).mode).toBe('page')
      expect(at(doc, route).page_sections).toHaveLength(1)
    }
  })
})

describe('a `paths: { pages/<segment> }` mount is pushed as the build mounts it', () => {
  it('a documentation repo mounted under a local stub: every page, in the build\'s order', async () => {
    docsSite()

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    expect(routes(doc)).toEqual(expect.arrayContaining([
      '/docs/intro', '/docs/start/install', '/docs/start/quick', '/docs/reference/a', '/docs/reference/b', '/docs/reference/deep/c',
    ]))
    // The configs layer: the stub says how this site presents the route, the repo what it holds.
    const docs = at(doc, '/docs')
    expect(docs.mode).toBe('folder')
    expect(docs.title).toEqual({ en: 'Documentation' })
    expect(docs.label).toEqual({ en: 'Docs' })
    expect(docs.layout).toBe('DocsLayout')
    // The repo's `pages:` orders the route's folders.
    expect(docs.$children.map((c) => c.$id)).toEqual(['intro', 'start', 'reference'])
  })

  it('with no local folder, the route comes from the mount alone', async () => {
    site('index: home\npaths:\n    pages/docs: ../docs-repo\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('docs-repo/folder.yml', 'title: Repo Docs\n')
    w('docs-repo/intro.md', '# Welcome\n')

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    expect(at(doc, '/docs').title).toEqual({ en: 'Repo Docs' })
    expect(at(doc, '/docs/intro').mode).toBe('page')
  })

  it('a `page.yml` stub is a landing page above the mounted pages', async () => {
    site('index: home\npaths:\n    pages/docs: ../docs-repo\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('site/pages/docs/page.yml', 'title: Docs\n')
    w('site/pages/docs/landing.md', '# All the docs\n')
    w('docs-repo/folder.yml', 'title: Repo Docs\n')
    w('docs-repo/intro.md', '# Welcome\n')

    const doc = await siteProjectToDocument(siteDir())

    expect(routes(doc)).toEqual(await built())
    const docs = at(doc, '/docs')
    expect(docs.mode).toBe('page')
    expect(docs.page_sections.map((s) => s.$id)).toEqual(['landing'])
    expect(at(doc, '/docs/intro').mode).toBe('page')
  })

  it('a mount with nothing in it stops the push, naming the submodule — a push replaces the whole page tree', async () => {
    site('paths:\n    pages/docs: ../docs-repo\n')
    w('site/pages/docs/folder.yml', 'title: Docs\n')
    mkdirSync(join(ROOT, 'docs-repo'), { recursive: true })

    await expect(siteProjectToDocument(siteDir())).rejects.toThrow(/git submodule update --init/)
  })

  it('CONTROL — the whole-directory form `paths: { pages: … }` is read as before', async () => {
    site('paths:\n    pages: ./altpages\n')
    w('site/altpages/solo/page.yml', 'title: Solo\n')
    w('site/altpages/solo/hero.md', '---\ntype: Hero\n---\n\n# Solo\n')

    const doc = await siteProjectToDocument(siteDir())

    expect(doc.pages.map((p) => p.$id)).toEqual(['solo'])
  })
})

describe('a pull leaves the pages written in git alone', () => {
  it('a pull of what was pushed writes nothing and deletes nothing in the mount, the stub or a folder of pages', async () => {
    docsSite()
    w('site/pages/blog/folder.yml', 'title: Blog\n')
    w('site/pages/blog/2-older.md', '# Older post\n')
    w('site/pages/blog/1-newer.md', '# Newer post\n')
    const before = snapshot()
    const buildBefore = await built()

    const doc = await siteProjectToDocument(siteDir())
    const report = siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    const after = snapshot()
    for (const [file, body] of Object.entries(before)) {
      if (file.startsWith('docs-repo/') || file.startsWith('site/pages/docs/') || file.startsWith('site/pages/blog/')) {
        expect(after[file], file).toBe(body)
      }
    }
    expect(Object.keys(after).filter((f) => f.startsWith('site/pages/docs/') || f.startsWith('site/pages/blog/')).sort())
      .toEqual(Object.keys(before).filter((f) => f.startsWith('site/pages/docs/') || f.startsWith('site/pages/blog/')).sort())
    expect(existsSync(join(siteDir(), 'pages/blog/newer'))).toBe(false)
    expect(report.leftAlone).toEqual(expect.arrayContaining(['docs', 'blog/newer', 'blog/older']))
    expect(await built()).toEqual(buildBefore)
  })

  it('an edit made in the app to such a page does not come back — the file stays as written', async () => {
    docsSite()
    const doc = await siteProjectToDocument(siteDir())
    const intro = doc.pages.find((p) => p.$id === 'docs').$children.find((c) => c.$id === 'intro')
    intro.title = { en: 'Edited in the app' }
    intro.page_sections[0].content = { en: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'App edit' }] }] } }

    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(readFileSync(join(ROOT, 'docs-repo/intro.md'), 'utf8')).toBe('# Welcome\n\nHello.\n')
    expect(existsSync(join(siteDir(), 'pages/docs/intro'))).toBe(false)
  })

  it('a document without the mounted route does not prune its local folder', async () => {
    docsSite()
    const doc = await siteProjectToDocument(siteDir())
    doc.pages = doc.pages.filter((p) => p.$id !== 'docs')

    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(readFileSync(join(siteDir(), 'pages/docs/folder.yml'), 'utf8')).toContain('title: Documentation')
  })

  it('a level holding a folder-mode page keeps its own order — no `order:` written, no page folder made', async () => {
    site('index: home\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('site/pages/home/hero.md', '# Hi\n')
    w('site/pages/notes/folder.yml', 'title: Notes\n')
    w('site/pages/notes/2-alpha.md', '# Alpha\n')
    w('site/pages/notes/1-zeta.md', '# Zeta\n')
    const before = snapshot()

    const doc = await siteProjectToDocument(siteDir())
    // The backend's order is the files' (zeta, alpha), which filename order alone would reverse.
    expect(at(doc, '/notes').$children.map((c) => c.$id)).toEqual(['zeta', 'alpha'])
    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(readdirSync(join(siteDir(), 'pages/notes')).sort()).toEqual(['1-zeta.md', '2-alpha.md', 'folder.yml'])
    expect(readFileSync(join(siteDir(), 'pages/notes/folder.yml'), 'utf8')).toBe(before['site/pages/notes/folder.yml'])
  })

  it('CONTROL — a page-mode page beside them is still written back', async () => {
    docsSite()
    const doc = await siteProjectToDocument(siteDir())
    doc.pages.find((p) => p.$id === 'home').title = { en: 'Home from the app' }

    siteContentDocumentToProject({ document: doc, siteRoot: siteDir(), prune: true })

    expect(readFileSync(join(siteDir(), 'pages/home/page.yml'), 'utf8')).toContain('Home from the app')
  })
})
