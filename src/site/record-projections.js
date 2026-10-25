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
 * ⚠️ For the default language only. Another language's search index is still made from its pages
 * alone, before its records are translated (`i18n/index.js::buildLocalizedContent`), and the build
 * writes that language no llms.txt or `.md` (measured 2026-10-25 on a site in three languages).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * The record pages of a site: each query whose records have a page of their own, with its search
 * index and each record's page — its route, and its markdown (the parametric page's, then the
 * record).
 *
 * @param {Object} content - one locale's site content
 * @param {Object} options
 * @param {string} options.dataRoot - the directory a query's compiled `path` (`/data/talks.json`) is under
 * @param {string} [options.locale]
 * @returns {{ indexes: Object[], entries: Object[], pages: Array<{ route: string, markdown: string }> }}
 */
export function recordProjections(content, { dataRoot, locale } = {}) {
  const queries = content?.config?.queries || {}
  const indexes = []
  const pages = []
  for (const { name, pattern, path, field } of recordRoutes(content)) {
    // No compiled file: a query answered by a records service, or an external one — its records
    // are not this build's to list.
    if (!path) continue
    const records = readJson(join(dataRoot, path))
    if (!Array.isArray(records)) continue
    indexes.push(generateRecordSearchIndex(name, { ...(queries[name] || {}), pattern, field }, records, locale))

    const template = (content.pages || []).find((page) => page.route === pattern)
    if (!template) continue
    // A record's own file holds it whole; the list holds its brief.
    const wholeDir = join(dataRoot, path.replace(/\.json$/, ''))
    for (const brief of records) {
      const route = fillRoutePattern(pattern, brief, { field: field ?? null })
      if (!route) continue
      const handle = recordHandle(brief)
      const record = (handle && readJson(join(wholeDir, `${handle}.json`))) || brief
      const markdown = renderPageMarkdown(template, { record })
      if (markdown) pages.push({ route, markdown })
    }
  }
  return { indexes, entries: indexes.flatMap((index) => index.entries), pages }
}
