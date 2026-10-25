/**
 * `seo:` is resolved from `site.yml`, and a static build states where the site lives from it
 * (`site/site-address.js`).
 *
 * ⛔ **The generators were never the broken part, which is why nothing caught the first bug here.**
 * The sitemap, robots and index generators had passing unit tests while the wiring that fed them read
 * a source no site ever wrote to (until 2026-09-17). ⇒ These assert the RESOLUTION: given what a site
 * authors and what its deploy target says, what does the build decide?
 *
 * The rules: `site.yml::seo` is the SOURCE, and a caller's `seo` option an OVERRIDE, merged key by key.
 * The site's address is an origin — the deploy target's, else the author's `seo.origin` — under the
 * base the site is built for. ⛔ Until 2026-10-25 the author wrote `seo.baseUrl`, which the docs called
 * an origin while the sitemap and the page tags read it as the whole address.
 */

import {
  effectiveSeo,
  readOrigin,
  resolveSiteAddress,
  refuseUnreadableAddress,
  ORIGIN_ENV,
} from '../src/site/site-address.js'

describe('effectiveSeo', () => {
  test("site.yml's block is the source; an override wins key by key and leaves the rest", () => {
    expect(effectiveSeo({ origin: 'https://docs.example.com', image: '/og.png' }, { origin: 'https://staging.example.com' }))
      .toEqual({ origin: 'https://staging.example.com', image: '/og.png' })
    expect(effectiveSeo(undefined)).toEqual({})
  })

  test('⛔ a retired key is refused wherever it came from — saying what replaced it', () => {
    expect(() => effectiveSeo({ baseUrl: 'https://example.com' })).toThrow(/`seo.baseUrl` is now `seo.origin`/)
    expect(() => effectiveSeo({}, { baseUrl: 'https://example.com' })).toThrow(/`seo.origin`/)
    expect(() => effectiveSeo({ defaultImage: '/og.png' })).toThrow(/`seo.image`/)
    expect(() => effectiveSeo({ locales: [{ code: 'en' }] })).toThrow(/follows the site's `languages:`/)
  })
})

describe('readOrigin', () => {
  test('a scheme and a host, normalized', () => {
    expect(readOrigin('https://octocat.github.io', 'seo.origin')).toBe('https://octocat.github.io')
    expect(readOrigin('https://example.com/', 'seo.origin')).toBe('https://example.com')
    expect(readOrigin('http://localhost:4000', 'seo.origin')).toBe('http://localhost:4000')
    expect(readOrigin(undefined, 'seo.origin')).toBeNull()
  })

  test('⭐ a path is refused — it is the base’s to state, and would be stated twice', () => {
    expect(() => readOrigin('https://octocat.github.io/handbook', 'seo.origin'))
      .toThrow(/an origin is a scheme and a host: https:\/\/octocat\.github\.io\. The path \/handbook\/ is the site's base/)
  })

  test('what is not an origin is refused by name', () => {
    expect(() => readOrigin('example.com', 'UNIWEB_ORIGIN')).toThrow(/UNIWEB_ORIGIN is "example.com", which is not an origin/)
    expect(() => readOrigin('ftp://example.com', 'seo.origin')).toThrow(/not an origin/)
    expect(() => readOrigin('https://example.com?x=1', 'seo.origin')).toThrow(/a scheme and a host/)
  })
})

describe('resolveSiteAddress', () => {
  test('the author’s origin, under the base the site is built for', () => {
    const config = { seo: { origin: 'https://octocat.github.io' } }
    expect(resolveSiteAddress({ config, base: '/handbook/', env: {} })).toBe('https://octocat.github.io/handbook/')
    expect(resolveSiteAddress({ config, base: '/', env: {} })).toBe('https://octocat.github.io/')
  })

  test('⭐ the deploy target’s origin wins over the author’s, as its base does', () => {
    const config = { seo: { origin: 'https://acme.com' } }
    const env = { [ORIGIN_ENV]: 'https://octocat.github.io' }
    expect(resolveSiteAddress({ config, base: '/handbook/', env })).toBe('https://octocat.github.io/handbook/')
  })

  test('a host building the site states its production origin — over the author’s, under UNIWEB_ORIGIN', () => {
    const config = { seo: { origin: 'https://old.example.com' } }
    const netlify = { NETLIFY: 'true', URL: 'https://www.example.com' }
    expect(resolveSiteAddress({ config, env: netlify })).toBe('https://www.example.com/')
    expect(resolveSiteAddress({ config, env: { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'example.com' } })).toBe('https://example.com/')
    expect(resolveSiteAddress({ config, env: { ...netlify, [ORIGIN_ENV]: 'https://named.example.com' } })).toBe('https://named.example.com/')
    // Cloudflare Pages states a deploy's own URL only: the author's origin stands.
    expect(resolveSiteAddress({ config, env: { CF_PAGES: '1', CF_PAGES_URL: 'https://abc.site.pages.dev' } })).toBe('https://old.example.com/')
  })

  test('no origin anywhere is no address — the OFF state the sitemap and the canonicals gate on', () => {
    expect(resolveSiteAddress({ config: {}, base: '/handbook/', env: {} })).toBeNull()
    expect(resolveSiteAddress({ env: {} })).toBeNull()
  })

  test('a deploy target’s origin that is not one stops the build, by name', () => {
    expect(() => resolveSiteAddress({ config: {}, env: { [ORIGIN_ENV]: 'octocat.github.io' } }))
      .toThrow(/UNIWEB_ORIGIN/)
  })
})

describe('refuseUnreadableAddress', () => {
  test('⛔ site.yml does not state an address or a URL form — whoever serves the site does', () => {
    expect(() => refuseUnreadableAddress({ url: 'https://example.com' })).toThrow(/`url:` in site.yml is not read/)
    expect(() => refuseUnreadableAddress({ trailingSlash: true })).toThrow(/`trailingSlash:` in site.yml is not read/)
  })

  test('a retired or malformed seo key stops it, naming the file', () => {
    expect(() => refuseUnreadableAddress({ seo: { baseUrl: 'https://example.com' } }, 'site.yml'))
      .toThrow(/\[uniweb\] site\.yml: `seo\.baseUrl` is now `seo\.origin`/)
    expect(() => refuseUnreadableAddress({ seo: { origin: 'https://example.com/docs' } })).toThrow(/a scheme and a host/)
    expect(() => refuseUnreadableAddress({ seo: { origin: 'https://example.com' }, name: 'x' })).not.toThrow()
  })
})

/**
 * End-to-end on the LINK lane, which has a harness the bundle lane does not.
 *
 * ⚖️ The link lane builds a site's content for a host that serves it — and that host states its own
 * address — so its agent index stays root-relative whatever `seo.origin` says: a static host's
 * origin there would send an agent to another copy of the site. It does NOT run Vite, so the bundle
 * lane's stamped `config.url` is asserted at the unit level above and on a built site elsewhere.
 */

import { buildSiteData } from '../src/site/build-site-data.js'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('site.yml::seo on the link lane', () => {
  let siteRoot
  let distDir

  const scaffold = (siteYmlTail) => {
    siteRoot = join(tmpdir(), `seo-site-yml-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    distDir = join(siteRoot, 'dist')
    mkdirSync(join(siteRoot, 'pages', 'about'), { recursive: true })
    writeFileSync(join(siteRoot, 'site.yml'), `name: docs-site\nfoundation: src\nindex: about\n${siteYmlTail}`)
    writeFileSync(join(siteRoot, 'pages', 'about', 'index.md'), '---\ntype: Section\n---\n\n# About\n\nSome prose.\n')
  }

  afterEach(() => {
    if (siteRoot && existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  test('the agent index links root-relative — the host that serves the site states its address', async () => {
    scaffold('seo:\n  origin: https://docs.example.com\n')
    await buildSiteData({ siteRoot, distDir })
    const index = readFileSync(join(distDir, 'llms.txt'), 'utf8')
    expect(index).not.toContain('https://docs.example.com')
    // `index: about` makes it the home page, whose projection is /index.md.
    expect(index).toContain('](/index.md)')
  })

  test('⛔ a retired seo.baseUrl stops the build, saying what replaced it', async () => {
    scaffold('seo:\n  baseUrl: https://docs.example.com\n')
    await expect(buildSiteData({ siteRoot, distDir })).rejects.toThrow(/`seo.baseUrl` is now `seo.origin`/)
  })
})
