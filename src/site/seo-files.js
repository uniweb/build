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
 * ⭐ `robots.txt` IS READ ONLY AT A HOST'S ROOT. A site served under a base path — a GitHub project
 * site — cannot have one; it is not written there, and the build says so, rather than shipping a file
 * no crawler reads that points at a sitemap where none is.
 */

/** The three defined Content Signals, in the order they are emitted. */
const CONTENT_SIGNAL_KEYS = ['search', 'ai-input', 'ai-train']

/**
 * Format the `Content-Signal:` directive from `seo.robots.contentSignals`.
 *
 * Content Signals express what a site permits its content to be *used for*,
 * which is a different axis from `Disallow:` — that governs fetching, this
 * governs use after fetching. The three defined signals:
 *
 * - `search`    — appear in search results
 * - `ai-input`  — be retrieved at inference time (RAG, grounding)
 * - `ai-train`  — be used to train a model
 *
 * **Emitted only when declared.** There is no default: a preference the site
 * owner did not state is not ours to assert, in either direction. An absent
 * signal means "unstated", which is not the same as `no`.
 *
 * Unknown keys are ignored rather than passed through — the vocabulary is a
 * closed set, and forwarding an invented signal would produce a directive no
 * crawler honors while reading as though it were doing something.
 *
 * @param {Object|null} signals - e.g. `{ search: true, 'ai-input': true, 'ai-train': false }`
 * @returns {string} The directive line, or `''` when nothing is declared
 */
export function formatContentSignals(signals) {
  if (!signals || typeof signals !== 'object') return ''

  const parts = []
  for (const key of CONTENT_SIGNAL_KEYS) {
    if (!(key in signals)) continue
    const value = signals[key]
    const yes = value === true || value === 'yes'
    const no = value === false || value === 'no'
    if (!yes && !no) continue
    parts.push(`${key}=${yes ? 'yes' : 'no'}`)
  }

  return parts.length ? `Content-Signal: ${parts.join(', ')}` : ''
}

/**
 * `robots.txt` — the site's rules, and where its sitemap is.
 *
 * @param {Object} [robots] - `seo.robots`: `allow`, `disallow`, `crawlDelay`, `additionalSitemaps`,
 *   `contentSignals`
 * @param {Object} [options]
 * @param {string|null} [options.sitemap] - the sitemap's absolute URL, when there is one
 * @returns {string}
 */
export function generateRobotsTxt(robots = {}, { sitemap = null } = {}) {
  const { disallow = [], allow = [], crawlDelay = null, additionalSitemaps = [], contentSignals = null } = robots || {}

  let content = 'User-agent: *\n'

  const signals = formatContentSignals(contentSignals)
  if (signals) {
    // Inside the User-agent group, before the rules — the directive applies to
    // the group it sits in.
    content += `${signals}\n`
  }
  for (const path of allow) content += `Allow: ${path}\n`
  for (const path of disallow) content += `Disallow: ${path}\n`
  if (crawlDelay) content += `Crawl-delay: ${crawlDelay}\n`

  const sitemaps = [sitemap, ...additionalSitemaps].filter(Boolean)
  if (sitemaps.length) content += `\n${sitemaps.map((url) => `Sitemap: ${url}`).join('\n')}\n`
  return content
}

/** Whether `seo.robots` says anything a crawler would act on. */
function hasRules(robots) {
  if (!robots || typeof robots !== 'object') return false
  return Boolean(
    robots.allow?.length ||
      robots.disallow?.length ||
      robots.crawlDelay ||
      robots.additionalSitemaps?.length ||
      formatContentSignals(robots.contentSignals)
  )
}

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
 * known and it has pages to list, `robots.txt` when the site is at its host's root and has rules or a
 * sitemap to name.
 *
 * @param {Object} options
 * @param {string|null} options.address - the site's address (`config.url`)
 * @param {string} [options.base] - the base the site is built for
 * @param {Array} options.entries - `sitemapEntry` results
 * @param {Object} [options.robots] - `seo.robots`
 * @returns {{ sitemap: string|null, robots: string|null, notes: string[] }} what to write, and why
 *   anything was not
 */
export function crawlerFiles({ address, base = '/', entries = [], robots = {} }) {
  const notes = []
  let sitemap = null
  if (!address) {
    notes.push('No sitemap.xml: the site has no address to list its pages at — set `seo.origin` in site.yml, or let its deploy target state one.')
  } else if (!entries.length) {
    notes.push('No sitemap.xml: no page was written to list.')
  } else {
    sitemap = renderSitemap(entries)
  }
  const atRoot = !base || base === '/'
  const sitemapUrl = sitemap ? new URL('sitemap.xml', address).href : null
  let robotsTxt = null
  if (atRoot) {
    if (sitemapUrl || hasRules(robots)) robotsTxt = generateRobotsTxt(robots, { sitemap: sitemapUrl })
  } else {
    notes.push(
      `No robots.txt: crawlers read it only at a host's root, and this site is served under ${base}.` +
        (sitemapUrl ? ` Submit ${sitemapUrl} to search engines directly.` : '')
    )
  }
  return { sitemap, robots: robotsTxt, notes }
}
