/**
 * `sitemap.xml` and `robots.txt` — the two files a crawler reads about a statically served site,
 * written by the prerender once it has written the pages.
 *
 * ⭐ BOTH ARE `@uniweb/projections`', made from the site's content alone (`sitemapEntries`,
 * `renderSitemap`, `renderRobotsTxt`), so a host serving the site from its content serves the same
 * files. A page's entry is the canonical and the alternates its `<head>` states, by the rules
 * `Page#getHeadMeta` states them with (guarded by projections' `tests/sitemap-heads.test.js`).
 * ⛔ Until 2026-10-25 the build read each entry off the rendered page instead, and until earlier
 * that day the plugin wrote the sitemap at bundle time, before parametric pages were expanded: it
 * listed `/books/:slug` and no book, at URLs that left the base path out.
 *
 * ⭐ THE SITEMAP LISTS THE PAGES A STATIC HOST WILL ANSWER WITH: the pages this build wrote, each
 * record's own among them. A page it wrote no file for — one whose render failed — is answered with
 * the not-found page, so it is left out, where a host that renders on request lists it.
 *
 * ⭐ A site served under a base path — a GitHub project site — gets no `robots.txt`, since a crawler
 * reads it only at a host's root, and the build says so.
 */

import { renderRobotsTxt, renderSitemap, sitemapEntries } from '@uniweb/projections'

/**
 * One language's sitemap entries, for the pages this build wrote: `sitemapEntries` for its content
 * and its record pages, less any page the build wrote no file for.
 *
 * @param {Object} content - the language's content, as authored: each parametric page its template
 * @param {Object} options
 * @param {string} options.locale - the language
 * @param {Object[]} [options.records] - its record pages, as expanded (`expandDynamicPages`)
 * @param {Set<string>} options.written - the route of each page written, as its head states it
 *   (`Page#getNavRoute`)
 * @returns {Array} `sitemapEntries` results
 */
export function sitemapEntriesOf(content, { locale, records = [], written }) {
  const entries = sitemapEntries(content, { locale, records: records.map((page) => ({ type: 'record', route: page.route })) })
  return entries.filter((entry) => written.has(entry.route))
}

/**
 * The site's crawler files, for what this build serves: the sitemap when the site's address is
 * known and it has pages to list, and `robots.txt` (`renderRobotsTxt`), naming that sitemap.
 *
 * @param {Object} options
 * @param {Object} options.content - the site's content: its address (`config.url`), the base it is
 *   built for (`config.base`) and its rules (`config.seo.robots`)
 * @param {Array} options.entries - every language's entries (`sitemapEntriesOf`)
 * @returns {{ sitemap: string|null, robots: string|null, notes: string[] }} what to write, and why
 *   anything was not
 */
export function crawlerFiles({ content, entries = [] }) {
  const config = content?.config || {}
  const address = config.url || null
  const notes = []
  let sitemap = null
  if (!address) {
    notes.push('No sitemap.xml: the site has no address to list its pages at — set `seo.origin` in site.yml, or let its deploy target state one.')
  } else if (!entries.length) {
    notes.push('No sitemap.xml: no page was written to list.')
  } else {
    sitemap = renderSitemap(entries)
  }
  const robots = renderRobotsTxt(content, { sitemap: Boolean(sitemap) })
  const base = config.base || '/'
  if (base !== '/') {
    const sitemapUrl = sitemap ? new URL('sitemap.xml', address).href : null
    notes.push(
      `No robots.txt: crawlers read it only at a host's root, and this site is served under ${base}.` +
        (sitemapUrl ? ` Submit ${sitemapUrl} to search engines directly.` : '')
    )
  }
  return { sitemap, robots, notes }
}
