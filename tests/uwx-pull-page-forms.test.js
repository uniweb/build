/**
 * A pull into the copy that pushed leaves a page's own forms as written.
 *
 * ⛔ Measured 2026-10-08 across a set of real sites (an offline push, then a pull into the same copy):
 * a page nesting its sections with `nest:` — the form the docs lead with — came back with a
 * `sections:` list beside it saying the same nesting twice, and a page with no `page.yml` came back
 * with one holding `{}`. Each test pushes real files with the producer and pulls them back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-page-forms-'))
  writeFileSync(join(dir, 'site.yml'), "name: S\nfoundation: '@a/b'\n")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}
const read = (rel) => readFileSync(join(dir, rel), 'utf8')
const section = (type, heading) => `---\ntype: ${type}\n---\n# ${heading}\n`
const NESTED = {
  'pages/home/page.yml': 'title: Home\n\n# the cards sit in the grid\nnest:\n  features: [card-a, card-b]\n',
  'pages/home/1-hero.md': section('Hero', 'Welcome'),
  'pages/home/2-features.md': section('Grid', 'Features'),
  'pages/home/@card-a.md': section('Card', 'A'),
  'pages/home/@card-b.md': section('Card', 'B'),
  'pages/home/3-closing.md': section('Section', 'Bye'),
}
const homeOf = (document) => document.pages.find((p) => p.$id === 'home' || p.stable_id === 'home')

describe('a page nested with `nest:`', () => {
  it('⭐ comes back as written — no `sections:` list beside it', async () => {
    put(NESTED)
    const document = await siteProjectToDocument(dir)
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(read('pages/home/page.yml')).toBe(NESTED['pages/home/page.yml'])
    expect(readdirSync(join(dir, 'pages/home')).sort()).toEqual(['1-hero.md', '2-features.md', '3-closing.md', '@card-a.md', '@card-b.md', 'page.yml'])
  })

  it('⭐ a nesting changed in the app comes back as a list, and the `nest:` that would override it goes', async () => {
    put(NESTED)
    const document = await siteProjectToDocument(dir)
    const grid = homeOf(document).page_sections.find((s) => s.stable_id === 'features')
    grid.$children = grid.$children.filter((c) => c.stable_id === 'card-a') // card B moved out of the grid
    homeOf(document).page_sections.push({ $id: 'card-b', stable_id: 'card-b', type: 'Card', content: { type: 'doc', content: [] } })
    siteContentDocumentToProject({ document, siteRoot: dir })
    const page = yaml.load(read('pages/home/page.yml'))
    expect(page.nest).toBeUndefined()
    expect(page.sections).toEqual(['hero', { features: ['card-a'] }, 'closing', 'card-b', '...'])
    expect(page.title).toBe('Home')
  })

  it('CONTROL — a page that does not nest keeps its `nest:` untouched', async () => {
    put({ 'pages/about/page.yml': 'title: About\nnest:\n  missing: [nowhere]\n', 'pages/about/1-intro.md': section('Section', 'Intro') })
    const document = await siteProjectToDocument(dir)
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(read('pages/about/page.yml')).toBe('title: About\nnest:\n  missing: [nowhere]\n')
  })

  it('CONTROL — a clone, with no `nest:` of the author’s, gets the list', async () => {
    put(NESTED)
    const document = await siteProjectToDocument(dir)
    const clone = mkdtempSync(join(tmpdir(), 'uwx-page-forms-clone-'))
    try {
      writeFileSync(join(clone, 'site.yml'), "name: S\nfoundation: '@a/b'\n")
      siteContentDocumentToProject({ document, siteRoot: clone })
      const page = yaml.load(readFileSync(join(clone, 'pages/home/page.yml'), 'utf8'))
      expect(page.sections).toEqual(['hero', { features: ['card-a', 'card-b'] }, 'closing', '...'])
      expect(page.nest).toBeUndefined()
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  })
})

describe('a page with nothing for its `page.yml` to say', () => {
  it('⭐ gets none — the build reads an empty one as none', async () => {
    put({ 'pages/story/1-intro.md': section('Section', 'Our story'), 'pages/story/2-more.md': section('Section', 'More') })
    const document = await siteProjectToDocument(dir)
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(existsSync(join(dir, 'pages/story/page.yml'))).toBe(false)
  })

  it('CONTROL — one with something to say gets it', async () => {
    put({ 'pages/story/1-intro.md': section('Section', 'Our story') })
    const document = await siteProjectToDocument(dir)
    document.pages[0].title = { en: 'Our Story' }
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(yaml.load(read('pages/story/page.yml'))).toEqual({ title: 'Our Story' })
  })

  it('CONTROL — an empty `folder.yml` is still written: its presence is folder mode', async () => {
    put({ 'pages/notes/folder.yml': '', 'pages/notes/one.md': section('Section', 'One') })
    const document = await siteProjectToDocument(dir)
    rmSync(join(dir, 'pages/notes/folder.yml'))
    siteContentDocumentToProject({ document, siteRoot: dir })
    expect(existsSync(join(dir, 'pages/notes/folder.yml'))).toBe(true)
  })
})

// ⛔ Measured 2026-10-08 on a salon site's contact page: a child `@booking-form.md` that `nest:` names
// beside a top-level `1-booking-form.md`. The build nests the child; the push read the name as the
// top-level file and sent the child as an orphan at the end of the page, and a pull then wrote the
// child's content into the top-level file. (Two sections of one name stay an authoring problem — a
// clone writes both to one file, and a push says so — but the copy that pushed keeps them apart.)
describe('a child named like a top-level section', () => {
  const SHARED = {
    'pages/contact/page.yml': 'nest:\n  grid: [booking-form, details]\n',
    'pages/contact/1-booking-form.md': section('Hero', 'Reserved'),
    'pages/contact/2-grid.md': section('Grid', 'Grid'),
    'pages/contact/@booking-form.md': section('BookingForm', 'Request'),
    'pages/contact/@details.md': section('Details', 'Visit'),
  }
  const tree = (sections, kids = 'subsections') => (sections || []).map((s) => {
    const children = s[kids] || s.$children
    return children?.length ? { [`${s.stableId ?? s.stable_id}:${s.type}`]: tree(children, kids) } : `${s.stableId ?? s.stable_id}:${s.type}`
  })

  it('⭐ the push nests it as the build does', async () => {
    put(SHARED)
    const { collectSiteContent } = await import('../src/site/content-collector.js')
    const built = (await collectSiteContent(dir)).pages[0].sections // the site's one page
    const pushed = (await siteProjectToDocument(dir)).pages[0].page_sections
    expect(tree(pushed, '$children')).toEqual(tree(built))
    expect(tree(built)).toEqual(['booking-form:Hero', { 'grid:Grid': ['booking-form:BookingForm', 'details:Details'] }])
  })

  it('⭐ a pull into the copy that pushed keeps each in its own file', async () => {
    put(SHARED)
    const document = await siteProjectToDocument(dir)
    siteContentDocumentToProject({ document, siteRoot: dir })
    for (const [rel, text] of Object.entries(SHARED)) expect(read(rel)).toBe(text)
  })
})
