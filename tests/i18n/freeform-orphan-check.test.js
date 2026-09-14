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
import { buildLocalizedContent, computeSourceHash, discoverFreeformTranslations, freeformSourceIndex } from '../../src/i18n/index.js'

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

let logs
const run = async () => {
  warnings = []
  logs = []
  await buildLocalizedContent(ROOT, { locales: ['es'], generateSearchIndexes: false })
  return warnings
}
const manifestOf = () => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'locales/freeform/es/.manifest.json'), 'utf8'))
  } catch {
    return null
  }
}
const orphaned = () => warnings.filter((m) => m.includes('orphaned')).map((m) => m.replace(/^.*orphaned: /, ''))
const stale = () => warnings.filter((m) => m.includes('stale')).map((m) => m.replace(/^.*stale: /, '').replace(/ \(.*$/, ''))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'freeform-orphans-'))
  saved = [console.warn, console.log]
  console.warn = (m) => warnings.push(String(m))
  console.log = (m) => logs?.push(String(m))
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

// ⛔ A NEW FREE-FORM FILE WAS NEVER REGISTERED. The build registers a translation it finds
// with no manifest entry, recording the hash of the source it translates, so a later
// source change reads as stale. It compared the manifest's keys (`pages/about/story.md`)
// against discovered paths with no `pages/` or `page-ids/` prefix (`about/story.md`), so
// nothing ever matched: no file was registered, and no edit to a source ever showed.
describe('a new free-form file is registered by the build', () => {
  it('discovery names each file by the path the manifest keys it by', async () => {
    w('locales/freeform/es/page-ids/ae274cc8/intro.md', 'Intro\n')
    w('locales/freeform/es/entities/article/hello.md', 'Hola\n')
    const found = await discoverFreeformTranslations('es', join(ROOT, 'locales'))
    expect(found).toEqual({
      pages: ['pages/about/story.md'],
      pageIds: ['page-ids/ae274cc8/intro.md'],
      records: ['entities/article/hello.md'],
    })
  })

  it('records the source hash of a file it has no entry for — once', async () => {
    expect(manifestOf()).toBeNull()
    await run()
    expect(manifestOf()).toEqual({ 'pages/about/story.md': { hash: computeSourceHash(STORY), recorded: expect.any(String) } })
    expect(logs.filter((m) => m.includes('registered'))).toEqual(['[i18n] Free-form translation registered: es/pages/about/story.md (new file)'])

    await run()
    expect(logs.filter((m) => m.includes('registered'))).toEqual([])
  })

  it('and a source changed after registration then reads as stale', async () => {
    await run()
    const edited = siteContent()
    edited.pages[0].sections[0].content = doc('Our story, revised')
    w('dist/site-content.json', edited)
    await run()
    expect(stale()).toEqual(['es/pages/about/story.md'])
  })

  it('a file that translates no section is not registered', async () => {
    w('locales/freeform/es/pages/about/nowhere.md', 'Nada\n')
    await run()
    expect(Object.keys(manifestOf())).toEqual(['pages/about/story.md'])
  })
})

// ⭐ One index of what a site's content says about its free-form translations, for the
// build's check and for the CLI's `status --freeform`, `update-hash` and `prune --freeform`.
describe('freeformSourceIndex', () => {
  it('holds every path the renderer reads, with the source hash a translation there is checked against', () => {
    const { validPaths, sourceHashes } = freeformSourceIndex(siteContent())
    expect([...validPaths].sort()).toEqual([
      'page-ids/ae274cc8/detail.md', 'page-ids/ae274cc8/story.md',
      'pages/404/lost.md', 'pages/about/detail.md', 'pages/about/story.md', 'pages/layout/header/brand.md',
    ])
    expect(sourceHashes['pages/about/story.md']).toBe(computeSourceHash(STORY))
    expect(sourceHashes['page-ids/ae274cc8/story.md']).toBe(computeSourceHash(STORY))
  })

  it('cannot judge a record translation, nor one for a page whose sections the content does not carry', () => {
    // A prerendered site with split content rewrites `site-content.json` without page sections.
    const split = siteContent()
    split.pages.push({ route: '/team', id: 'b1b2', title: 'Team' })
    const { canJudge } = freeformSourceIndex(split)
    expect(canJudge('entities/article/hello.md')).toBe(false)
    expect(canJudge('pages/team/intro.md')).toBe(false)
    expect(canJudge('page-ids/b1b2/intro.md')).toBe(false)
    // CONTROL — a page whose sections it does carry, and a subpage of the unseen one
    expect(canJudge('pages/about/gone.md')).toBe(true)
    expect(canJudge('pages/team/members/intro.md')).toBe(true)
  })
})
