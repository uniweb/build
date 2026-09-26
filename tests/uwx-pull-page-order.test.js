/**
 * ⭐ A PULL LEAVES EACH LEVEL IN THE BACKEND'S ORDER, AND THE SITE NAMING ITS HOMEPAGE.
 *
 * Measured 2026-09-25/26 by round trips of the `international` and `marketing` templates: a clone's
 * menus came back in filename order (their `order:` values and `pages:` list gone), a clone kept its
 * scaffold's `index: home` whatever the homepage was, and a pull into the author's copy added
 * `index: true` to the homepage's page.yml and moved the `...` in a page's `sections:` list.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteContentDocumentToProject } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let SITE
afterEach(() => SITE && rmSync(SITE, { recursive: true, force: true }))

const docOf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const page = (name, extra = {}) => ({
  $id: name,
  slug: { en: name },
  mode: 'page',
  stable_id: name,
  title: { en: name },
  page_sections: [{ $id: `${name}-hero`, stable_id: `${name}-hero`, type: 'Hero', content: docOf(name) }],
  ...extra,
})

function pull(pages, files = {}) {
  SITE = SITE || mkdtempSync(join(tmpdir(), 'uwx-pull-order-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = join(SITE, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  siteContentDocumentToProject({ siteRoot: SITE, document: { info: { name: 'Site' }, pages } })
}
const yml = (rel) => yaml.load(readFileSync(join(SITE, rel), 'utf8')) || {}
const orders = (names) => names.map((n) => yml(`pages/${n}/page.yml`).order)
// The top level as the build renders it from the files the pull wrote — the collector itself, not the
// push walk's `orderFolders`, which differs from it for numbered page folders.
const builtOrder = async () =>
  (await collectSiteContent(SITE)).pages
    .map((p) => (p.sourcePath || p.route).split('/').filter(Boolean))
    .filter((parts) => parts.length === 1)
    .map(([name]) => name)

describe('pull — a clone gets the backend’s order and homepage', () => {
  it('⭐ a level out of filename order is numbered in the backend’s order — only as far as it must be', async () => {
    // `features` and `pricing` follow `home` by filename, as the build places pages with no `order:`.
    pull([page('home', { is_index: true }), page('features'), page('pricing')], { 'site.yml': 'name: Site\nindex: home\n' })
    expect(orders(['home', 'features', 'pricing'])).toEqual([1, undefined, undefined])
    expect(await builtOrder()).toEqual(['home', 'features', 'pricing'])
    expect(yml('pages/home/page.yml').index).toBeUndefined()
    expect(yml('site.yml').index).toBe('home')
  })

  it('⭐ the pages at the end that follow by filename get no number — `international`’s shape', async () => {
    const names = ['about', 'research', 'blog', 'contact', '404', 'home']
    pull(names.map((n) => page(n, n === 'home' ? { is_index: true } : {})), { 'site.yml': 'name: Site\nindex: home\n' })
    expect(orders(names)).toEqual([1, 2, 3, 4, undefined, undefined])
    // `404` is the build's not-found slot, lifted out of the pages it orders.
    expect(await builtOrder()).toEqual(names.filter((n) => n !== '404'))
  })

  it('a homepage marked in its own page.yml stays marked there alone — site.yml gets no `index:`', () => {
    pull([page('home', { is_index: true }), page('about')], {
      'site.yml': 'name: Site\n',
      'pages/home/page.yml': 'title: home\nindex: true\n',
    })
    expect(yml('site.yml').index).toBeUndefined()
    expect(yml('pages/home/page.yml').index).toBe(true)
  })

  it('⭐ the homepage the backend marks replaces a scaffold’s `index: home`', () => {
    pull([page('docs', { is_index: true }), page('guide')], { 'site.yml': 'name: Site\nindex: home\n' })
    expect(yml('site.yml').index).toBe('docs')
  })

  it('CONTROL — a level already in filename order is left without numbers', () => {
    pull([page('about', { is_index: true }), page('blog'), page('contact')], { 'site.yml': 'name: Site\nindex: about\n' })
    expect(orders(['about', 'blog', 'contact'])).toEqual([undefined, undefined, undefined])
  })
})

describe('pull — an existing copy keeps the order it says its own way', () => {
  const wire = () => [page('about'), page('research'), page('blog'), page('home', { is_index: true })]

  it('⭐ authored `order:` values that give the backend’s order are left as they are', () => {
    pull(wire(), {
      'site.yml': 'name: Site\nindex: home\n',
      'pages/about/page.yml': 'title: about\norder: 1\n',
      'pages/research/page.yml': 'title: research\norder: 2\n',
      'pages/blog/page.yml': 'title: blog\norder: 3\n',
      'pages/home/page.yml': 'title: home\n',
    })
    expect(orders(['about', 'research', 'blog', 'home'])).toEqual([1, 2, 3, undefined])
  })

  it('⭐ a site.yml `pages:` list that gives it is left as it is — `...` where the author put it', () => {
    pull([page('home', { is_index: true }), page('features'), page('pricing')], {
      'site.yml': 'name: Site\npages: [home, features, ..., pricing]\n',
    })
    expect(yml('site.yml').pages).toEqual(['home', 'features', '...', 'pricing'])
    expect(yml('site.yml').index).toBeUndefined()
    expect(orders(['home', 'features', 'pricing'])).toEqual([undefined, undefined, undefined])
  })

  it('an order changed in the app is written the way the copy says it — `order:` values', async () => {
    pull([page('research'), page('about'), page('blog'), page('home', { is_index: true })], {
      'site.yml': 'name: Site\nindex: home\n',
      'pages/about/page.yml': 'order: 1\n',
      'pages/research/page.yml': 'order: 2\n',
      'pages/blog/page.yml': 'order: 3\n',
    })
    // `home` had none and follows by filename, so it is left without one.
    expect(orders(['research', 'about', 'blog', 'home'])).toEqual([1, 2, 3, undefined])
    expect(await builtOrder()).toEqual(['research', 'about', 'blog', 'home'])
  })

  it('an order changed in the app is written the way the copy says it — its `pages:` list', () => {
    pull([page('home', { is_index: true }), page('pricing'), page('features')], {
      'site.yml': 'name: Site\npages: [home, features, pricing, ...]\n',
    })
    expect(yml('site.yml').pages).toEqual(['home', 'pricing', 'features', '...'])
  })

  it('⭐ the homepage keeps its page.yml as the author wrote it, and a `sections:` list its `...`', () => {
    const home = page('home', { is_index: true })
    home.page_sections = ['hero', 'features', 'cta'].map((id) => ({ $id: id, stable_id: id, type: 'Section', content: docOf(id) }))
    pull([home, page('pricing')], {
      'site.yml': 'name: Site\nindex: home\n',
      'pages/home/page.yml': 'title: home\nsections: [hero, features, ..., cta]\n',
    })
    expect(yml('pages/home/page.yml').index).toBeUndefined()
    expect(yml('pages/home/page.yml').sections).toEqual(['hero', 'features', '...', 'cta'])
  })
})
