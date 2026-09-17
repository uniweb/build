/**
 * `seo:` on the bundle lane is resolved from `site.yml`.
 *
 * ⛔ **The generators were never the broken part, which is why nothing caught
 * this.** `generateSitemap`, `generateRobotsTxt` and `renderSiteIndex` all had
 * passing unit tests (`robots-content-signals.test.js` calls the generator
 * directly) while the wiring that feeds them read a source no site ever wrote
 * to — the tests supplied the input the plugin never delivered, so a green
 * suite proved nothing about the path a real build takes.
 *
 * ⇒ These assert the RESOLUTION, which is the part that was missing: given a
 * collected site whose `config.seo` carries the authored block, what does the
 * plugin decide the effective `seo` is?
 *
 * The rule: `site.yml::seo` is the SOURCE; a caller's `seo` option is an
 * OVERRIDE, merged key by key. A site's `vite.config.js` is CLI scaffolding —
 * strip it and the site is unchanged — so what a site GETS must not depend on
 * what it passes there.
 */

import { resolveEffectiveSeo } from '../src/site/plugin.js'

const siteWith = seo => ({ config: { seo } })

describe('resolveEffectiveSeo', () => {
  test("site.yml's baseUrl is what a build reads — the regression this file exists for", () => {
    const seo = resolveEffectiveSeo(siteWith({ baseUrl: 'https://docs.example.com' }))
    expect(seo.baseUrl).toBe('https://docs.example.com')
  })

  test('a trailing slash is stripped, wherever the value came from', () => {
    expect(resolveEffectiveSeo(siteWith({ baseUrl: 'https://docs.example.com/' })).baseUrl)
      .toBe('https://docs.example.com')
    expect(resolveEffectiveSeo(null, { baseUrl: 'https://staging.example.com/' }).baseUrl)
      .toBe('https://staging.example.com')
  })

  test('site.yml::seo.robots reaches robots.txt — contentSignals included', () => {
    const seo = resolveEffectiveSeo(
      siteWith({
        baseUrl: 'https://docs.example.com',
        robots: { disallow: ['/private'], contentSignals: { 'ai-train': false } }
      })
    )
    expect(seo.robots.disallow).toEqual(['/private'])
    expect(seo.robots.contentSignals).toEqual({ 'ai-train': false })
  })

  test('an explicit override wins, key by key, and leaves the rest of the site block', () => {
    const seo = resolveEffectiveSeo(
      siteWith({ baseUrl: 'https://docs.example.com', defaultImage: '/og.png' }),
      { baseUrl: 'https://staging.example.com' }
    )
    expect(seo.baseUrl).toBe('https://staging.example.com')
    expect(seo.defaultImage).toBe('/og.png')
  })

  test('no baseUrl anywhere is the OFF state — the emitters gate on exactly this', () => {
    expect(resolveEffectiveSeo(siteWith({ defaultImage: '/og.png' })).baseUrl).toBe('')
    expect(resolveEffectiveSeo(null).baseUrl).toBe('')
    expect(resolveEffectiveSeo(undefined, {}).baseUrl).toBe('')
  })

  test('a site with no seo block at all resolves to inert defaults, not undefined', () => {
    const seo = resolveEffectiveSeo({ config: {} })
    expect(seo).toEqual({
      baseUrl: '',
      defaultImage: null,
      twitterHandle: null,
      locales: [],
      robots: {}
    })
  })
})

/**
 * End-to-end on the LINK lane, which has a harness the bundle lane does not.
 *
 * ⚖️ **What this does and does not cover.** It proves `site.yml::seo.baseUrl`
 * reaches a real emitted artifact through a real build, and it pins the SOURCE
 * the two lanes now share (`content.config.seo`). It does NOT run Vite, so it
 * cannot assert `dist/sitemap.xml` or `dist/robots.txt` — those are bundle-lane
 * artifacts and their gate is asserted at the unit level above. Saying so here
 * rather than letting a green file imply more than it measured.
 */

import { buildSiteData } from '../src/site/build-site-data.js'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('site.yml::seo.baseUrl reaches an emitted artifact', () => {
  let siteRoot
  let distDir

  const scaffold = seoBlock => {
    siteRoot = join(tmpdir(), `seo-site-yml-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    distDir = join(siteRoot, 'dist')
    mkdirSync(join(siteRoot, 'pages', 'about'), { recursive: true })
    writeFileSync(
      join(siteRoot, 'site.yml'),
      `name: docs-site\nfoundation: src\nindex: about\n${seoBlock}`
    )
    writeFileSync(
      join(siteRoot, 'pages', 'about', 'index.md'),
      '---\ntype: Section\n---\n\n# About\n\nSome prose.\n'
    )
  }

  afterEach(() => {
    if (siteRoot && existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  test('links in llms.txt are absolute — no vite.config.js involved', async () => {
    scaffold('seo:\n  baseUrl: https://docs.example.com\n')
    await buildSiteData({ siteRoot, distDir })

    const index = readFileSync(join(distDir, 'llms.txt'), 'utf8')
    expect(index).toContain('https://docs.example.com')
    expect(index).not.toMatch(/\]\(\/about/)
  })

  test('without it they stay root-relative — the documented fallback, not a failure', async () => {
    scaffold('')
    await buildSiteData({ siteRoot, distDir })

    const index = readFileSync(join(distDir, 'llms.txt'), 'utf8')
    expect(index).not.toContain('https://docs.example.com')
  })
})
