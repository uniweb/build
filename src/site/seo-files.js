/**
 * `sitemap.xml` and `robots.txt` — the two files a crawler reads about a statically served site,
 * written by the prerender from the pages it wrote.
 *
 * ⭐ THE SITEMAP LISTS THE PAGES A STATIC HOST WILL ANSWER WITH, BY THE URLS THEY STATE. An entry is
 * a page the prerender wrote — the static ones and each record's own — at its canonical URL with its
 * alternates, read off `Page#getHeadMeta`, the source its `<head>` was written from, so the sitemap
 * and the page cannot disagree. ⛔ Until 2026-10-25 the plugin wrote it at bundle time, before
 * parametric pages were expanded: it listed `/books/:slug` and no book, at URLs that left the base
 * path out.
 *
 * ⭐ `robots.txt` IS `@uniweb/projections`' (`renderRobotsTxt`), made from the site's content
 * alone, so a host serving the site from its content serves the same file. A site served under a
 * base path — a GitHub project site — gets none, since a crawler reads it only at a host's root, and
 * the build says so.
 */

import { renderRobotsTxt } from '@uniweb/projections'

/**
 * A rendered page's sitemap entry — its canonical URL, with its alternates — or null when it is not
 * one to list: kept out of search (`noindex`), naming another URL as its canonical, or on a site
 * whose address is unknown.
 *
 * @param {Object} page - a Page of the Website the prerender rendered it from
 * @returns {{ loc: string, alternates: Array, lastmod: string|null, changefreq: string|null, priority: (string|number)|null }|null}
 */
export function sitemapEntry(page) {
  const meta = page?.getHeadMeta?.()
  if (!meta?.canonical || meta.robots?.includes('noindex')) return null
  const own = page.website?.getPageUrl?.(page)
  if (!own || meta.canonical !== own) return null
  return {
    loc: own,
    alternates: meta.alternates || [],
    // A record's page has no file of its own, so no date of its own: none is better than its template's.
    lastmod: !page.dynamicContext && page.lastModified ? String(page.lastModified).split('T')[0] : null,
    changefreq: page.seo?.changefreq || null,
    priority: page.seo?.priority ?? null,
  }
}

/** Escape a value for XML text or a double-quoted attribute. */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * `sitemap.xml` for entries (`sitemapEntry`), each with its alternates when the site has several
 * locales.
 *
 * @param {Array} entries
 * @returns {string}
 */
export function renderSitemap(entries) {
  const alternated = entries.some((entry) => entry.alternates?.length)
  const urls = entries.map((entry) => {
    const lines = [`    <loc>${escapeXml(entry.loc)}</loc>`]
    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)
    if (entry.changefreq) lines.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`)
    if (entry.priority !== null && entry.priority !== undefined) lines.push(`    <priority>${escapeXml(entry.priority)}</priority>`)
    for (const { hreflang, url } of entry.alternates || []) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(url)}" />`)
    }
    return `  <url>\n${lines.join('\n')}\n  </url>`
  })
  const xmlns = alternated ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlns}>\n${urls.join('\n')}\n</urlset>\n`
}

/**
 * The site's crawler files, for what this build serves: the sitemap when the site's address is
 * known and it has pages to list, and `robots.txt` (`renderRobotsTxt`), naming that sitemap.
 *
 * @param {Object} options
 * @param {Object} options.content - the site's content: its address (`config.url`), the base it is
 *   built for (`config.base`) and its rules (`config.seo.robots`)
 * @param {Array} options.entries - `sitemapEntry` results
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
