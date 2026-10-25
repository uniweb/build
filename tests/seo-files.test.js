/**
 * `sitemap.xml` and `robots.txt` for a statically served site (`site/seo-files.js`) — written from
 * the pages the prerender wrote, at the URLs their heads state.
 */
import { Website } from '@uniweb/core'
import { renderRobotsTxt } from '@uniweb/projections'
import { sitemapEntry, renderSitemap, crawlerFiles } from '../src/site/seo-files.js'

const ADDRESS = 'https://octocat.github.io/handbook/'

function site(config = {}, pages = []) {
  return new Website({
    content: {
      config: { name: 'Site', defaultLanguage: 'en', url: ADDRESS, trailingSlash: true, ...config },
      theme: {},
      pages: [
        { route: '/', isIndex: true, title: 'Home', sections: [], lastModified: '2026-10-20T10:00:00.000Z' },
        { route: '/books', title: 'Books', sections: [] },
        ...pages,
      ],
    },
  })
}
const pageOf = (website, route) => website.pages.find((p) => p.route === route)

describe('sitemapEntry', () => {
  test('⭐ a page at the URL its canonical states — with the base path, as a static host answers it', () => {
    const website = site()
    expect(sitemapEntry(pageOf(website, '/books'))).toEqual({
      loc: `${ADDRESS}books/`,
      alternates: [],
      lastmod: null,
      changefreq: null,
      priority: null,
    })
    expect(sitemapEntry(pageOf(website, '/')).loc).toBe(ADDRESS)
    expect(sitemapEntry(pageOf(website, '/')).lastmod).toBe('2026-10-20')
  })

  test('a page out of search, or naming another URL its canonical, is not listed', () => {
    const website = site({}, [
      { route: '/drafts', title: 'Drafts', sections: [], seo: { noindex: true } },
      { route: '/old', title: 'Old', sections: [], seo: { canonical: '/books' } },
    ])
    expect(sitemapEntry(pageOf(website, '/drafts'))).toBeNull()
    expect(sitemapEntry(pageOf(website, '/old'))).toBeNull()
  })

  test('nothing is listed for a site whose address is unknown', () => {
    expect(sitemapEntry(pageOf(site({ url: undefined }), '/books'))).toBeNull()
  })

  test('a page in several locales carries its URL in each', () => {
    const entry = sitemapEntry(pageOf(site({ languages: ['en', 'fr'] }), '/books'))
    expect(entry.alternates).toEqual([
      { hreflang: 'en', url: `${ADDRESS}books/` },
      { hreflang: 'fr', url: `${ADDRESS}fr/books/` },
      { hreflang: 'x-default', url: `${ADDRESS}books/` },
    ])
  })

  test('only what the author set: changefreq and priority', () => {
    const website = site({}, [{ route: '/news', title: 'News', sections: [], seo: { changefreq: 'daily', priority: 0.9 } }])
    expect(sitemapEntry(pageOf(website, '/news'))).toMatchObject({ changefreq: 'daily', priority: 0.9 })
  })
})

describe('renderSitemap', () => {
  test('one url per entry, escaped; the xhtml namespace only when an entry has alternates', () => {
    const xml = renderSitemap([{ loc: 'https://example.com/a?b=1&c=2', alternates: [], lastmod: null }])
    expect(xml).toContain('<loc>https://example.com/a?b=1&amp;c=2</loc>')
    expect(xml).not.toContain('xmlns:xhtml')
    expect(xml).not.toContain('<lastmod>')
    const withAlternates = renderSitemap([
      { loc: 'https://example.com/', alternates: [{ hreflang: 'fr', url: 'https://example.com/fr/' }] },
    ])
    expect(withAlternates).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(withAlternates).toContain('<xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/" />')
  })
})

describe('crawlerFiles', () => {
  const entries = [{ loc: 'https://example.com/', alternates: [] }]
  /** The site's content, as the prerender hands it in: its address, base and rules. */
  const content = (config) => ({ config: { name: 'Site', ...config } })

  test('at a host’s root: a sitemap, and robots.txt naming it absolutely', () => {
    const files = crawlerFiles({ content: content({ url: 'https://example.com/', base: '/', seo: { robots: { disallow: ['/private'] } } }), entries })
    expect(files.sitemap).toContain('<loc>https://example.com/</loc>')
    expect(files.robots).toBe('User-agent: *\nDisallow: /private\n\nSitemap: https://example.com/sitemap.xml\n')
    expect(files.notes).toEqual([])
  })

  test('⭐ under a base path: the sitemap, and no robots.txt — no crawler reads one there', () => {
    const files = crawlerFiles({ content: content({ url: ADDRESS, base: '/handbook/', seo: { robots: { disallow: ['/private'] } } }), entries })
    expect(files.sitemap).not.toBeNull()
    expect(files.robots).toBeNull()
    expect(files.notes.join('\n')).toMatch(/crawlers read it only at a host's root.*Submit https:\/\/octocat\.github\.io\/handbook\/sitemap\.xml/)
  })

  test('with no address: no sitemap, and robots.txt still carries rules a site set', () => {
    const files = crawlerFiles({ content: content({ base: '/', seo: { robots: { disallow: ['/private'] } } }), entries })
    expect(files.sitemap).toBeNull()
    expect(files.robots).toBe('User-agent: *\nDisallow: /private\n')
    expect(files.notes.join('\n')).toMatch(/seo\.origin/)
    expect(crawlerFiles({ content: content({ base: '/' }), entries }).robots).toBeNull()
  })

  test('⭐ robots.txt is the one a host serving the site from its content serves', () => {
    const site = content({ url: 'https://example.com/', seo: { robots: { contentSignals: { 'ai-train': false }, disallow: ['/x'] } } })
    expect(crawlerFiles({ content: site, entries }).robots).toBe(renderRobotsTxt(site, { sitemap: true }))
    expect(crawlerFiles({ content: site, entries: [] }).robots).toBe(renderRobotsTxt(site, { sitemap: false }))
  })
})
