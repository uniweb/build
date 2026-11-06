/**
 * A page's `mode` says what the page itself is (2026-11-05): `atomic`, one `.md` file in
 * folder mode; `atomic-parent`, a directory in folder mode, with no section; `regular`, every other page. A
 * push writes each page's own value from its files; a pull takes a page's form from its files wherever they
 * hold it, where it is or where the app moved it from, but for the app's switch of an empty page between
 * atomic-parent and regular, and places a page new to them by its mode. What the files cannot hold is held:
 * the site keeps the app's version, and the files keep theirs, where they are.
 *
 * ⛔ Measured 2026-11-04, offline, on a docs tree: a pull of what was pushed wrote an empty `folder.yml`
 * into a folder that is in folder mode by inheritance; a pull stopped (ENOTDIR) on an `.md` page the app
 * moved into page mode; a section the app gave a page of single-section pages was dropped, and the
 * next push removed it; and a page the app moved where its files cannot hold it was deleted where it was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { siteProjectToDocument, siteContentDocumentToProject, collectSiteUnits, collectUnitUuids } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-route-mode-'))
  writeFileSync(join(dir, 'site.yml'), "name: S\nfoundation: '@a/b'\n")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}
const has = (rel) => existsSync(join(dir, rel))
const slugOf = (r) => r.slug?.en ?? r.slug
const at = (doc, route) => {
  let list = doc.pages
  let rec = null
  let parent = null
  for (const seg of route.split('/').filter(Boolean)) {
    parent = rec
    rec = (list || []).find((r) => slugOf(r) === seg)
    list = rec?.$children
  }
  return { rec, parent }
}
const detach = (doc, route) => {
  const { rec, parent } = at(doc, route)
  const list = parent ? parent.$children : doc.pages
  list.splice(list.indexOf(rec), 1)
  return rec
}
const attach = (doc, route, rec) => (route ? (at(doc, route).rec.$children ||= []).push(rec) : doc.pages.push(rec))
const routes = (doc) => {
  const out = {}
  const walk = (rs, pre) => {
    for (const r of rs || []) {
      out[`${pre}/${slugOf(r)}`] = `${r.mode}:${(r.page_sections || []).length}`
      walk(r.$children, `${pre}/${slugOf(r)}`)
    }
  }
  walk(doc.pages, '')
  return out
}
const doc1 = (text, heading) => ({ type: 'doc', content: [
  ...(heading ? [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: heading }] }] : []),
  { type: 'paragraph', content: [{ type: 'text', text }] },
] })

// Frontend's tree: atomic-parents, one inheriting folder mode, one declaring it, and regular pages beside
// them.
const TREE = {
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-intro.md': '# Welcome\n\nHello.\n',
  'pages/home/2-more.md': '## More\n\nThere.\n',
  'pages/guide/folder.yml': 'title: Guide\n',
  'pages/guide/1-install.md': '# Install\n\nRun the installer.\n',
  'pages/guide/2-quickstart.md': '# Quickstart\n\nStart here.\n',
  'pages/guide/advanced/deploy.md': '# Deploy\n\nShip it.\n',
  'pages/guide/topics/folder.yml': 'title: Topics\n',
  'pages/guide/topics/routing.md': '# Routing\n\nRoutes.\n',
  'pages/docs/page.yml': 'title: Docs\n',
  'pages/docs/one/page.yml': 'title: One\n',
  'pages/docs/one/content.md': '# One\n\nA page of one section.\n',
}

// A document as a backend returns it: each page and section with its `$uuid`.
function withUuids(doc) {
  const walk = (r, key) => {
    r.$uuid ||= `u-${key}`
    ;(r.page_sections || []).forEach((s, i) => (s.$uuid ||= `u-${key}#${i}`))
    for (const c of r.$children || []) walk(c, `${key}/${slugOf(c)}`)
  }
  for (const p of doc.pages) walk(p, slugOf(p))
  return doc
}

// The tree pushed and pulled once, so this copy's rename index knows where each page is kept.
async function synced() {
  put(TREE)
  spawnSync('git', ['init', '-q'], { cwd: dir })
  const doc = withUuids(await siteProjectToDocument(dir))
  siteContentDocumentToProject({ document: structuredClone(doc), siteRoot: dir, prune: true })
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-qm', 'synced'], { cwd: dir })
  return doc
}
const changed = () =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'pages'], { cwd: dir, encoding: 'utf8' }).stdout
    .split('\n').filter(Boolean).map((l) => `${l.slice(0, 2).trim()} ${l.slice(3).replace('pages/', '')}`).sort()
const pull = (doc) => siteContentDocumentToProject({ document: structuredClone(doc), siteRoot: dir, prune: true })

describe('what a push writes in `mode`', () => {
  // Each page's own mode (2026-11-05). ⛔ Until then: `single-section` on the page
  // whose child pages were in folder mode, and `page` on every other, the `.md` pages under it included.
  it('⭐ `atomic` on each `.md` page, `atomic-parent` on its directory, declared or inherited, `regular` on the rest', async () => {
    put(TREE)
    const doc = await siteProjectToDocument(dir)
    expect(routes(doc)).toEqual({
      '/home': 'regular:2',
      '/guide': 'atomic-parent:0',
      '/guide/install': 'atomic:1',
      '/guide/quickstart': 'atomic:1',
      '/guide/advanced': 'atomic-parent:0',
      '/guide/advanced/deploy': 'atomic:1',
      '/guide/topics': 'atomic-parent:0',
      '/guide/topics/routing': 'atomic:1',
      '/docs': 'regular:0',
      '/docs/one': 'regular:1',
    })
  })

  it("an atomic-parent is its `folder.yml` in a site's sync state; every other page its `page.yml`", () => {
    const doc = (mode) => ({ info: { name: { en: 'S' } }, pages: [{ $id: 'guide', slug: { en: 'guide' }, mode }] })
    expect([...collectSiteUnits(doc('atomic-parent')).keys()]).toContain('pages/guide/folder.yml')
    expect([...collectSiteUnits(doc('atomic')).keys()]).toContain('pages/guide/page.yml')
    expect([...collectSiteUnits(doc('regular')).keys()]).toContain('pages/guide/page.yml')
    // A value this framework doesn't know is regular's.
    expect([...collectSiteUnits(doc('single-section')).keys()]).toContain('pages/guide/page.yml')
  })
})

describe('what a pull writes, and holds', () => {
  it('⭐ a pull of what was pushed changes no file — no `folder.yml` for a folder in folder mode by inheritance', async () => {
    const doc = await synced()
    pull(doc)
    expect(changed()).toEqual([])
    expect(has('pages/guide/advanced/folder.yml')).toBe(false)
  })

  it("a page whose mode this framework doesn't know keeps its files' form: no file changes", async () => {
    const doc = await synced()
    at(doc, '/guide').rec.mode = 'folder'
    at(doc, '/guide/topics').rec.mode = 'page'
    pull(doc)
    expect(changed()).toEqual([])
  })

  it('an atomic-parent the app moves under a regular page stays one, its `folder.yml` written where it lands', async () => {
    const doc = await synced()
    attach(doc, '', detach(doc, '/guide/advanced'))
    const report = pull(doc)
    expect(report.held).toEqual([])
    expect(has('pages/advanced/folder.yml')).toBe(true)
    expect(has('pages/advanced/deploy.md')).toBe(true)
    expect(has('pages/guide/advanced')).toBe(false)
    expect(routes(await siteProjectToDocument(dir))).toEqual(routes(doc))
  })

  it('⭐ an atomic page the app moves under a regular page becomes regular there: a page folder, and its file goes', async () => {
    const doc = await synced()
    attach(doc, '', detach(doc, '/guide/install'))
    at(doc, '/install').rec.mode = 'regular'
    const report = pull(doc)
    expect(report.held).toEqual([])
    expect(has('pages/install/install.md')).toBe(true)
    expect(has('pages/guide/1-install.md')).toBe(false)
    expect(routes(await siteProjectToDocument(dir))).toEqual(routes(doc))
  })

  it('a page of one section the app moves into an atomic-parent becomes atomic: an `.md` file', async () => {
    const doc = await synced()
    attach(doc, '/guide', detach(doc, '/docs/one'))
    at(doc, '/guide/one').rec.mode = 'atomic'
    const report = pull(doc)
    expect(report.held).toEqual([])
    expect(has('pages/guide/one.md')).toBe(true)
    expect(has('pages/docs/one')).toBe(false)
    expect(routes(await siteProjectToDocument(dir))).toEqual(routes(doc))
  })

  it('⭐ a page the app moves where its files cannot hold it is held, and keeps its files where they are', async () => {
    const doc = await synced()
    attach(doc, '/guide', detach(doc, '/home'))
    const report = pull(doc)
    expect(report.held.map((h) => [h.route, h.what])).toEqual([['guide/home', ['more than one section']]])
    expect(changed()).toEqual([])
  })

  it('⭐ a section the app gives an atomic-parent is held, and its child pages are written', async () => {
    const doc = await synced()
    at(doc, '/guide').rec.page_sections = [{ $uuid: 'u-new', stable_id: 'welcome', type: 'Section', content: doc1('Welcome.') }]
    at(doc, '/guide/quickstart').rec.page_sections[0].content = doc1('Start here, now.', 'Quickstart')
    const report = pull(doc)
    expect(report.held.map((h) => [h.route, h.uuids])).toEqual([['guide', ['u-new']]])
    expect(changed()).toEqual(['M guide/2-quickstart.md'])
  })

  it('a section-less page the app makes in an atomic-parent is one; one made regular there is held', async () => {
    const doc = await synced()
    const page = (slug, mode, sections, children) => ({ $uuid: `n-${slug}`, slug: { en: slug }, mode, title: { en: slug.toUpperCase() }, page_sections: sections, ...(children ? { $children: children } : {}) })
    const faq = () => page('faq', 'atomic', [{ $uuid: 'n-faq#0', stable_id: 'faq', type: 'Section', content: doc1('Answers.', 'FAQ') }])
    attach(doc, '/guide', page('extras', 'atomic-parent', [], [faq()]))
    attach(doc, '/guide/topics', page('more', 'regular', [], [faq()]))
    const report = pull(doc)
    expect(has('pages/guide/extras/faq.md')).toBe(true)
    expect(report.held.map((h) => [h.route, h.what])).toEqual([['guide/topics/more', ['no section', 'pages below it']]])
  })

  it('a parametric page, a second section, and a page below an atomic page are held', async () => {
    const doc = await synced()
    const section = (id) => ({ $uuid: `n-${id}`, stable_id: id, type: 'Section', content: doc1('Made in the app.', 'Made') })
    attach(doc, '/guide', { $uuid: 'n-post', slug: { en: 'slug' }, mode: 'regular', is_dynamic: true, param_name: 'slug', page_sections: [section('post')] })
    at(doc, '/guide/quickstart').rec.page_sections.push(section('second'))
    attach(doc, '/guide/install', { $uuid: 'n-below', slug: { en: 'below' }, mode: 'atomic', title: { en: 'Made' }, page_sections: [section('below')] })
    const report = pull(doc)
    expect(report.held.map((h) => [h.route, h.what]).sort()).toEqual([
      ['guide/install', ['pages below it']],
      ['guide/quickstart', ['more than one section']],
      ['guide/slug', ['a parametric page, which an atomic-parent holds none of']],
    ])
    expect(changed()).toEqual([])
  })
})

// ⭐ A PULL IN A REPOSITORY RUNS WITH NO RENAME INDEX (its stand-in has none), so where a page was is read
// from this copy's item identity as it stood before the pull merged the pulled document's in (`priorItems`).
// ⛔ Until 2026-11-05 a moved held page's files were pruned there, and a moved route took its `mode`'s form.
describe('in a repository, where a pull has no rename index', () => {
  const pullAsInARepository = (doc, before) => {
    rmSync(join(dir, '.uniweb', 'pull-index.json'), { force: true })
    return siteContentDocumentToProject({ document: structuredClone(doc), siteRoot: dir, prune: true, priorItems: collectUnitUuids(before) })
  }

  it('⭐ a page the app moves where its files cannot hold it is held, and keeps its files where they are', async () => {
    const doc = await synced()
    const before = structuredClone(doc)
    attach(doc, '/guide', detach(doc, '/docs'))
    attach(doc, '/guide', detach(doc, '/home'))
    const report = pullAsInARepository(doc, before)
    expect(report.held.map((h) => h.route).sort()).toEqual(['guide/docs', 'guide/home'])
    expect(changed()).toEqual([])
  })

  it('a route the app moves keeps its form, stored in either spelling', async () => {
    const doc = await synced()
    const before = structuredClone(doc)
    at(doc, '/guide/topics').rec.mode = 'folder'
    attach(doc, '', detach(doc, '/guide/topics'))
    const report = pullAsInARepository(doc, before)
    expect(report.held).toEqual([])
    expect(has('pages/topics/folder.yml')).toBe(true)
    expect(has('pages/topics/routing.md')).toBe(true)
    expect(has('pages/topics/page.yml')).toBe(false)
    expect(has('pages/guide/topics')).toBe(false)
  })

  it('CONTROL — the same moves with the rename index, as a pull outside a repository has it', async () => {
    const doc = await synced()
    attach(doc, '/guide', detach(doc, '/docs'))
    at(doc, '/guide/topics').rec.mode = 'folder'
    attach(doc, '', detach(doc, '/guide/topics'))
    const report = pull(doc)
    expect(report.held.map((h) => h.route)).toEqual(['guide/docs'])
    expect(has('pages/docs/one/content.md')).toBe(true)
    expect(has('pages/topics/folder.yml')).toBe(true)
  })
})

// A page new to the files takes its form from its own mode, and in a fresh clone every page is new.
it('a fresh clone writes each atomic-parent in folder mode and each atomic page as an `.md` file', async () => {
  const doc = await synced()
  rmSync(join(dir, 'pages'), { recursive: true, force: true })
  rmSync(join(dir, '.uniweb'), { recursive: true, force: true })
  pull(doc)
  expect(has('pages/guide/folder.yml')).toBe(true)
  expect(has('pages/guide/page.yml')).toBe(false)
  expect(has('pages/guide/install.md')).toBe(true)
  expect(has('pages/guide/topics/routing.md')).toBe(true)
  expect(has('pages/docs/one/page.yml')).toBe(true)
})

// ⭐ THE APP'S SWITCH ON AN EMPTY PAGE: a page with no section and no child page
// is made an atomic-parent, or regular again. Nothing has to be converted: its config takes the other name.
describe("the app's switch on an empty page", () => {
  const withEmpty = async (config) => {
    put({ ...TREE, ...config })
    spawnSync('git', ['init', '-q'], { cwd: dir })
    const doc = withUuids(await siteProjectToDocument(dir))
    siteContentDocumentToProject({ document: structuredClone(doc), siteRoot: dir, prune: true })
    return doc
  }

  it('⭐ an empty regular page made an atomic-parent: its `page.yml` becomes its `folder.yml`, as written', async () => {
    const doc = await withEmpty({ 'pages/notes/page.yml': 'title: Notes\nlabel: My notes\n' })
    expect(at(doc, '/notes').rec.mode).toBe('regular')
    at(doc, '/notes').rec.mode = 'atomic-parent'
    pull(doc)
    expect(has('pages/notes/page.yml')).toBe(false)
    expect(readFileSync(join(dir, 'pages/notes/folder.yml'), 'utf8')).toMatch(/label: My notes/)
    expect(at(await siteProjectToDocument(dir), '/notes').rec.mode).toBe('atomic-parent')
  })

  it('an empty atomic-parent made regular again: its `folder.yml` becomes its `page.yml`', async () => {
    const doc = await withEmpty({ 'pages/notes/folder.yml': 'title: Notes\n' })
    expect(at(doc, '/notes').rec.mode).toBe('atomic-parent')
    at(doc, '/notes').rec.mode = 'regular'
    pull(doc)
    expect(has('pages/notes/folder.yml')).toBe(false)
    expect(has('pages/notes/page.yml')).toBe(true)
    expect(at(await siteProjectToDocument(dir), '/notes').rec.mode).toBe('regular')
  })

  it('CONTROL — a page with sections or child pages keeps its files\' form', async () => {
    const doc = await synced()
    at(doc, '/docs').rec.mode = 'atomic-parent'
    at(doc, '/guide').rec.mode = 'regular'
    pull(doc)
    expect(changed()).toEqual([])
  })

  it('an empty atomic-parent inside folder mode stays one: a regular page has no place there', async () => {
    const doc = await withEmpty({ 'pages/guide/later/folder.yml': 'title: Later\n' })
    expect(at(doc, '/guide/later').rec.mode).toBe('atomic-parent')
    at(doc, '/guide/later').rec.mode = 'regular'
    pull(doc)
    expect(has('pages/guide/later/folder.yml')).toBe(true)
    expect(has('pages/guide/later/page.yml')).toBe(false)
  })
})

describe('⛔ a page with its own `page.yml` inside folder mode', () => {
  it('stops the push, naming the folder and what to do', async () => {
    put({ ...TREE, 'pages/guide/reference/page.yml': 'title: Reference\n', 'pages/guide/reference/1-overview.md': '# Overview\n' })
    await expect(siteProjectToDocument(dir)).rejects.toThrow(/`pages\/guide\/reference` has a page\.yml of its own inside folder mode/)
  })

  it('stops the build the same way', async () => {
    put({ ...TREE, 'pages/guide/reference/page.yml': 'title: Reference\n', 'pages/guide/reference/1-overview.md': '# Overview\n' })
    await expect(collectSiteContent(dir)).rejects.toThrow(/`pages\/guide\/reference` has a page\.yml of its own inside folder mode/)
  })

  it('…a parametric one too, which an atomic-parent holds none of', async () => {
    put({ ...TREE, 'pages/guide/[slug]/page.yml': 'title: Post\n', 'pages/guide/[slug]/body.md': '# Post\n' })
    await expect(siteProjectToDocument(dir)).rejects.toThrow(/`pages\/guide\/\[slug\]` has a page\.yml of its own inside folder mode/)
  })

  it("CONTROL — a document's content, in folder mode by default, keeps a chapter of several sections as a `page.yml`", async () => {
    put({ 'document.yml': 'title: Book\n', 'content/book/page.yml': 'title: Book\n', 'content/book/1-one.md': '# One\n', 'content/book/2-two.md': '## Two\n' })
    const content = await collectSiteContent(dir, { configFile: 'document.yml' })
    expect(content.pages.map((p) => p.sections?.length)).toContain(2)
  })

  it('CONTROL — a directory below one, with its own `folder.yml` or none, is an atomic-parent', async () => {
    put(TREE)
    await expect(siteProjectToDocument(dir)).resolves.toBeTruthy()
  })
})
