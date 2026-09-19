/**
 * The site's TOP LEVEL is ordered by two configs: the site config (`site.yml`) and
 * the pages directory's own (`pages/folder.yml` or `pages/page.yml`) — the second
 * read as a mounted directory's is, under the first. See `rootOrderConfig`.
 *
 * ⛔ Until 2026-09-19 the pages directory's config was read for its MODE alone. So a
 * content repository that orders itself — the framework's own public docs do, in a
 * root `folder.yml` — kept its order when mounted below the root and lost it as the
 * whole pages directory: alphabetical, and in folder mode with no homepage.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent, rootOrderConfig } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'root-order-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const put = (base, files) => {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(base, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
}
const site = (extra = '') => `name: t\nfoundation: "@acme/base@1.0.0"\n${extra}`
// A page-mode page directory: `page.yml` plus one section.
const page = (dir, name = dir) => ({ [`${dir}/page.yml`]: `title: ${name}\n`, [`${dir}/body.md`]: `# ${name}\n` })

const collect = (dir) => collectSiteContent(dir, {})
const routes = (content) => content.pages.map((p) => p.route)
// The top level as the build ordered it, by folder name — a promoted homepage sits
// at `/` and keeps its folder route as `sourcePath`.
const topNames = (content) =>
  content.pages.filter((p) => !p.parent).map((p) => (p.sourcePath || p.route).slice(1))
const homeName = (content) => {
  const home = content.pages.find((p) => p.route === '/')
  return home ? (home.sourcePath || '/').slice(1) : null
}

describe('rootOrderConfig — the precedence, as a rule', () => {
  it('the site config\'s `pages:` decides both the order and the homepage', () => {
    expect(rootOrderConfig({ pages: ['a', 'b'] }, { pages: ['b', 'a'], index: 'b' }))
      .toEqual({ pages: ['a', 'b'], index: 'a', homepage: 'a' })
  })

  it('⛔ a site `index:` beats the pages directory\'s `pages:` — the homepage is decided per config, not per key', () => {
    // Merged key by key, `pages[0]` would win and the site's own choice would lose.
    expect(rootOrderConfig({ index: 'b' }, { pages: ['a', 'b'] }))
      .toEqual({ pages: ['a', 'b'], index: 'b', homepage: 'b' })
  })

  it('the pages directory\'s config decides whatever the site config leaves unsaid', () => {
    expect(rootOrderConfig({}, { pages: ['b', 'a'] })).toEqual({ pages: ['b', 'a'], index: 'b', homepage: 'b' })
    expect(rootOrderConfig({}, { index: 'a' })).toEqual({ pages: undefined, index: 'a', homepage: 'a' })
    // A site order that names no homepage leaves the homepage to the pages directory.
    expect(rootOrderConfig({ pages: ['...', 'legal'] }, { index: 'a' }))
      .toEqual({ pages: ['...', 'legal'], index: 'a', homepage: 'a' })
  })

  it('CONTROL — within ONE file the first `pages:` entry still beats `index:`, as it always has', () => {
    expect(rootOrderConfig({ pages: ['a', 'b'], index: 'b' }, {}).homepage).toBe('a')
  })

  it('declares nothing when neither does', () => {
    expect(rootOrderConfig({}, {})).toEqual({ pages: undefined, index: undefined, homepage: undefined })
  })
})

describe('the build reads the pages directory\'s own `pages:` and `index:`', () => {
  it('folder mode at the root: `pages/folder.yml` orders the top level and names the homepage', async () => {
    put(ROOT, {
      'site.yml': site(),
      'pages/folder.yml': 'pages: [guide, intro]\n',
      'pages/intro.md': '# Intro\n',
      'pages/guide.md': '# Guide\n',
    })
    const content = await collect(ROOT)
    // Before: ['/guide', '/intro'] — alphabetical, and no `/` at all.
    expect(routes(content)).toEqual(['/', '/intro'])
    expect(content.pages[0].title).toBe('Guide')
  })

  it('`index:` alone names the homepage', async () => {
    put(ROOT, {
      'site.yml': site(),
      'pages/folder.yml': 'index: intro\n',
      'pages/intro.md': '# Intro\n',
      'pages/guide.md': '# Guide\n',
    })
    expect(homeName(await collect(ROOT))).toBe('intro')
  })

  it('page mode at the root: `pages/page.yml` does the same', async () => {
    put(ROOT, { 'site.yml': site(), 'pages/page.yml': 'pages: [zeta, alpha]\n', ...page('pages/zeta'), ...page('pages/alpha') })
    const content = await collect(ROOT)
    // Before: `alpha`, the alphabetical fallback, was the homepage.
    expect(topNames(content)).toEqual(['zeta', 'alpha'])
    expect(homeName(content)).toBe('zeta')
  })

  it('the site config wins: its `pages:` over theirs, its `index:` over their first entry', async () => {
    put(ROOT, { 'pages/page.yml': 'pages: [zeta, alpha]\n', ...page('pages/zeta'), ...page('pages/alpha'), ...page('pages/mid') })

    put(ROOT, { 'site.yml': site('pages: [alpha, mid, zeta]\n') })
    let content = await collect(ROOT)
    expect(topNames(content)).toEqual(['alpha', 'mid', 'zeta'])
    expect(homeName(content)).toBe('alpha')

    put(ROOT, { 'site.yml': site('index: alpha\n') })
    content = await collect(ROOT)
    expect(topNames(content)).toEqual(['zeta', 'alpha', 'mid'])
    expect(homeName(content)).toBe('alpha')
  })

  it('⭐ a content directory keeps its order whether it is mounted below the root or IS the pages directory', async () => {
    // The shape of a docs repository: its own root `folder.yml` orders its sections.
    put(join(ROOT, 'content'), { 'folder.yml': 'title: Docs\npages: [start, api, ...]\n', ...page('api'), ...page('start'), ...page('zoo') })

    put(join(ROOT, 'mounted'), { 'site.yml': site('index: home\npaths:\n  pages/docs: ../content\n'), ...page('pages/home') })
    const mounted = await collect(join(ROOT, 'mounted'))
    const underDocs = mounted.pages.filter((p) => p.parent === '/docs').map((p) => p.route.slice('/docs/'.length))

    put(join(ROOT, 'whole'), { 'site.yml': site('paths:\n  pages: ../content\n') })
    const whole = await collect(join(ROOT, 'whole'))

    expect(underDocs).toEqual(['start', 'api', 'zoo'])
    expect(topNames(whole)).toEqual(['start', 'api', 'zoo'])
    expect(homeName(whole)).toBe('start')
  })

  it('⚖️ `layout:` in the pages directory\'s config is NOT read — the site\'s layout is `site.yml`\'s alone', async () => {
    // Deliberate: a site's layout travels on the sync lane as `site.yml`'s own value,
    // verbatim, so a second source would render on a static build and nowhere else.
    put(ROOT, { 'site.yml': site(), 'pages/page.yml': 'layout: DocsLayout\npages: [zeta]\n', ...page('pages/zeta') })
    expect((await collect(ROOT)).pages[0].layout.name).toBeUndefined()

    // CONTROL — the site's own `layout:` still reaches every page.
    put(ROOT, { 'site.yml': site('layout: Main\n') })
    expect((await collect(ROOT)).pages[0].layout.name).toBe('Main')
  })
})

describe('the push orders the top level and names the homepage as the build does', () => {
  const fixtures = {
    'the pages directory\'s `pages:`': { 'site.yml': site(), 'pages/page.yml': 'pages: [zeta, alpha]\n' },
    'a site `index:` over their `pages:`': { 'site.yml': site('index: alpha\n'), 'pages/page.yml': 'pages: [zeta, alpha]\n' },
    'the site\'s `pages:` over theirs': { 'site.yml': site('pages: [alpha, zeta]\n'), 'pages/page.yml': 'pages: [zeta, alpha]\n' },
    // ⛔ The push read `index:` alone until 2026-09-19: a homepage named by the first
    // `pages:` entry — which the build promotes — reached the backend as no homepage.
    'a site homepage named by its first `pages:` entry': { 'site.yml': site('pages: [zeta, alpha]\n') },
  }

  for (const [name, files] of Object.entries(fixtures)) {
    it(name, async () => {
      put(ROOT, { ...files, ...page('pages/zeta'), ...page('pages/alpha') })
      const content = await collect(ROOT)
      const doc = await siteProjectToDocument(ROOT)
      const slug = (record) => Object.values(record.slug)[0]

      expect(doc.pages.map(slug)).toEqual(topNames(content))
      expect(doc.pages.filter((p) => p.is_index).map(slug)).toEqual([homeName(content)])
    })
  }
})
