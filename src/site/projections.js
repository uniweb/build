/**
 * A LANGUAGE'S PROJECTIONS — the files a static host serves about a site in one of its languages:
 * its search index, its agent index (`llms.txt`, and a branch's), and each of its pages as markdown,
 * a record's page included. Made from that language's content and its records alone; the
 * generators are `@uniweb/projections`', and this decides which of them a site gets and where each
 * file goes.
 *
 * ⭐ ONE RULE, EVERY WRITER. The bundle build emits the default language's through Rollup
 * (`./plugin.js`), the localized build writes each other language's once its records are translated
 * (`i18n/index.js::buildLocalizedSite`), and the dev server answers a request with the file named
 * for it here — so what a developer sees is what ships, in every language. ⛔ Until 2026-10-25 four
 * writers made these files, and they disagreed: another language's search index was made from its
 * pages alone, before its records were translated, and it got no `llms.txt` or `.md`; dev made every
 * language's search index from the default language's content. Measured on a starter in three
 * languages with three record pages: 20 search entries in English, 17 in French and Spanish, and no
 * `fr/llms.txt`.
 *
 * ⭐ A LANGUAGE'S FILES ARE AT ITS ADDRESSES: under its prefix, at its translated routes
 * (`applyRouteTranslation`) — `fr/actualites/x.md` for `/blog/x` — where its `llms.txt` links them
 * (`renderSiteIndex`). A static host decodes a request's path before it looks for the file, so a
 * record's file is named for its decoded route (`routeOnDisk`).
 *
 * @module
 */

import { resolveDefaultLocale } from '@uniweb/core'
import {
  renderSiteIndex,
  renderPageMarkdown,
  resolveAgentsConfig,
  selectIndexablePages,
  selectIndexBranches,
  pageMarkdownFilename,
  branchIndexFilename,
  applyRouteTranslation,
  generateSearchIndex,
  getSearchIndexFilename,
  mergeSearchIndexes,
  INDEX_FILENAME
} from '@uniweb/projections'
import { routeOnDisk } from './record-projections.js'
import { searchDeclaredOn } from './search-declared.js'

/**
 * The language `content` is in — its `config.activeLocale`, else the site's default — the prefix
 * its files go under, and the route a visitor reaches a page at in it.
 */
function languageOf(content) {
  const config = content?.config || {}
  const defaultLocale = resolveDefaultLocale(config)
  const locale = config.activeLocale || defaultLocale
  const other = Boolean(locale && defaultLocale && locale !== defaultLocale)
  const routeTranslations = config.i18n?.routeTranslations
  return {
    locale,
    defaultLocale,
    prefix: other ? `${locale}/` : '',
    at: other ? (route) => applyRouteTranslation(route, locale, routeTranslations) : (route) => route
  }
}

/**
 * The language's search index, when the site has search (`services.search`, `./search-declared.js`):
 * its pages, then its records' pages.
 *
 * @param {Object} content - one language's site content
 * @param {Object} [records] - its record pages (`recordProjections`)
 * @returns {Array<{ kind: 'search', fileName: string, source: string, count: number }>}
 */
export function searchFiles(content, records) {
  if (!searchDeclaredOn(content)) return []
  const { locale, defaultLocale } = languageOf(content)
  const index = mergeSearchIndexes(
    generateSearchIndex(content, { locale, search: content.config?.search || {} }),
    records?.indexes
  )
  return [
    {
      kind: 'search',
      fileName: getSearchIndexFilename(locale, defaultLocale),
      source: JSON.stringify(index, null, 2),
      count: index.count
    }
  ]
}

/**
 * The language's agent projections, unless the site turns them off (`agents:`): `llms.txt` — and a
 * branch's, where `branchIndexes` asks for them — and each page it lists, as markdown.
 *
 * Unlike the sitemap, written when the site's address is unknown too: the links are root-relative
 * then, and `uniweb doctor` warns. An agent that arrived through the index can follow a relative
 * link, and a silently absent index is the failure the whole feature exists to prevent.
 *
 * @param {Object} content - one language's site content
 * @param {Object} [records] - its record pages (`recordProjections`), listed and written as pages
 * @returns {Array<{ kind: 'index'|'branch'|'markdown', fileName: string, source: string }>}
 */
export function agentFiles(content, records) {
  const agents = resolveAgentsConfig(content?.config)
  if (!agents.index && !agents.markdown) return []
  if (!content?.pages?.length) return []

  const { locale, prefix, at } = languageOf(content)
  // The address, the base path and the languages are the content's own (`config.url`,
  // `config.base`, `config.languages`), which `renderSiteIndex` reads.
  const options = { locale, exclude: agents.exclude, records: records?.entries }
  const files = []

  if (agents.index) {
    files.push({ kind: 'index', fileName: `${prefix}${INDEX_FILENAME}`, source: renderSiteIndex(content, options) })

    // Branch indexes are ADDITIVE — the root index above still lists every page, because the
    // two-hop criterion depends on it. These are a scoped entry point for an agent already inside
    // a branch, at the branch's own address.
    if (agents.branchIndexes) {
      const branches = selectIndexBranches(content.pages, { exclude: agents.exclude, minPages: agents.branchMinPages })
      for (const branch of branches) {
        files.push({
          kind: 'branch',
          fileName: `${prefix}${branchIndexFilename(at(branch.route))}`,
          source: renderSiteIndex(content, { ...options, branch: branch.route }),
          route: branch.route,
          count: branch.count
        })
      }
    }
  }

  if (agents.markdown) {
    for (const page of selectIndexablePages(content.pages, { exclude: agents.exclude })) {
      const markdown = renderPageMarkdown(page)
      if (markdown) files.push({ kind: 'markdown', fileName: `${prefix}${pageMarkdownFilename(at(page.route))}`, source: markdown })
    }
    // Each record's page, held to the exclusions a page is held to — the site's pages among them,
    // so a record under a branch `llms.txt` leaves out gets no file, as it gets no line there.
    const listed = indexableRecordRoutes(content.pages, records?.pages, agents.exclude)
    for (const { route, markdown } of records?.pages || []) {
      if (!listed.has(route)) continue
      files.push({ kind: 'markdown', fileName: `${prefix}${pageMarkdownFilename(routeOnDisk(at(route)))}`, source: markdown })
    }
  }

  return files
}

/**
 * Every projection of one language of a site: its search index, then its agent projections.
 *
 * @param {Object} content - one language's site content
 * @param {Object} [records] - its record pages (`recordProjections`)
 */
export function projectionFiles(content, records) {
  return [...searchFiles(content, records), ...agentFiles(content, records)]
}

/**
 * What a build says it wrote — one line per kind of file.
 *
 * @param {Array<{ kind: string, fileName: string }>} files - `projectionFiles`
 * @returns {string[]}
 */
export function describeProjections(files) {
  const lines = []
  for (const file of files) {
    if (file.kind === 'search') lines.push(`Generated ${file.fileName} (${file.count} entries)`)
    if (file.kind === 'index') lines.push(`Generated ${file.fileName}`)
  }
  const branches = files.filter((file) => file.kind === 'branch')
  if (branches.length) {
    lines.push(`Generated ${branches.length} branch index(es): ${branches.map((b) => `${b.route} (${b.count})`).join(', ')}`)
  }
  const markdown = files.filter((file) => file.kind === 'markdown').length
  if (markdown) lines.push(`Generated ${markdown} page markdown projections`)
  return lines
}

/** The routes of the record pages `llms.txt` lists, judged among the site's own pages. */
function indexableRecordRoutes(pages = [], recordPages = [], exclude) {
  if (!recordPages?.length) return new Set()
  const routes = new Set(recordPages.map((page) => page.route))
  const candidates = [...pages, ...recordPages.map(({ route }) => ({ route }))]
  return new Set(
    selectIndexablePages(candidates, { exclude })
      .map((page) => page.route)
      .filter((route) => routes.has(route))
  )
}
