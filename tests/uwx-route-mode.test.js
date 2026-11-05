/**
 * A route's `mode` says what its pages may hold: `single-section` where each is one section, as a folder
 * in folder mode keeps them, one `.md` file each, else `page`. A push writes each route's own value; a
 * pull takes a route's form from its files wherever they hold it, where it is or where the app moved it
 * from, and reads `mode` only for a route new to them. What the files cannot hold is held: the site
 * keeps the app's version, and the files keep theirs, where they are.
 *
 * ⛔ Measured 2026-11-04, offline, on a docs tree: a pull of what was pushed wrote an empty `folder.yml`
 * into a folder that is in folder mode by inheritance; a pull stopped (ENOTDIR) on an `.md` page the app
 * moved into page mode; a section the app gave a folder of single-section pages was dropped, and the
 * next push removed it; and a page the app moved where its files cannot hold it was deleted where it was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { siteProjectToDocument, siteContentDocumentToProject, collectSiteUnits } from '../src/uwx/index.js'

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

// Frontend's tree: a folder of single-section pages, one inheriting its mode, one declaring it, and pages
// in page mode beside them.
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
  it('⭐ `single-section` on a folder of single-section pages, declared or inherited, and `page` on every page', async () => {
    put(TREE)
    const doc = await siteProjectToDocument(dir)
    expect(routes(doc)).toEqual({
      '/home': 'page:2',
      '/guide': 'single-section:0',
      '/guide/install': 'page:1',
      '/guide/quickstart': 'page:1',
      '/guide/advanced': 'single-section:0',
      '/guide/advanced/deploy': 'page:1',
      '/guide/topics': 'single-section:0',
      '/guide/topics/routing': 'page:1',
      '/docs': 'page:0',
      '/docs/one': 'page:1',
    })
  })

  it('a route in either spelling is one unit of a site\'s sync state, its `folder.yml`', () => {
    const doc = (mode) => ({ info: { name: { en: 'S' } }, pages: [{ $id: 'guide', slug: { en: 'guide' }, mode }] })
    expect([...collectSiteUnits(doc('single-section')).keys()]).toContain('pages/guide/folder.yml')
    expect([...collectSiteUnits(doc('folder')).keys()]).toContain('pages/guide/folder.yml')
    expect([...collectSiteUnits(doc('page')).keys()]).toContain('pages/guide/page.yml')
  })
})

describe('what a pull writes, and holds', () => {
  it('⭐ a pull of what was pushed changes no file — no `folder.yml` for a folder in folder mode by inheritance', async () => {
    const doc = await synced()
    pull(doc)
    expect(changed()).toEqual([])
    expect(has('pages/guide/advanced/folder.yml')).toBe(false)
  })

  it("a route's form is its files': a stored route in another spelling changes no file", async () => {
    const doc = await synced()
    at(doc, '/guide').rec.mode = 'folder'
    at(doc, '/guide/topics').rec.mode = 'page'
    pull(doc)
    expect(changed()).toEqual([])
  })

  it('a folder of single-section pages the app moves into page mode stays one, its `folder.yml` written where it lands', async () => {
    const doc = await synced()
    attach(doc, '', detach(doc, '/guide/advanced'))
    const report = pull(doc)
    expect(report.held).toEqual([])
    expect(has('pages/advanced/folder.yml')).toBe(true)
    expect(has('pages/advanced/deploy.md')).toBe(true)
    expect(has('pages/guide/advanced')).toBe(false)
    expect(routes(await siteProjectToDocument(dir))).toEqual(routes(doc))
  })

  it('⭐ an `.md` page the app moves into page mode becomes a page folder, and its file goes', async () => {
    const doc = await synced()
    attach(doc, '', detach(doc, '/guide/install'))
    const report = pull(doc)
    expect(report.held).toEqual([])
    expect(has('pages/install/install.md')).toBe(true)
    expect(has('pages/guide/1-install.md')).toBe(false)
    expect(routes(await siteProjectToDocument(dir))).toEqual(routes(doc))
  })

  it('a page folder of one section the app moves into a folder of single-section pages becomes an `.md` file', async () => {
    const doc = await synced()
    attach(doc, '/guide', detach(doc, '/docs/one'))
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

  it('⭐ a section the app gives a folder of single-section pages is held, and its pages are written', async () => {
    const doc = await synced()
    at(doc, '/guide').rec.page_sections = [{ $uuid: 'u-new', stable_id: 'welcome', type: 'Section', content: doc1('Welcome.') }]
    at(doc, '/guide/quickstart').rec.page_sections[0].content = doc1('Start here, now.', 'Quickstart')
    const report = pull(doc)
    expect(report.held.map((h) => [h.route, h.uuids])).toEqual([['guide', ['u-new']]])
    expect(changed()).toEqual(['M guide/2-quickstart.md'])
  })

  it('a folder the app makes there with the parent\'s value is a folder; one written `page` is held', async () => {
    const doc = await synced()
    const page = (slug, mode, sections, children) => ({ $uuid: `n-${slug}`, slug: { en: slug }, mode, title: { en: slug.toUpperCase() }, page_sections: sections, ...(children ? { $children: children } : {}) })
    const faq = () => page('faq', 'page', [{ $uuid: 'n-faq#0', stable_id: 'faq', type: 'Section', content: doc1('Answers.', 'FAQ') }])
    attach(doc, '/guide', page('extras', 'single-section', [], [faq()]))
    attach(doc, '/guide/topics', page('more', 'page', [], [faq()]))
    const report = pull(doc)
    expect(has('pages/guide/extras/faq.md')).toBe(true)
    expect(report.held.map((h) => [h.route, h.what])).toEqual([['guide/topics/more', ['no section', 'pages below it']]])
  })

  it('a parametric page, a second section, and a page below a single-section page are held', async () => {
    const doc = await synced()
    const section = (id) => ({ $uuid: `n-${id}`, stable_id: id, type: 'Section', content: doc1('Made in the app.', 'Made') })
    attach(doc, '/guide', { $uuid: 'n-post', slug: { en: 'slug' }, mode: 'page', is_dynamic: true, param_name: 'slug', page_sections: [section('post')] })
    at(doc, '/guide/quickstart').rec.page_sections.push(section('second'))
    attach(doc, '/guide/install', { $uuid: 'n-below', slug: { en: 'below' }, mode: 'page', title: { en: 'Made' }, page_sections: [section('below')] })
    const report = pull(doc)
    expect(report.held.map((h) => [h.route, h.what]).sort()).toEqual([
      ['guide/install', ['pages below it']],
      ['guide/quickstart', ['more than one section']],
      ['guide/slug', ['a parametric page, which a route of single-section pages holds none of']],
    ])
    expect(changed()).toEqual([])
  })
})
