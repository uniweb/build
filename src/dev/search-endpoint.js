/** Where `uniweb dev` answers a site's search when it is the site's host. */
export const DEV_SEARCH_ADDRESS = '/_search'

/**
 * `uniweb dev`'s search service — offered when the dev server is a site's host (a `$devBackend`
 * with a `records` address, `./records-mount.js`). A host that publishes a services block answers
 * for every service, and one it doesn't name is off, so the dev server names search too and answers
 * it from the same index a static build makes: `GET /_search?q=&lang=&limit=` → `{ results, total }`,
 * each result shaped by `@uniweb/projections`' `searchResult`, as the local index provider shapes
 * its own. A site whose search is off, or that names its own address, gets neither.
 *
 * ⛔ Registered SYNCHRONOUSLY, like `mountDevApi`.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {(lang: string|null) => Promise<{ entries?: object[] }|null>} options.readIndex - the
 *   site's search index in a language, as the dev server makes it
 * @returns {string} the address
 */
export function mountDevSearch(server, { readIndex }) {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://dev.local')
    if (!url.pathname.endsWith(DEV_SEARCH_ADDRESS)) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const q = url.searchParams.get('q') || ''
    const lang = url.searchParams.get('lang') || null
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 10))

    let answer = { results: [], total: 0 }
    try {
      const index = await readIndex(lang)
      const entries = Array.isArray(index?.entries) ? index.entries : []
      if (q.trim() && entries.length) {
        const engine = await import('@uniweb/projections/search/engine')
        const ranked = engine.rankSearchEntries(engine.buildSearchStructure(entries), q, entries)
        const hits = ranked.hits.map((h) => entries[h.doc])
        answer = { results: hits.slice(0, limit).map((item) => engine.searchResult(item, { terms: ranked.terms })), total: hits.length }
      }
    } catch (err) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: `search failed: ${err?.message || err}` }))
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(answer))
  })
  return DEV_SEARCH_ADDRESS
}
