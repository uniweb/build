/**
 * Free-form Translation Support
 *
 * Enables complete content replacement for locales using markdown files,
 * as an alternative to hash-based string merging. Free-form translations
 * allow translators to completely reword sections rather than translating
 * element-by-element.
 *
 * Directory structure:
 *   locales/freeform/{locale}/
 *     pages/{pageRoute}/{stableId}.md      - By route
 *     page-ids/{pageId}/{stableId}.md      - By page ID (stable)
 *     records/{schema dirs}/{slug}.md      - Records
 *
 * Resolution order for sections:
 *   1. page-ids/{pageId}/{stableId}.md (if page has id:)
 *   2. pages/{pageRoute}/{stableId}.md
 *   3. Return null (fall back to granular translation)
 */

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'
import yaml from 'js-yaml'
import { poolDirsForSchema, schemaForPoolDirs, RECORDS_DIR } from '../site/entity-pool.js'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { computeSourceHash } from './freeform-manifest.js'

// Try to import content-reader for markdown → ProseMirror conversion
let markdownToProseMirror
try {
  const contentReader = await import('@uniweb/content-reader')
  markdownToProseMirror = contentReader.markdownToProseMirror
} catch {
  // Simplified fallback - just wraps content as text
  markdownToProseMirror = (markdown) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: markdown.trim() }]
      }
    ]
  })
}


/**
 * Normalize route for filesystem path
 * Removes leading slash, replaces remaining slashes with path separators
 * @param {string} route - Page route (e.g., '/about/team')
 * @returns {string} Normalized path (e.g., 'about/team')
 */
function normalizeRouteForPath(route) {
  if (route === '/') return ''
  return route.replace(/^\//, '').replace(/\//g, '/')
}

/**
 * Load free-form translation for a section
 *
 * Resolution order:
 *   1. page-ids/{pageId}/{stableId}.md (if page has id:)
 *   2. pages/{pageRoute}/{stableId}.md
 *   3. Return null (fall back to granular)
 *
 * @param {Object} section - Section object with stableId
 * @param {Object} page - Page object with route and optional id
 * @param {string} locale - Locale code (e.g., 'es', 'fr')
 * @param {string} localesDir - Path to locales directory
 * @returns {Promise<Object|null>} Parsed translation { content } or null
 */
export async function loadFreeformTranslation(section, page, locale, localesDir) {
  const freeformDir = join(localesDir, 'freeform', locale)
  if (!existsSync(freeformDir)) return null

  // Try each candidate in order
  for (const filePath of freeformPathsFor(section, page).map((rel) => join(freeformDir, rel))) {
    if (!existsSync(filePath)) continue

    try {
      const content = await readFile(filePath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(content, filePath)

      // Convert markdown body to ProseMirror
      const proseMirrorContent = markdownToProseMirror(body)

      return {
        content: proseMirrorContent,
        frontmatter,
        filePath,
        relativePath: relative(join(localesDir, 'freeform', locale), filePath)
      }
    } catch (err) {
      console.warn(`[i18n] Failed to load free-form translation ${filePath}: ${err.message}`)
      return null
    }
  }

  return null
}

/**
 * Load a free-form translation for one RECORD.
 *
 * Path: records/{schema dirs}/{slug}.md — mirroring the records directory exactly.
 *
 * ⛔ KEYED BY THE RECORD, NOT BY A QUERY. It used to be
 * `collections/{queryName}/{slug}.md`, which was fine only while a
 * collection was also a directory of files. With `records/{schema}/` holding records,
 * TWO queries can cover one schema — so a query-keyed path would make an author
 * write the same translation once per query, and finding neither from the other.
 * ⚠️ And a query is renameable where a record's model is not: keying on the query
 * orphaned every translation the moment someone renamed one.
 *
 * @param {Object} item - entity with a slug
 * @param {string} schema - the entity's model ref (`@/name` or `@org/name`)
 * @param {string} locale - Locale code
 * @param {string} localesDir - Path to locales directory
 * @returns {Promise<Object|null>} Parsed translation { frontmatter, content } or null
 */
export async function loadFreeformRecord(item, schema, locale, localesDir) {
  const slug = item.slug
  if (!slug) return null

  const rel = buildFreeformRecordPath(schema, slug)
  if (!rel) return null

  const freeformDir = join(localesDir, 'freeform', locale)
  if (!existsSync(freeformDir)) return null

  const filePath = join(freeformDir, rel)
  if (!existsSync(filePath)) return null

  try {
    const content = await readFile(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content, filePath)

    // Convert markdown body to ProseMirror (if body exists)
    const proseMirrorContent = body.trim() ? markdownToProseMirror(body) : null

    return {
      frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
      content: proseMirrorContent,
      filePath,
      relativePath: relative(join(localesDir, 'freeform', locale), filePath)
    }
  } catch (err) {
    console.warn(`[i18n] Failed to load free-form record ${filePath}: ${err.message}`)
    return null
  }
}

/**
 * Recursively discover all markdown files in a directory
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @returns {Promise<string[]>} Array of relative paths
 */
async function discoverMarkdownFiles(dir, baseDir) {
  const files = []

  if (!existsSync(dir)) return files

  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      const subFiles = await discoverMarkdownFiles(fullPath, baseDir)
      files.push(...subFiles)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relative(baseDir, fullPath).split(sep).join('/'))
    }
  }

  return files
}

/**
 * Discover all free-form translation files for a locale
 *
 * Used by status commands to show what translations exist, and by the build to
 * register a translation that has no manifest entry yet.
 *
 * ⭐ Each path is relative to the locale's free-form directory — `pages/about/story.md`,
 * `page-ids/<id>/intro.md`, `records/article/hello.md` — the form the manifest keys a
 * translation by and `freeformPathsFor` derives. ⛔ Until 2026-09-14 each was relative
 * to its own subdirectory (`about/story.md`), so none matched a manifest key: the build
 * registered no new file, and a status counted every stale or orphaned file as up to date.
 *
 * @param {string} locale - Locale code
 * @param {string} localesDir - Path to locales directory
 * @returns {Promise<{ pages: string[], pageIds: string[], records: string[] }>}
 */
export async function discoverFreeformTranslations(locale, localesDir) {
  const freeformDir = join(localesDir, 'freeform', locale)

  const result = {
    pages: [],
    pageIds: [],
    records: []
  }

  if (!existsSync(freeformDir)) return result

  // Discover pages translations
  const pagesDir = join(freeformDir, 'pages')
  if (existsSync(pagesDir)) {
    result.pages = (await discoverMarkdownFiles(pagesDir, freeformDir)).sort()
  }

  // Discover page-ids translations
  const pageIdsDir = join(freeformDir, 'page-ids')
  if (existsSync(pageIdsDir)) {
    result.pageIds = (await discoverMarkdownFiles(pageIdsDir, freeformDir)).sort()
  }

  // Discover record translations
  const recordsDir = join(freeformDir, RECORDS_DIR)
  if (existsSync(recordsDir)) {
    result.records = (await discoverMarkdownFiles(recordsDir, freeformDir)).sort()
  }

  return result
}

/**
 * Get metadata for a free-form translation file
 *
 * @param {string} filePath - Full path to translation file
 * @returns {Promise<Object>} { mtime, size }
 */
export async function getFreeformFileMeta(filePath) {
  if (!existsSync(filePath)) return null

  const stats = await stat(filePath)
  return {
    mtime: stats.mtime.toISOString(),
    size: stats.size
  }
}

/**
 * Parse a free-form translation file path to extract metadata
 *
 * @param {string} relativePath - Path relative to locale's freeform dir
 * @returns {Object} { type, pageRoute?, pageId?, schema?, stableId, slug? }
 */
export function parseFreeformPath(relativePath) {
  const parts = relativePath.split('/')

  if (parts[0] === 'pages') {
    // pages/about/hero.md → { type: 'page', pageRoute: '/about', stableId: 'hero' }
    const stableId = parts[parts.length - 1].replace('.md', '')
    const routeParts = parts.slice(1, -1)
    const pageRoute = routeParts.length > 0 ? '/' + routeParts.join('/') : '/'
    return { type: 'page', pageRoute, stableId }
  }

  if (parts[0] === 'page-ids') {
    // page-ids/installation/intro.md → { type: 'pageId', pageId: 'installation', stableId: 'intro' }
    const stableId = parts[parts.length - 1].replace('.md', '')
    const pageId = parts.slice(1, -1).join('/')
    return { type: 'pageId', pageId, stableId }
  }

  if (parts[0] === RECORDS_DIR) {
    // records/std/person/ada.md → { type: 'record', schema: '@std/person', slug: 'ada' }
    // ⛔ This returned `queryName: parts[1]` until 2026-09-21 — the first schema
    // segment (`std` above), and never a query's name. Nothing read it.
    const slug = parts[parts.length - 1].replace('.md', '')
    return { type: 'record', schema: schemaForPoolDirs(parts.slice(1, -1)), slug }
  }

  return { type: 'unknown', relativePath }
}

/**
 * Every path a section's free-form translation is read from, in the order the renderer
 * tries them (`loadFreeformTranslation`): `page-ids/<page id>/<section>.md` when the page
 * has an `id`, then `pages/<route>/<section>.md` (`pages/<section>.md` for the root page).
 *
 * ⭐ ONE LIST, for the loader and for whatever judges a translation file against the
 * site. ⛔ Until 2026-09-14 the orphan and stale check derived the first path alone
 * (`buildFreeformPath`), so on a page with an `id` a route-addressed file the page
 * rendered was reported orphaned and never checked for staleness.
 *
 * @param {Object} section - Section with stableId
 * @param {Object} page - Page with route and optional id
 * @returns {string[]} Paths relative to the locale's free-form directory; none when the
 *   section has no stable id
 */
export function freeformPathsFor(section, page) {
  const stableId = section?.stableId
  if (!stableId) return []
  const paths = []
  if (page?.id) paths.push(`page-ids/${page.id}/${stableId}.md`)
  const routePath = normalizeRouteForPath(page?.route || '/')
  paths.push(routePath ? `pages/${routePath}/${stableId}.md` : `pages/${stableId}.md`)
  return paths
}

/**
 * Every section whose free-form translation the renderer looks up, with the page it
 * looks it up for — the traversal `merge.js::mergeTranslationsAsync` makes: each page's
 * sections, the 404 page's, and each layout area's (whose route it defaults to
 * `/layout/[<name>/]<area>`), subsections included. Keep the two the same.
 *
 * @param {Object} siteContent
 * @returns {Array<{ section: Object, page: Object }>}
 */
function freeformSections(siteContent) {
  const out = []
  const visit = (sections, page) => {
    for (const section of sections || []) {
      out.push({ section, page })
      visit(section.subsections, page)
    }
  }
  for (const page of siteContent?.pages || []) visit(page.sections, page)
  if (siteContent?.notFound) visit(siteContent.notFound.sections, siteContent.notFound)
  for (const [layoutName, areas] of Object.entries(siteContent?.layouts || {})) {
    if (!areas || typeof areas !== 'object') continue
    for (const [areaKey, layoutPage] of Object.entries(areas)) {
      if (!layoutPage?.sections) continue
      const route = layoutPage.route || `/layout/${layoutName === 'default' ? '' : layoutName + '/'}${areaKey}`
      visit(layoutPage.sections, { ...layoutPage, route })
    }
  }
  return out
}

/**
 * What a site's content says about its free-form translations — the ONE index for the
 * build's stale and orphan check and for the CLI's `status --freeform`, `update-hash` and
 * `prune --freeform`, so no two of them can judge a file differently.
 *
 *   - `validPaths` — every path the renderer reads a section's translation from
 *     (`freeformPathsFor`), for every section it translates;
 *   - `sourceHashes` — the hash of the source a translation at each of those paths
 *     translates, which a recorded hash is compared with;
 *   - `canJudge(path)` — whether this content can say a translation at `path` is
 *     orphaned. ⛔ Only a page section's (`pages/…`, `page-ids/…`), and not one for a page
 *     whose sections the content does not carry — a prerendered site with split content
 *     rewrites `site-content.json` without them. A record's (`records/…`) is read from
 *     records this content does not hold. A check that cannot see the source must never
 *     call its translation orphaned: `prune --freeform` deletes what it is told is.
 *
 * @param {Object} siteContent - collected site content, as `dist/site-content.json` holds it
 * @returns {{ validPaths: Set<string>, sourceHashes: Object<string, string>, canJudge: (path: string) => boolean }}
 */
export function freeformSourceIndex(siteContent) {
  const validPaths = new Set()
  const sourceHashes = {}
  for (const { section, page } of freeformSections(siteContent)) {
    for (const path of freeformPathsFor(section, page)) {
      validPaths.add(path)
      if (section.content) sourceHashes[path] = computeSourceHash(section.content)
    }
  }

  // The directories a translation for a page with no `sections` would sit in.
  const unseen = new Set()
  for (const page of siteContent?.pages || []) {
    if (Array.isArray(page?.sections)) continue
    for (const path of freeformPathsFor({ stableId: '_' }, page)) unseen.add(dirname(path))
  }

  const canJudge = (path) =>
    typeof path === 'string' &&
    (path.startsWith('pages/') || path.startsWith('page-ids/')) &&
    !unseen.has(dirname(path))

  return { validPaths, sourceHashes, canJudge }
}

/**
 * Build the expected free-form translation path for a section
 *
 * @param {Object} section - Section with stableId
 * @param {Object} page - Page with route and optional id
 * @param {boolean} preferPageId - Whether to prefer page-ids/ over pages/
 * @returns {string} Relative path (e.g., 'pages/about/hero.md')
 */
export function buildFreeformPath(section, page, preferPageId = true) {
  const stableId = section.stableId
  if (!stableId) return null

  // Prefer page-ids if page has stable id
  if (preferPageId && page.id) {
    return `page-ids/${page.id}/${stableId}.md`
  }

  // Fall back to route-based path
  const routePath = normalizeRouteForPath(page.route)
  if (routePath) {
    return `pages/${routePath}/${stableId}.md`
  }

  // Root page
  return `pages/${stableId}.md`
}

/**
 * The free-form translation path for one entity — the pool's own layout, under
 * `locales/freeform/{locale}/`.
 *
 * ⛔ ONE DERIVATION, shared by the producer (which looks a translation up) and the
 * projector (which writes one). `poolDirsForSchema` is the same inverse the pull
 * side places records with, so a translation cannot land beside a record it is not
 * for.
 *
 * @param {string} schema - the entity's model ref (`@/name` or `@org/name`)
 * @param {string} slug - the entity's slug
 * @returns {string|null} e.g. `records/article/getting-started.md`, or null for a
 *   ref this layout cannot express
 */
export function buildFreeformRecordPath(schema, slug) {
  const dirs = poolDirsForSchema(schema)
  return dirs ? `${RECORDS_DIR}/${dirs.join('/')}/${slug}.md` : null
}
