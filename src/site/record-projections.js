/**
 * A STATICALLY BUILT SITE'S RECORD PAGES IN ITS PROJECTIONS — the agent index, each record page's
 * markdown, the search index — made by the rule a host makes them with (`@uniweb/projections`:
 * `recordRoutes`, `generateRecordSearchIndex`, `renderPageMarkdown`), over the files this build
 * compiled. A parametric page is one template in the site's content, and each of its records is a
 * page a visitor opens.
 *
 * ⛔ Until 2026-10-25 the static build made its projections from the site's pages alone: llms.txt
 * and the search index held none of a site's books, talks or posts, while a host's held all of them
 * (measured on a site with 16 record pages: 0 in llms.txt, 0 in the search index).
 *
 * ⭐ In every language, each from its own records: the caller says where a language's compiled files
 * are by how it reads them (`read`) — the default language's under `public/`, another's under
 * `dist/<locale>/` once they are translated, and dev's translated as they are asked for. ⛔ The same
 * day, the static build listed the record pages of its default language only (`./projections.js`).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDefaultLocale } from '@uniweb/core/locale-config'
import { fillRoutePattern, recordHandle } from '@uniweb/core/route-match'
import { recordRoutes, generateRecordSearchIndex, renderPageMarkdown } from '@uniweb/projections'

/**
 * A route as a file is named for it: each segment decoded, since a static host decodes a request's
 * path before it looks for the file (`fillRoutePattern` encodes a record's route for a URL).
 */
export function routeOnDisk(route) {
  return route.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  }).join('/')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * A reader of the compiled data files under `root` — the directory a query's compiled `path`
 * (`/data/talks.json`) is under: `public/` for the default language, `dist/<locale>/` for another.
 *
 * @param {string} root
 * @returns {(path: string) => *} the file's JSON, or null when there is none
 */
export function compiledData(root) {
  return (path) => readJson(join(root, path))
}

/**
 * The record pages of a site: each query whose records have a page of their own, with its search
 * index and each record's page — its route, and its markdown (the parametric page's, then the
 * record).
 *
 * @param {Object} content - one language's site content
 * @param {Object} options
 * @param {(path: string) => *} options.read - a compiled data file's JSON in that language, by its
 *   site path (`/data/talks.json`, a record's own `/data/talks/<$name>.json`), or null — a promise of
 *   one too (`compiledData`)
 * @param {string} [options.locale] - the content's language, `config.activeLocale` by default, else
 *   the site's default
 * @returns {Promise<{ indexes: Object[], entries: Object[], pages: Array<{ route: string, markdown: string }> }>}
 */
export async function recordProjections(
  content,
  { read, locale = content?.config?.activeLocale || resolveDefaultLocale(content?.config || {}) } = {}
) {
  const queries = content?.config?.queries || {}
  const indexes = []
  const pages = []
  for (const { name, pattern, path, field } of recordRoutes(content)) {
    // No compiled file: a query answered by a records service, or an external one — its records
    // are not this build's to list.
    if (!path) continue
    const records = await read(path)
    if (!Array.isArray(records)) continue
    indexes.push(generateRecordSearchIndex(name, { ...(queries[name] || {}), pattern, field }, records, locale))

    const template = (content.pages || []).find((page) => page.route === pattern)
    if (!template) continue
    // A record's own file holds it whole; the list holds its brief.
    const wholeDir = path.replace(/\.json$/, '')
    for (const brief of records) {
      const route = fillRoutePattern(pattern, brief, { field: field ?? null })
      if (!route) continue
      const handle = recordHandle(brief)
      const record = (handle && (await read(`${wholeDir}/${handle}.json`))) || brief
      const markdown = renderPageMarkdown(template, { record })
      if (markdown) pages.push({ route, markdown })
    }
  }
  return { indexes, entries: indexes.flatMap((index) => index.entries), pages }
}
