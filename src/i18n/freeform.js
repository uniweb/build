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
 *     collections/{collectionName}/{slug}.md - Collection items
 *
 * Resolution order for sections:
 *   1. page-ids/{pageId}/{stableId}.md (if page has id:)
 *   2. pages/{pageRoute}/{stableId}.md
 *   3. Return null (fall back to granular translation)
 */

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative, dirname } from 'path'
import yaml from 'js-yaml'

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
 * Parse YAML frontmatter from markdown content
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: Object, body: string }}
 */
function parseFrontmatter(content) {
  if (!content.trim().startsWith('---')) {
    return { frontmatter: {}, body: content }
  }

  const parts = content.split('---\n')
  if (parts.length < 3) {
    return { frontmatter: {}, body: content }
  }

  try {
    const frontmatter = yaml.load(parts[1]) || {}
    const body = parts.slice(2).join('---\n')
    return { frontmatter, body }
  } catch {
    return { frontmatter: {}, body: content }
  }
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
  const stableId = section.stableId
  if (!stableId) return null

  const freeformDir = join(localesDir, 'freeform', locale)
  if (!existsSync(freeformDir)) return null

  const candidates = []

  // 1. Try page-ids path (if page has stable id)
  if (page.id) {
    candidates.push(join(freeformDir, 'page-ids', page.id, `${stableId}.md`))
  }

  // 2. Try pages path (by route)
  const routePath = normalizeRouteForPath(page.route)
  if (routePath) {
    candidates.push(join(freeformDir, 'pages', routePath, `${stableId}.md`))
  } else {
    // Root page
    candidates.push(join(freeformDir, 'pages', `${stableId}.md`))
  }

  // Try each candidate in order
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue

    try {
      const content = await readFile(filePath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(content)

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
 * Load free-form translation for a collection item
 *
 * Path: collections/{collectionName}/{slug}.md
 *
 * @param {Object} item - Collection item with slug
 * @param {string} collectionName - Name of the collection
 * @param {string} locale - Locale code
 * @param {string} localesDir - Path to locales directory
 * @returns {Promise<Object|null>} Parsed translation { frontmatter, content } or null
 */
export async function loadFreeformCollectionItem(item, collectionName, locale, localesDir) {
  const slug = item.slug
  if (!slug) return null

  const freeformDir = join(localesDir, 'freeform', locale)
  if (!existsSync(freeformDir)) return null

  const filePath = join(freeformDir, 'collections', collectionName, `${slug}.md`)
  if (!existsSync(filePath)) return null

  try {
    const content = await readFile(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)

    // Convert markdown body to ProseMirror (if body exists)
    const proseMirrorContent = body.trim() ? markdownToProseMirror(body) : null

    return {
      frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
      content: proseMirrorContent,
      filePath,
      relativePath: relative(join(localesDir, 'freeform', locale), filePath)
    }
  } catch (err) {
    console.warn(`[i18n] Failed to load free-form collection item ${filePath}: ${err.message}`)
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
      files.push(relative(baseDir, fullPath))
    }
  }

  return files
}

/**
 * Discover all free-form translation files for a locale
 *
 * Used by status commands to show what translations exist.
 *
 * @param {string} locale - Locale code
 * @param {string} localesDir - Path to locales directory
 * @returns {Promise<Object>} { pages: string[], pageIds: string[], collections: string[] }
 */
export async function discoverFreeformTranslations(locale, localesDir) {
  const freeformDir = join(localesDir, 'freeform', locale)

  const result = {
    pages: [],
    pageIds: [],
    collections: []
  }

  if (!existsSync(freeformDir)) return result

  // Discover pages translations
  const pagesDir = join(freeformDir, 'pages')
  if (existsSync(pagesDir)) {
    result.pages = await discoverMarkdownFiles(pagesDir, pagesDir)
  }

  // Discover page-ids translations
  const pageIdsDir = join(freeformDir, 'page-ids')
  if (existsSync(pageIdsDir)) {
    result.pageIds = await discoverMarkdownFiles(pageIdsDir, pageIdsDir)
  }

  // Discover collection translations
  const collectionsDir = join(freeformDir, 'collections')
  if (existsSync(collectionsDir)) {
    result.collections = await discoverMarkdownFiles(collectionsDir, collectionsDir)
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
 * @returns {Object} { type, pageRoute?, pageId?, collectionName?, stableId, slug? }
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

  if (parts[0] === 'collections') {
    // collections/articles/getting-started.md → { type: 'collection', collectionName: 'articles', slug: 'getting-started' }
    const slug = parts[parts.length - 1].replace('.md', '')
    const collectionName = parts[1]
    return { type: 'collection', collectionName, slug }
  }

  return { type: 'unknown', relativePath }
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
 * Build the expected free-form translation path for a collection item
 *
 * @param {string} collectionName - Name of the collection
 * @param {string} slug - Item slug
 * @returns {string} Relative path (e.g., 'collections/articles/getting-started.md')
 */
export function buildFreeformCollectionPath(collectionName, slug) {
  return `collections/${collectionName}/${slug}.md`
}
