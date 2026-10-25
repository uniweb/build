/**
 * `sitemap.xml` and `robots.txt` for a statically served site (`site/seo-files.js`) — made by
 * `@uniweb/projections` from the site's content, for the pages the prerender wrote. The whole lane,
 * prerender included: `prerender-sitemap.test.js`.
 */
import { renderRobotsTxt, sitemapEntries } from '@uniweb/projections'
import { sitemapEntriesOf, crawlerFiles } from '../src/site/seo-files.js'

const ADDRESS = 'https://octocat.github.io/handbook/'

describe('sitemapEntriesOf', () => {
  const content = () => ({
    config: { name: 'Site', defaultLanguage: 'en', url: ADDRESS, trailingSlash: true },
    pages: [
      { route: '/', isIndex: true, title: 'Home', sections: [{}] },
      { route: '/books', title: 'Books', sections: [{}] },
      { route: '/books/:slug', isDynamic: true, title: 'Book', sections: [{}] },
    ],
  })
  const records = [{ route: '/books/dune', dynamicContext: { templateRoute: '/books/:slug' } }]

  test('⭐ projections’ entries for the language, its record pages after its own', () => {
    const written = new Set(['/', '/books', '/books/dune'])
    expect(sitemapEntriesOf(content(), { locale: 'en', records, written })).toEqual(
      sitemapEntries(content(), { locale: 'en', records: [{ type: 'record', route: '/books/dune' }] })
    )
    expect(sitemapEntriesOf(content(), { locale: 'en', records, written }).map((entry) => entry.loc)).toEqual([
      ADDRESS,
      `${ADDRESS}books/`,
      `${ADDRESS}books/dune/`,
    ])
  })

  test('⭐ less any page the build wrote no file for — a static host answers it with its not-found page', () => {
    const written = new Set(['/', '/books/dune'])
    expect(sitemapEntriesOf(content(), { locale: 'en', records, written }).map((entry) => entry.route)).toEqual(['/', '/books/dune'])
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
