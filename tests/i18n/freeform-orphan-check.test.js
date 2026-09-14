/**
 * The free-form orphan and stale check judges the files the renderer reads — no more,
 * no less.
 *
 * ⛔ Measured on the `international` template: `locales/freeform/es/pages/about/story.md`
 * was reported "orphaned" while the Spanish page rendered it. The renderer
 * (`loadFreeformTranslation`) tries `page-ids/<page id>/<section>.md` and then
 * `pages/<route>/<section>.md`; the check knew only the first when a page has an `id`,
 * so every route-addressed file on such a page read as orphaned — and was never checked
 * for staleness. It also walked top-level page sections only, where the renderer
 * translates subsections, the 404 page and layout areas too.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLocalizedContent, computeSourceHash } from '../../src/i18n/index.js'

let ROOT
let warnings
let saved
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const section = (stableId, text, subsections = []) => ({ id: stableId, stableId, content: doc(text), subsections })

const STORY = doc('Our story')
const siteContent = () => ({
  config: { name: 'T' },
  pages: [
    { route: '/about', id: 'ae274cc8', title: 'About', sections: [{ ...section('story', 'Our story'), subsections: [section('detail', 'The detail')] }] },
  ],
  notFound: { route: '/404', title: 'Not found', sections: [section('lost', 'Lost')] },
  layouts: { default: { header: { sections: [section('brand', 'Brand')] } } },
})

const run = async () => {
  warnings = []
  await buildLocalizedContent(ROOT, { locales: ['es'], generateSearchIndexes: false })
  return warnings
}
const orphaned = () => warnings.filter((m) => m.includes('orphaned')).map((m) => m.replace(/^.*orphaned: /, ''))
const stale = () => warnings.filter((m) => m.includes('stale')).map((m) => m.replace(/^.*stale: /, '').replace(/ \(.*$/, ''))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'freeform-orphans-'))
  saved = [console.warn, console.log]
  console.warn = (m) => warnings.push(String(m))
  console.log = () => {}
  w('dist/site-content.json', siteContent())
  w('locales/freeform/es/pages/about/story.md', 'Nuestra historia\n')
})
afterEach(() => {
  ;[console.warn, console.log] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a route-addressed file on a page with an id', () => {
  it('is rendered — and is not reported orphaned', async () => {
    w('locales/freeform/es/.manifest.json', { 'pages/about/story.md': { hash: computeSourceHash(STORY), recorded: '2025-01-28' } })
    await run()
    // CONTROL — the renderer reads it
    const es = JSON.parse(readFileSync(join(ROOT, 'dist/es/site-content.json'), 'utf8'))
    expect(JSON.stringify(es.pages[0].sections[0].content)).toContain('Nuestra historia')
    expect(orphaned()).toEqual([])
  })

  it('is checked for staleness at the path it has', async () => {
    w('locales/freeform/es/.manifest.json', { 'pages/about/story.md': { hash: 'deadbeef', recorded: '2025-01-28' } })
    await run()
    expect(stale()).toEqual(['es/pages/about/story.md'])
  })

  it('an entry for a section that does not exist is still orphaned, at either path', async () => {
    w('locales/freeform/es/.manifest.json', {
      'pages/about/story.md': { hash: computeSourceHash(STORY), recorded: '2025-01-28' },
      'pages/about/gone.md': { hash: 'aaaaaaaa', recorded: '2025-01-28' },
      'page-ids/ae274cc8/gone.md': { hash: 'aaaaaaaa', recorded: '2025-01-28' },
    })
    await run()
    expect(orphaned().sort()).toEqual(['es/page-ids/ae274cc8/gone.md', 'es/pages/about/gone.md'])
  })
})

describe('every section the renderer translates is one the check knows', () => {
  it('a subsection, the 404 page, and a layout area — by id and by route', async () => {
    w('locales/freeform/es/.manifest.json', {
      'page-ids/ae274cc8/story.md': { hash: computeSourceHash(STORY), recorded: '2025-01-28' },
      'pages/about/detail.md': { hash: computeSourceHash(doc('The detail')), recorded: '2025-01-28' },
      'pages/404/lost.md': { hash: computeSourceHash(doc('Lost')), recorded: '2025-01-28' },
      'pages/layout/header/brand.md': { hash: computeSourceHash(doc('Brand')), recorded: '2025-01-28' },
    })
    await run()
    expect(orphaned()).toEqual([])
  })

  it('a record translation is the record lane\'s, not a page\'s to call orphaned', async () => {
    w('locales/freeform/es/.manifest.json', { 'entities/article/hello.md': { hash: 'aaaaaaaa', recorded: '2025-01-28' } })
    await run()
    expect(orphaned()).toEqual([])
  })
})
