/**
 * Collection Processor
 *
 * Processes content collections from markdown files into JSON data.
 * Collections are defined in site.yml and processed at build time.
 *
 * Features:
 * - Discovers markdown files in collection folders
 * - Parses frontmatter for metadata
 * - Converts markdown body to ProseMirror JSON
 * - Supports filtering, sorting, and limiting
 * - Auto-generates excerpts and extracts first images
 *
 * @module @uniweb/build/site/collection-processor
 *
 * @example
 * // site.yml
 * collections:
 *   articles:
 *     path: library/articles
 *     sort: date desc
 *
 * // Usage
 * const collections = await processCollections(siteDir, config.collections)
 * await writeCollectionFiles(siteDir, collections)
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { applyFilter, applySort } from './data-fetcher.js'

// Try to import content-reader for markdown parsing
let markdownToProseMirror
try {
  const contentReader = await import('@uniweb/content-reader')
  markdownToProseMirror = contentReader.markdownToProseMirror
} catch {
  // Simplified fallback
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
 * Parse collection config from site.yml
 *
 * @param {string} name - Collection name
 * @param {string|Object} config - Simple path string or full config object
 * @returns {Object} Normalized config
 *
 * @example
 * // Simple form
 * parseCollectionConfig('articles', 'library/articles')
 *
 * // Extended form
 * parseCollectionConfig('articles', {
 *   path: 'library/articles',
 *   route: '/blog',
 *   sort: 'date desc',
 *   filter: 'published != false',
 *   limit: 100
 * })
 */
function parseCollectionConfig(name, config) {
  if (typeof config === 'string') {
    return {
      name,
      path: config,
      route: null,
      sort: null,
      filter: null,
      limit: 0,
      excerpt: { maxLength: 160 }
    }
  }

  return {
    name,
    path: config.path,
    route: config.route || null,
    sort: config.sort || null,
    filter: config.filter || null,
    limit: config.limit || 0,
    excerpt: {
      maxLength: config.excerpt?.maxLength || 160,
      field: config.excerpt?.field || null
    }
  }
}

/**
 * Parse YAML frontmatter from markdown content
 *
 * @param {string} raw - Raw file content
 * @returns {{ frontmatter: Object, body: string }}
 */
function parseFrontmatter(raw) {
  if (!raw.trim().startsWith('---')) {
    return { frontmatter: {}, body: raw }
  }

  const parts = raw.split('---\n')
  if (parts.length < 3) {
    return { frontmatter: {}, body: raw }
  }

  try {
    const frontmatter = yaml.load(parts[1]) || {}
    const body = parts.slice(2).join('---\n')
    return { frontmatter, body }
  } catch (err) {
    console.warn('[collection-processor] YAML parse error:', err.message)
    return { frontmatter: {}, body: raw }
  }
}

/**
 * Extract plain text from ProseMirror content
 *
 * @param {Object} node - ProseMirror node
 * @returns {string} Plain text
 */
function extractPlainText(node) {
  if (!node) return ''

  if (node.type === 'text') {
    return node.text || ''
  }

  if (Array.isArray(node.content)) {
    return node.content.map(extractPlainText).join('')
  }

  return ''
}

/**
 * Extract excerpt from content
 *
 * @param {Object} frontmatter - Parsed frontmatter
 * @param {Object} content - ProseMirror content
 * @param {Object} excerptConfig - Excerpt configuration
 * @returns {string} Excerpt text
 */
function extractExcerpt(frontmatter, content, excerptConfig) {
  const { maxLength = 160, field = null } = excerptConfig || {}

  // Check for explicit excerpt in frontmatter
  if (frontmatter.excerpt) {
    return frontmatter.excerpt.slice(0, maxLength)
  }

  // Check for alternative field (e.g., 'description')
  if (field && frontmatter[field]) {
    return frontmatter[field].slice(0, maxLength)
  }

  // Auto-extract from content
  const text = extractPlainText(content)
  if (!text) return ''

  // Clean and truncate
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned

  // Truncate at word boundary
  const truncated = cleaned.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > maxLength * 0.7
    ? truncated.slice(0, lastSpace) + '...'
    : truncated + '...'
}

/**
 * Extract first image from ProseMirror content
 *
 * @param {Object} node - ProseMirror node
 * @returns {string|null} Image URL or null
 */
function extractFirstImage(node) {
  if (!node) return null

  if (node.type === 'image' && node.attrs?.src) {
    return node.attrs.src
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const img = extractFirstImage(child)
      if (img) return img
    }
  }

  return null
}

// Filter and sort utilities are imported from data-fetcher.js

/**
 * Process a single content item from a markdown file
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - Markdown filename
 * @param {Object} config - Collection configuration
 * @returns {Promise<Object|null>} Processed item or null if unpublished
 */
async function processContentItem(dir, filename, config) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const slug = basename(filename, extname(filename))

  // Parse frontmatter and body
  const { frontmatter, body } = parseFrontmatter(raw)

  // Skip unpublished items by default
  if (frontmatter.published === false) {
    return null
  }

  // Parse markdown body to ProseMirror
  const content = markdownToProseMirror(body)

  // Extract excerpt
  const excerpt = extractExcerpt(frontmatter, content, config.excerpt)

  // Extract first image (frontmatter takes precedence)
  const image = frontmatter.image || extractFirstImage(content)

  // Get file stats for lastModified
  const fileStat = await stat(filepath)

  return {
    slug,
    ...frontmatter,
    excerpt,
    image,
    // Include both raw markdown body (for simple rendering)
    // and ProseMirror content (for rich rendering)
    body: body.trim(),
    content,
    lastModified: fileStat.mtime.toISOString()
  }
}

/**
 * Collect and process all items in a collection folder
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} config - Parsed collection config
 * @returns {Promise<Array>} Array of processed items
 */
async function collectItems(siteDir, config) {
  const collectionDir = join(siteDir, config.path)

  // Check if collection directory exists
  if (!existsSync(collectionDir)) {
    console.warn(`[collection-processor] Collection folder not found: ${config.path}`)
    return []
  }

  const files = await readdir(collectionDir)
  const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('_'))

  // Process all markdown files
  let items = await Promise.all(
    mdFiles.map(file => processContentItem(collectionDir, file, config))
  )

  // Filter out nulls (unpublished items)
  items = items.filter(Boolean)

  // Add routes to items if collection has a route configured
  if (config.route) {
    const baseRoute = config.route.replace(/\/$/, '') // Remove trailing slash
    items = items.map(item => ({
      ...item,
      route: `${baseRoute}/${item.slug}`
    }))
  }

  // Apply custom filter
  if (config.filter) {
    items = applyFilter(items, config.filter)
  }

  // Apply sort
  if (config.sort) {
    items = applySort(items, config.sort)
  }

  // Apply limit
  if (config.limit > 0) {
    items = items.slice(0, config.limit)
  }

  return items
}

/**
 * Process all content collections defined in site.yml
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} collectionsConfig - Collections config from site.yml
 * @returns {Promise<Object>} Map of collection name to items array
 *
 * @example
 * const collections = await processCollections('/path/to/site', {
 *   articles: { path: 'library/articles', sort: 'date desc' },
 *   products: 'library/products'
 * })
 * // { articles: [...], products: [...] }
 */
export async function processCollections(siteDir, collectionsConfig) {
  if (!collectionsConfig || typeof collectionsConfig !== 'object') {
    return {}
  }

  const results = {}

  for (const [name, config] of Object.entries(collectionsConfig)) {
    const parsed = parseCollectionConfig(name, config)
    const items = await collectItems(siteDir, parsed)
    results[name] = items
    console.log(`[collection-processor] Processed ${name}: ${items.length} items`)
  }

  return results
}

/**
 * Write collection data to JSON files in public/data/
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} collections - Map of collection name to items array
 * @returns {Promise<void>}
 *
 * @example
 * await writeCollectionFiles('/path/to/site', {
 *   articles: [{ slug: 'hello', title: 'Hello World', ... }]
 * })
 * // Creates public/data/articles.json
 */
export async function writeCollectionFiles(siteDir, collections) {
  if (!collections || Object.keys(collections).length === 0) {
    return
  }

  const dataDir = join(siteDir, 'public', 'data')
  await mkdir(dataDir, { recursive: true })

  for (const [name, items] of Object.entries(collections)) {
    const filepath = join(dataDir, `${name}.json`)
    await writeFile(filepath, JSON.stringify(items, null, 2))
    console.log(`[collection-processor] Generated ${filepath} (${items.length} items)`)
  }
}

/**
 * Get last modified time for a collection
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} config - Collection config
 * @returns {Promise<Date|null>} Most recent modification time
 */
export async function getCollectionLastModified(siteDir, config) {
  const parsed = parseCollectionConfig('temp', config)
  const collectionDir = join(siteDir, parsed.path)

  if (!existsSync(collectionDir)) {
    return null
  }

  const files = await readdir(collectionDir)
  const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('_'))

  let lastModified = null

  for (const file of mdFiles) {
    const fileStat = await stat(join(collectionDir, file))
    if (!lastModified || fileStat.mtime > lastModified) {
      lastModified = fileStat.mtime
    }
  }

  return lastModified
}
