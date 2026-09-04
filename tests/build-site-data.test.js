// Using Jest (built-in globals, no imports needed)
import { buildSiteData } from '../src/site/build-site-data.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// Derived, never re-spelled — the convention is pinned once, in
// `@uniweb/core`'s tests/data-paths.test.js.
import { DATA_DIR } from '@uniweb/core'

// Pins the contract for the link-mode data pipeline:
//   - `dist/site-content.json` always emitted, sections always inlined
//     (never stripped per the split-content rule — that job belongs to
//     the worker, which does its own splitting from the full payload).
//   - `dist/data/<collection>.json` emitted when collections are declared.
//   - HTML, JS, CSS, _importmap/, _pages/, sitemap, robots, search-index
//     are NEVER emitted (those are static-host-bundle concerns).
//
// See `framework/build/src/site/build-site-data.js` for the why.

describe('buildSiteData', () => {
  let siteRoot
  let distDir

  beforeEach(() => {
    siteRoot = join(tmpdir(), `build-site-data-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    distDir = join(siteRoot, 'dist')
    mkdirSync(siteRoot, { recursive: true })

    // Minimal valid site shape — site.yml + a single page.
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\nfoundation: src\nindex: home\n`)
    writeFileSync(join(siteRoot, 'theme.yml'), `vars:\n  primary: '#000000'\n`)

    const pagesDir = join(siteRoot, 'pages', 'home')
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(join(pagesDir, 'page.yml'), `title: Home\n`)
    writeFileSync(join(pagesDir, '1-hero.md'), `---
type: Hero
---

# Welcome

A short tagline.
`)
  })

  afterEach(() => {
    if (existsSync(siteRoot)) {
      rmSync(siteRoot, { recursive: true, force: true })
    }
  })

  it('emits dist/site-content.json with full sections inlined', async () => {
    const { distDir: returnedDist } = await buildSiteData({ siteRoot, distDir })

    expect(returnedDist).toBe(distDir)
    const contentPath = join(distDir, 'site-content.json')
    expect(existsSync(contentPath)).toBe(true)

    const content = JSON.parse(readFileSync(contentPath, 'utf8'))
    expect(content.pages).toBeTruthy()
    expect(content.pages.length).toBeGreaterThan(0)

    // CRITICAL: sections must be inlined. Stripping here would silently
    // break split-mode sites because the worker can't re-derive _pages/
    // files from a payload it doesn't have sections for.
    const homePage = content.pages.find(p => p.route === '/')
    expect(homePage).toBeTruthy()
    expect(homePage.sections).toBeTruthy()
    expect(homePage.sections.length).toBeGreaterThan(0)
  })

  it('ships no build-only fetch key — `merge` is consumed by the build, never read by a runtime', async () => {
    writeFileSync(join(siteRoot, 'pages', 'home', 'page.yml'), `title: Home\nfetch:\n  path: /data/x.json\n  as: x\n  merge: true\n`)
    writeFileSync(join(siteRoot, 'pages', 'home', '2-list.md'), `---\ntype: List\nfetch:\n  path: /data/y.json\n  as: y\n  merge: true\n---\n\nList\n`)
    await buildSiteData({ siteRoot, distDir })
    const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))
    const home = content.pages.find((p) => p.route === '/')
    expect(home.fetch.as).toBe('x')
    expect('merge' in home.fetch).toBe(false)
    const list = home.sections.find((s) => s.fetch)
    expect(list.fetch.as).toBe('y')
    expect('merge' in list.fetch).toBe(false)
    expect(JSON.stringify(content)).not.toContain('"merge"')
  })

  it('does NOT emit static-host-only artifacts', async () => {
    await buildSiteData({ siteRoot, distDir })

    // None of these should be produced by the link-mode pipeline.
    // Bundle mode (vite plugin path) emits some of them; the link-mode
    // function deliberately doesn't.
    expect(existsSync(join(distDir, 'index.html'))).toBe(false)
    expect(existsSync(join(distDir, 'entry.js'))).toBe(false)
    expect(existsSync(join(distDir, '_importmap'))).toBe(false)
    expect(existsSync(join(distDir, 'sitemap.xml'))).toBe(false)
    expect(existsSync(join(distDir, 'robots.txt'))).toBe(false)
    expect(existsSync(join(distDir, 'search-index.json'))).toBe(false)
    // Per-page split files are derived server-side from the full
    // sections we just shipped — link-mode CLI never emits these.
    expect(existsSync(join(distDir, '_pages'))).toBe(false)
  })

  it('emits dist/data/<collection>.json when collections are declared', async () => {
    // Add a tiny file-based collection.
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site
foundation: src
index: home
queries:
  articles:
    schema: '@/article'
`)
    const poolDir = join(siteRoot, 'entities', 'article')
    mkdirSync(poolDir, { recursive: true })
    writeFileSync(join(poolDir, 'first.md'), `---
title: First Article
slug: first
---
Body text.
`)

    await buildSiteData({ siteRoot, distDir })

    const collectionFile = join(distDir, DATA_DIR, 'articles.json')
    expect(existsSync(collectionFile)).toBe(true)
    const articles = JSON.parse(readFileSync(collectionFile, 'utf8'))
    expect(Array.isArray(articles) || typeof articles === 'object').toBe(true)
  })

  it('skips collections when not declared', async () => {
    await buildSiteData({ siteRoot, distDir })
    // No collections declared → no data dir.
    expect(existsSync(join(distDir, DATA_DIR))).toBe(false)
  })

  it('returns the in-memory siteContent for callers that need it', async () => {
    const { siteContent } = await buildSiteData({ siteRoot, distDir })
    expect(siteContent).toBeTruthy()
    expect(siteContent.pages).toBeTruthy()
    // Internal-only properties are stripped before returning (and before
    // serialization); they don't JSON-roundtrip and have no place in the
    // payload the deploy CLI ships.
    expect(siteContent.hasExplicitPoster).toBeUndefined()
    expect(siteContent.hasExplicitPreview).toBeUndefined()
  })

  // ── the icon base is the HOST's slot on this lane ──────────────────────────
  //
  // This payload only goes to a backend, and the icon base is a property of the
  // deployment — one value for every site a backend serves. It is not a site's
  // call, because the base and the icon NAMESPACE are coupled: names minted
  // against one corpus 404 wholesale against another base.
  //
  // The sync lane never had the exposure (`uwx/site.js` allowlists `info.*` and
  // has no `icons` entry). This is the link lane being made to agree.
  describe('config.icons (host-owned on this lane)', () => {
    it('drops an author-set icons block, and keeps the rest of site.yml', async () => {
      writeFileSync(
        join(siteRoot, 'site.yml'),
        `name: test-site\nfoundation: src\nindex: home\ndescription: kept\nicons:\n  cdnUrl: https://authors-choice.test\n`
      )

      await buildSiteData({ siteRoot, distDir })
      const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))

      expect(content.config.icons).toBeUndefined()

      // Controls. Without these the assertion above would pass just as well on
      // an empty config, or on a build that never read site.yml at all.
      expect(content.config.description).toBe('kept')
      expect(content.config.name).toBe('test-site')
    })

    it('leaves the icon MANIFEST alone — different key, different thing', async () => {
      // `content.icons` is the build's manifest of icons used; only
      // `config.icons` is the host-owned address slot.
      writeFileSync(
        join(siteRoot, 'pages', 'home', '1-hero.md'),
        `---\ntype: Hero\n---\n\n![](lu-house)\n\n# Welcome\n`
      )

      await buildSiteData({ siteRoot, distDir })
      const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))

      expect(content.icons?.used).toContain('lu:house')
      expect(content.config.icons).toBeUndefined()
    })

    it('is a no-op when the author set none', async () => {
      await buildSiteData({ siteRoot, distDir })
      const content = JSON.parse(readFileSync(join(distDir, 'site-content.json'), 'utf8'))

      expect(content.config).toBeTruthy()
      expect(content.config.icons).toBeUndefined()
    })
  })

  it('throws when siteRoot is missing', async () => {
    await expect(buildSiteData({ distDir })).rejects.toThrow('siteRoot is required')
  })

  it('throws when distDir is missing', async () => {
    await expect(buildSiteData({ siteRoot })).rejects.toThrow('distDir is required')
  })

  it('creates distDir if it does not exist', async () => {
    const fresh = join(siteRoot, 'fresh-dist')
    expect(existsSync(fresh)).toBe(false)
    await buildSiteData({ siteRoot, distDir: fresh })
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(fresh, 'site-content.json'))).toBe(true)
  })
})
