/**
 * Content Collector
 *
 * Collects site content from a pages/ directory structure:
 * - site.yml: Site configuration
 * - pages/: Directory of page folders
 *   - page.yml: Page metadata
 *   - *.md: Section content with YAML frontmatter
 *
 * Section frontmatter reserved properties:
 * - type: Component type (e.g., "Hero", "Features")
 * - preset: Preset configuration name
 * - input: Input field mapping
 * - props: Additional component props (merged with other params)
 * - fetch: Data fetching configuration (path, url, schema, prerender, merge, transform)
 *
 * Note: `component` is supported as an alias for `type` (deprecated)
 *
 * Uses @uniweb/content-reader for markdown → ProseMirror conversion
 * when available, otherwise uses a simplified parser.
 *
 * @module @uniweb/build/site
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { collectSectionAssets, mergeAssetCollections } from './assets.js'
import { parseFetchConfig, singularize } from './data-fetcher.js'

// Try to import content-reader, fall back to simplified parser
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
 * Check if a folder name represents a dynamic route (e.g., [slug], [id])
 * @param {string} folderName - The folder name to check
 * @returns {boolean}
 */
function isDynamicRoute(folderName) {
  return /^\[(\w+)\]$/.test(folderName)
}

/**
 * Extract the parameter name from a dynamic route folder (e.g., [slug] → slug)
 * @param {string} folderName - The folder name (e.g., "[slug]")
 * @returns {string|null} The parameter name or null if not a dynamic route
 */
function extractRouteParam(folderName) {
  const match = folderName.match(/^\[(\w+)\]$/)
  return match ? match[1] : null
}

/**
 * Parse YAML string using js-yaml
 */
function parseYaml(yamlString) {
  try {
    return yaml.load(yamlString) || {}
  } catch (err) {
    console.warn('[content-collector] YAML parse error:', err.message)
    return {}
  }
}

/**
 * Read and parse a YAML file
 */
async function readYamlFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8')
    return parseYaml(content)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Check if a file is a markdown file
 */
function isMarkdownFile(filename) {
  return filename.endsWith('.md') && !filename.startsWith('_')
}

/**
 * Parse numeric prefix from filename (e.g., "1-hero.md" → { prefix: "1", name: "hero" })
 * Supports:
 *   - Simple: "1", "2", "3"
 *   - Decimal ordering: "1.5" (between 1 and 2), "2.5" (between 2 and 3)
 *   - Hierarchy via comma: "1,1" (child of 1), "1,2" (second child of 1)
 *   - Mixed: "1.5,1" (child of section 1.5)
 */
function parseNumericPrefix(filename) {
  const match = filename.match(/^(\d+(?:[.,]\d+)*)-?(.*)$/)
  if (match) {
    return { prefix: match[1], name: match[2] || match[1] }
  }
  return { prefix: null, name: filename }
}

/**
 * Compare filenames for sorting by numeric prefix.
 * Both . and , are treated as separators for sorting purposes.
 * This ensures correct ordering: 1, 1,1, 1.5, 2, 2,1, etc.
 */
function compareFilenames(a, b) {
  const { prefix: prefixA } = parseNumericPrefix(parse(a).name)
  const { prefix: prefixB } = parseNumericPrefix(parse(b).name)

  if (!prefixA && !prefixB) return a.localeCompare(b)
  if (!prefixA) return 1
  if (!prefixB) return -1

  const partsA = prefixA.split(/[.,]/).map(Number)
  const partsB = prefixB.split(/[.,]/).map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA !== numB) return numA - numB
  }

  return 0
}

/**
 * Process a markdown file into a section
 *
 * @param {string} filePath - Path to markdown file
 * @param {string} id - Section ID
 * @param {string} siteRoot - Site root directory for asset resolution
 * @returns {Object} Section data with assets manifest
 */
async function processMarkdownFile(filePath, id, siteRoot) {
  const content = await readFile(filePath, 'utf8')
  let frontMatter = {}
  let markdown = content

  // Extract frontmatter
  if (content.trim().startsWith('---')) {
    const parts = content.split('---\n')
    if (parts.length >= 3) {
      frontMatter = parseYaml(parts[1])
      markdown = parts.slice(2).join('---\n')
    }
  }

  const { type, component, preset, input, props, fetch, ...params } = frontMatter

  // Convert markdown to ProseMirror
  const proseMirrorContent = markdownToProseMirror(markdown)

  const section = {
    id,
    component: type || component || 'Section',
    preset,
    input,
    params: { ...params, ...props },
    content: proseMirrorContent,
    fetch: parseFetchConfig(fetch),
    subsections: []
  }

  // Collect assets referenced in this section
  const assetCollection = collectSectionAssets(section, filePath, siteRoot)

  return { section, assetCollection }
}

/**
 * Build section hierarchy from flat list.
 * Hierarchy is determined by comma separators:
 *   - "1", "1.5", "2" → all top-level (dots are for ordering)
 *   - "1,1", "1,2" → children of section "1"
 *   - "1.5,1" → child of section "1.5"
 */
function buildSectionHierarchy(sections) {
  const sectionMap = new Map()
  const topLevel = []

  // First pass: create map
  for (const section of sections) {
    sectionMap.set(section.id, section)
  }

  // Second pass: build hierarchy (comma = hierarchy)
  for (const section of sections) {
    if (!section.id.includes(',')) {
      topLevel.push(section)
      continue
    }

    const parts = section.id.split(',')
    const parentId = parts.slice(0, -1).join(',')
    const parent = sectionMap.get(parentId)

    if (parent) {
      parent.subsections.push(section)
    } else {
      // Orphan subsection - add to top level
      topLevel.push(section)
    }
  }

  return topLevel
}

/**
 * Process explicit sections array from page.yml
 * Supports nested structure for subsections:
 *   sections:
 *     - hero
 *     - features:
 *         - logocloud
 *         - stats
 *     - pricing
 *
 * @param {Array} sectionsConfig - Sections array from page.yml
 * @param {string} pagePath - Path to page directory
 * @param {string} siteRoot - Site root for asset resolution
 * @param {string} parentId - Parent section ID for building hierarchy
 * @returns {Object} { sections, assetCollection, lastModified }
 */
async function processExplicitSections(sectionsConfig, pagePath, siteRoot, parentId = '') {
  const sections = []
  let assetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let lastModified = null

  let index = 1
  for (const item of sectionsConfig) {
    let sectionName
    let subsections = null

    if (typeof item === 'string') {
      // Simple section: "hero"
      sectionName = item
    } else if (typeof item === 'object' && item !== null) {
      // Section with subsections: { features: [logocloud, stats] }
      const keys = Object.keys(item)
      if (keys.length === 1) {
        sectionName = keys[0]
        subsections = item[sectionName]
      } else {
        console.warn(`[content-collector] Invalid section entry:`, item)
        continue
      }
    } else {
      continue
    }

    // Build section ID
    const id = parentId ? `${parentId}.${index}` : String(index)

    // Look for the markdown file
    const filePath = join(pagePath, `${sectionName}.md`)
    if (!existsSync(filePath)) {
      console.warn(`[content-collector] Section file not found: ${sectionName}.md`)
      index++
      continue
    }

    // Process the section
    const { section, assetCollection: sectionAssets } = await processMarkdownFile(filePath, id, siteRoot)
    assetCollection = mergeAssetCollections(assetCollection, sectionAssets)

    // Track last modified
    const fileStat = await stat(filePath)
    if (!lastModified || fileStat.mtime > lastModified) {
      lastModified = fileStat.mtime
    }

    // Process subsections recursively
    if (Array.isArray(subsections) && subsections.length > 0) {
      const subResult = await processExplicitSections(subsections, pagePath, siteRoot, id)
      section.subsections = subResult.sections
      assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
      if (subResult.lastModified && (!lastModified || subResult.lastModified > lastModified)) {
        lastModified = subResult.lastModified
      }
    }

    sections.push(section)
    index++
  }

  return { sections, assetCollection, lastModified }
}

/**
 * Process a page directory
 *
 * @param {string} pagePath - Path to page directory
 * @param {string} pageName - Name of the page (folder name, not full path)
 * @param {string} siteRoot - Site root directory for asset resolution
 * @param {Object} options - Route options
 * @param {boolean} options.isIndex - Whether this page is the index for its parent route
 * @param {string} options.parentRoute - The parent route (e.g., '/' or '/docs')
 * @param {Object} options.parentFetch - Parent page's fetch config (for dynamic routes)
 * @returns {Object} Page data with assets manifest
 */
async function processPage(pagePath, pageName, siteRoot, { isIndex = false, parentRoute = '/', parentFetch = null } = {}) {
  const pageConfig = await readYamlFile(join(pagePath, 'page.yml'))

  // Note: We no longer skip hidden pages here - they still exist as valid pages,
  // they're just filtered from navigation. This allows direct linking to hidden pages.
  // if (pageConfig.hidden) return null

  let hierarchicalSections = []
  let pageAssetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let lastModified = null

  // Check for explicit sections configuration
  const { sections: sectionsConfig } = pageConfig

  if (sectionsConfig === undefined || sectionsConfig === '*') {
    // Default behavior: discover all .md files, sort by numeric prefix
    const files = await readdir(pagePath)
    const mdFiles = files.filter(isMarkdownFile).sort(compareFilenames)

    const sections = []
    for (const file of mdFiles) {
      const { name } = parse(file)
      const { prefix } = parseNumericPrefix(name)
      const id = prefix || name

      const { section, assetCollection } = await processMarkdownFile(join(pagePath, file), id, siteRoot)
      sections.push(section)
      pageAssetCollection = mergeAssetCollections(pageAssetCollection, assetCollection)

      // Track last modified time for sitemap
      const fileStat = await stat(join(pagePath, file))
      if (!lastModified || fileStat.mtime > lastModified) {
        lastModified = fileStat.mtime
      }
    }

    // Build hierarchy from dot notation
    hierarchicalSections = buildSectionHierarchy(sections)

  } else if (Array.isArray(sectionsConfig) && sectionsConfig.length > 0) {
    // Explicit sections array
    const result = await processExplicitSections(sectionsConfig, pagePath, siteRoot)
    hierarchicalSections = result.sections
    pageAssetCollection = result.assetCollection
    lastModified = result.lastModified

  } else {
    // Empty sections (null, empty array, or invalid) = pure route with no content
    // hierarchicalSections stays empty, lastModified stays null
  }

  // Determine route
  // All pages get their actual folder-based route (no special treatment for index)
  // The isIndex flag marks which page should also be accessible at the parent route
  let route
  const isDynamic = isDynamicRoute(pageName)
  const paramName = isDynamic ? extractRouteParam(pageName) : null

  if (pageName.startsWith('@')) {
    // Special pages (layout areas) keep their @ prefix
    route = parentRoute === '/' ? `/@${pageName.slice(1)}` : `${parentRoute}/@${pageName.slice(1)}`
  } else if (isDynamic) {
    // Dynamic routes: /blog/[slug] → /blog/:slug (for route matching)
    // The actual routes like /blog/my-post are generated at prerender time
    route = parentRoute === '/' ? `/:${paramName}` : `${parentRoute}/:${paramName}`
  } else {
    // Normal pages get parent + their name
    route = parentRoute === '/' ? `/${pageName}` : `${parentRoute}/${pageName}`
  }

  // Extract configuration
  const { seo = {}, layout = {}, ...restConfig } = pageConfig

  // For dynamic routes, determine the parent's data schema
  // This tells prerender which data array to iterate over
  let parentSchema = null
  if (isDynamic && parentFetch) {
    parentSchema = parentFetch.schema
  }

  return {
    page: {
      route,
      isIndex, // Marks this page as the index for its parent route (accessible at parentRoute)
      title: pageConfig.title || pageName,
      description: pageConfig.description || '',
      label: pageConfig.label || null, // Short label for navigation (defaults to title)
      order: pageConfig.order,
      lastModified: lastModified?.toISOString(),

      // Dynamic route metadata
      isDynamic,
      paramName, // e.g., "slug" from [slug]
      parentSchema, // e.g., "articles" - the data array to iterate over

      // Navigation options
      hidden: pageConfig.hidden || false, // Hide from all navigation
      hideInHeader: pageConfig.hideInHeader || false, // Hide from header nav
      hideInFooter: pageConfig.hideInFooter || false, // Hide from footer nav

      // Layout options (per-page overrides)
      layout: {
        header: layout.header !== false, // Show header (default true)
        footer: layout.footer !== false, // Show footer (default true)
        leftPanel: layout.leftPanel !== false, // Show left panel (default true)
        rightPanel: layout.rightPanel !== false // Show right panel (default true)
      },

      seo: {
        noindex: seo.noindex || false,
        image: seo.image || null,
        changefreq: seo.changefreq || null,
        priority: seo.priority || null
      },

      // Data fetching
      fetch: parseFetchConfig(pageConfig.fetch),

      sections: hierarchicalSections
    },
    assetCollection: pageAssetCollection
  }
}

/**
 * Determine the index page name from ordering config
 *
 * @param {Object} orderConfig - { pages: [...], index: 'name' } from parent
 * @param {Array} availableFolders - Array of { name, order } for folders at this level
 * @returns {string|null} The folder name that should be the index, or null
 */
function determineIndexPage(orderConfig, availableFolders) {
  const { pages: pagesArray, index: indexName } = orderConfig || {}

  // 1. Explicit pages array - first item is index
  if (Array.isArray(pagesArray) && pagesArray.length > 0) {
    return pagesArray[0]
  }

  // 2. Explicit index property
  if (indexName) {
    return indexName
  }

  // 3. Fallback: lowest order value, or first alphabetically
  if (availableFolders.length === 0) return null

  const sorted = [...availableFolders].sort((a, b) => {
    // Sort by order (lower first), then alphabetically
    const orderA = a.order ?? 999
    const orderB = b.order ?? 999
    if (orderA !== orderB) return orderA - orderB
    return a.name.localeCompare(b.name)
  })

  return sorted[0].name
}

/**
 * Recursively collect pages from a directory
 *
 * @param {string} dirPath - Directory to scan
 * @param {string} parentRoute - Parent route (e.g., '/' or '/docs')
 * @param {string} siteRoot - Site root directory for asset resolution
 * @param {Object} orderConfig - { pages: [...], index: 'name' } from parent's config
 * @param {Object} parentFetch - Parent page's fetch config (for dynamic child routes)
 * @returns {Promise<Object>} { pages, assetCollection, header, footer, left, right, notFound }
 */
async function collectPagesRecursive(dirPath, parentRoute, siteRoot, orderConfig = {}, parentFetch = null) {
  const entries = await readdir(dirPath)
  const pages = []
  let assetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let header = null
  let footer = null
  let left = null
  let right = null
  let notFound = null

  // First pass: discover all page folders and read their order values
  const pageFolders = []
  for (const entry of entries) {
    const entryPath = join(dirPath, entry)
    const stats = await stat(entryPath)
    if (!stats.isDirectory()) continue

    // Read page.yml to get order and child page config
    const pageConfig = await readYamlFile(join(entryPath, 'page.yml'))
    pageFolders.push({
      name: entry,
      path: entryPath,
      order: pageConfig.order,
      childOrderConfig: {
        pages: pageConfig.pages,
        index: pageConfig.index
      }
    })
  }

  // Determine which page is the index for this level
  const regularFolders = pageFolders.filter(f => !f.name.startsWith('@'))
  const indexPageName = determineIndexPage(orderConfig, regularFolders)

  // Second pass: process each page folder
  for (const folder of pageFolders) {
    const { name: entry, path: entryPath, childOrderConfig } = folder
    const isIndex = entry === indexPageName
    const isSpecial = entry.startsWith('@')

    // Process this directory as a page
    // Pass parentFetch so dynamic routes can inherit parent's data schema
    const result = await processPage(entryPath, entry, siteRoot, {
      isIndex: isIndex && !isSpecial,
      parentRoute,
      parentFetch
    })

    if (result) {
      const { page, assetCollection: pageAssets } = result
      assetCollection = mergeAssetCollections(assetCollection, pageAssets)

      // Handle special pages (layout areas and 404) - only at root level
      if (parentRoute === '/') {
        if (entry === '@header') {
          header = page
        } else if (entry === '@footer') {
          footer = page
        } else if (entry === '@left') {
          left = page
        } else if (entry === '@right') {
          right = page
        } else if (entry === '404') {
          notFound = page
        } else {
          pages.push(page)
        }
      } else {
        pages.push(page)
      }

      // Recursively process subdirectories (but not special @ directories)
      if (!isSpecial) {
        // The child route depends on whether this page is the index
        const childParentRoute = isIndex ? parentRoute : page.route
        // Pass this page's fetch config to children (for dynamic routes that inherit parent data)
        const childFetch = page.fetch || parentFetch
        const subResult = await collectPagesRecursive(entryPath, childParentRoute, siteRoot, childOrderConfig, childFetch)
        pages.push(...subResult.pages)
        assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
      }
    }
  }

  return { pages, assetCollection, header, footer, left, right, notFound }
}

/**
 * Collect all site content
 *
 * @param {string} sitePath - Path to site directory
 * @returns {Promise<Object>} Site content object with assets manifest
 */
export async function collectSiteContent(sitePath) {
  const pagesPath = join(sitePath, 'pages')

  // Read site config
  const siteConfig = await readYamlFile(join(sitePath, 'site.yml'))
  const themeConfig = await readYamlFile(join(sitePath, 'theme.yml'))

  // Check if pages directory exists
  if (!existsSync(pagesPath)) {
    return {
      config: siteConfig,
      theme: themeConfig,
      pages: [],
      assets: {}
    }
  }

  // Extract page ordering config from site.yml
  const siteOrderConfig = {
    pages: siteConfig.pages,
    index: siteConfig.index
  }

  // Recursively collect all pages
  const { pages, assetCollection, header, footer, left, right, notFound } =
    await collectPagesRecursive(pagesPath, '/', sitePath, siteOrderConfig)

  // Sort pages by order
  pages.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

  // Log asset summary
  const assetCount = Object.keys(assetCollection.assets).length
  const explicitCount = assetCollection.hasExplicitPoster.size + assetCollection.hasExplicitPreview.size
  if (assetCount > 0) {
    console.log(`[content-collector] Found ${assetCount} asset references${explicitCount > 0 ? ` (${explicitCount} with explicit poster/preview)` : ''}`)
  }

  return {
    config: {
      ...siteConfig,
      fetch: parseFetchConfig(siteConfig.fetch),
    },
    theme: themeConfig,
    pages,
    header,
    footer,
    left,
    right,
    notFound,
    assets: assetCollection.assets,
    hasExplicitPoster: assetCollection.hasExplicitPoster,
    hasExplicitPreview: assetCollection.hasExplicitPreview
  }
}

export default collectSiteContent
