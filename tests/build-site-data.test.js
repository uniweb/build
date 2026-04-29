// Using Jest (built-in globals, no imports needed)
import { buildSiteData } from '../src/site/build-site-data.js'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
collections:
  articles:
    path: collections/articles
`)
    const collectionDir = join(siteRoot, 'collections', 'articles')
    mkdirSync(collectionDir, { recursive: true })
    writeFileSync(join(collectionDir, 'first.md'), `---
title: First Article
slug: first
---
Body text.
`)

    await buildSiteData({ siteRoot, distDir })

    const collectionFile = join(distDir, 'data', 'articles.json')
    expect(existsSync(collectionFile)).toBe(true)
    const articles = JSON.parse(readFileSync(collectionFile, 'utf8'))
    expect(Array.isArray(articles) || typeof articles === 'object').toBe(true)
  })

  it('skips collections when not declared', async () => {
    await buildSiteData({ siteRoot, distDir })
    // No collections declared → no data dir.
    expect(existsSync(join(distDir, 'data'))).toBe(false)
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
