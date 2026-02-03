/**
 * Content Collector
 *
 * Collects site content from a site directory structure:
 * - site.yml: Site configuration
 * - pages/: Directory of page folders
 *   - page.yml: Page metadata
 *   - *.md: Section content with YAML frontmatter
 * - layout/: Layout panel folders (header, footer, left, right)
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
import { collectSectionIcons, mergeIconCollections, buildIconManifest } from './icons.js'
import { parseFetchConfig, singularize } from './data-fetcher.js'
import { buildTheme, extractFoundationVars } from '../theme/index.js'

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

// ─────────────────────────────────────────────────────────────────
// Version Detection
// ─────────────────────────────────────────────────────────────────

/**
 * Check if a folder name represents a version (e.g., v1, v2, v1.0, v2.1)
 * @param {string} folderName - The folder name to check
 * @returns {boolean}
 */
function isVersionFolder(folderName) {
  return /^v\d+(\.\d+)?$/.test(folderName)
}

/**
 * Parse version info from folder name
 * @param {string} folderName - The folder name (e.g., "v1", "v2.1")
 * @returns {Object} Version info { id, major, minor, sortKey }
 */
function parseVersionInfo(folderName) {
  const match = folderName.match(/^v(\d+)(?:\.(\d+))?$/)
  if (!match) return null

  const major = parseInt(match[1], 10)
  const minor = match[2] ? parseInt(match[2], 10) : 0

  return {
    id: folderName,
    major,
    minor,
    sortKey: major * 1000 + minor // For sorting: v2.1 > v2.0 > v1.9
  }
}

/**
 * Detect if a set of folders contains version folders
 * @param {Array<string>} folderNames - List of folder names
 * @returns {Array<Object>|null} Sorted version infos (highest first) or null if not versioned
 */
function detectVersions(folderNames) {
  const versions = folderNames
    .filter(isVersionFolder)
    .map(parseVersionInfo)
    .filter(Boolean)

  if (versions.length === 0) return null

  // Sort by version (highest first)
  versions.sort((a, b) => b.sortKey - a.sortKey)

  return versions
}

/**
 * Build version metadata from detected versions and page.yml config
 * @param {Array<Object>} detectedVersions - Detected version infos
 * @param {Object} pageConfig - page.yml configuration
 * @returns {Object} Version metadata { versions, latestId, scope }
 */
function buildVersionMetadata(detectedVersions, pageConfig = {}) {
  const configVersions = pageConfig.versions || {}

  // Build version list with metadata
  const versions = detectedVersions.map((v, index) => {
    const config = configVersions[v.id] || {}
    const isLatest = config.latest === true || (index === 0 && !Object.values(configVersions).some(c => c.latest))

    return {
      id: v.id,
      label: config.label || v.id,
      latest: isLatest,
      deprecated: config.deprecated || false,
      sortKey: v.sortKey
    }
  })

  // Find the latest version
  const latestVersion = versions.find(v => v.latest) || versions[0]

  return {
    versions,
    latestId: latestVersion?.id || null
  }
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
 * @param {string} id - Section ID (numeric/positional)
 * @param {string} siteRoot - Site root directory for asset resolution
 * @param {string} defaultStableId - Default stable ID from filename (can be overridden in frontmatter)
 * @returns {Object} Section data with assets manifest
 */
async function processMarkdownFile(filePath, id, siteRoot, defaultStableId = null) {
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

  const { type, component, preset, input, props, fetch, data, id: frontmatterId, ...params } = frontMatter

  // Convert markdown to ProseMirror
  const proseMirrorContent = markdownToProseMirror(markdown)

  // Support 'data:' shorthand for collection fetch
  // data: team → fetch: { collection: team }
  // data: [team, articles] → fetch: { collection: team } (first item, others via inheritData)
  let resolvedFetch = fetch
  if (!fetch && data) {
    const collectionName = Array.isArray(data) ? data[0] : data
    resolvedFetch = { collection: collectionName }
  }

  // Stable ID for scroll targeting: frontmatter id > filename-derived > null
  // This ID is stable across reordering (unlike the positional id)
  const stableId = frontmatterId || defaultStableId || null

  const section = {
    id,
    stableId,
    component: type || component || 'Section',
    preset,
    input,
    params: { ...params, ...props },
    content: proseMirrorContent,
    fetch: parseFetchConfig(resolvedFetch),
    subsections: []
  }

  // Collect assets referenced in this section
  const assetCollection = collectSectionAssets(section, filePath, siteRoot)

  // Collect icons referenced in this section
  const iconCollection = collectSectionIcons(section, filePath)

  return { section, assetCollection, iconCollection }
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
 * @returns {Object} { sections, assetCollection, iconCollection, lastModified }
 */
async function processExplicitSections(sectionsConfig, pagePath, siteRoot, parentId = '') {
  const sections = []
  let assetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let iconCollection = {
    icons: new Set(),
    bySource: new Map()
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
    // Use sectionName as stable ID for scroll targeting (e.g., "hero", "features")
    const { section, assetCollection: sectionAssets, iconCollection: sectionIcons } = await processMarkdownFile(filePath, id, siteRoot, sectionName)
    assetCollection = mergeAssetCollections(assetCollection, sectionAssets)
    iconCollection = mergeIconCollections(iconCollection, sectionIcons)

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
      iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
      if (subResult.lastModified && (!lastModified || subResult.lastModified > lastModified)) {
        lastModified = subResult.lastModified
      }
    }

    sections.push(section)
    index++
  }

  return { sections, assetCollection, iconCollection, lastModified }
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
 * @param {Object} options.versionContext - Version context from parent { version, versionMeta, scope }
 * @returns {Object} Page data with assets manifest
 */
async function processPage(pagePath, pageName, siteRoot, { isIndex = false, parentRoute = '/', parentFetch = null, versionContext = null } = {}) {
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
  let pageIconCollection = {
    icons: new Set(),
    bySource: new Map()
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
      const { prefix, name: stableName } = parseNumericPrefix(name)
      const id = prefix || name
      // Use the name part (after prefix) as stable ID for scroll targeting
      // e.g., "1-intro.md" → stableId: "intro", "2-features.md" → stableId: "features"
      const stableId = stableName || name

      const { section, assetCollection, iconCollection } = await processMarkdownFile(join(pagePath, file), id, siteRoot, stableId)
      sections.push(section)
      pageAssetCollection = mergeAssetCollections(pageAssetCollection, assetCollection)
      pageIconCollection = mergeIconCollections(pageIconCollection, iconCollection)

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
    pageIconCollection = result.iconCollection
    lastModified = result.lastModified

  } else {
    // Empty sections (null, empty array, or invalid) = pure route with no content
    // hierarchicalSections stays empty, lastModified stays null
  }

  // Determine route
  // Index pages get the parent route as their canonical route (no dual routes)
  // sourcePath stores the original folder-based path for ancestor checking
  const isDynamic = isDynamicRoute(pageName)
  const paramName = isDynamic ? extractRouteParam(pageName) : null

  // First, calculate the folder-based route (what the route would be without index handling)
  let folderRoute
  if (isDynamic) {
    // Dynamic routes: /blog/[slug] → /blog/:slug (for route matching)
    folderRoute = parentRoute === '/' ? `/:${paramName}` : `${parentRoute}/:${paramName}`
  } else {
    // Normal pages get parent + their name
    folderRoute = parentRoute === '/' ? `/${pageName}` : `${parentRoute}/${pageName}`
  }

  // For index pages, the canonical route is the parent route
  // For non-index pages, the canonical route is the folder-based route
  const route = isIndex ? parentRoute : folderRoute
  // sourcePath is the original folder-based path (used for ancestor checking)
  // Only set for index pages where it differs from route
  const sourcePath = isIndex ? folderRoute : null

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
      sourcePath, // Original folder-based path (for ancestor checking in navigation)
      id: pageConfig.id || null, // Stable page ID for page: links (survives reorganization)
      isIndex, // Marks this page as the index for its parent route
      title: pageConfig.title || pageName,
      description: pageConfig.description || '',
      label: pageConfig.label || null, // Short label for navigation (defaults to title)
      lastModified: lastModified?.toISOString(),

      // Dynamic route metadata
      isDynamic,
      paramName, // e.g., "slug" from [slug]
      parentSchema, // e.g., "articles" - the data array to iterate over

      // Version metadata (if within a versioned section)
      version: versionContext?.version || null,
      versionMeta: versionContext?.versionMeta || null,
      versionScope: versionContext?.scope || null,

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
      // Support 'data:' shorthand at page level
      // data: team → fetch: { collection: team }
      fetch: parseFetchConfig(
        pageConfig.fetch || (pageConfig.data
          ? { collection: Array.isArray(pageConfig.data) ? pageConfig.data[0] : pageConfig.data }
          : undefined)
      ),

      sections: hierarchicalSections
    },
    assetCollection: pageAssetCollection,
    iconCollection: pageIconCollection
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
  // IMPORTANT: Dynamic route folders (e.g., [slug]) can never be index pages
  // They are templates for dynamic content, not actual navigable pages
  const staticFolders = availableFolders.filter(f => !isDynamicRoute(f.name))
  if (staticFolders.length === 0) return null

  const sorted = [...staticFolders].sort((a, b) => {
    // Sort by order (lower first), then alphabetically
    // Pages without explicit order come after ordered pages
    const orderA = a.order ?? Infinity
    const orderB = b.order ?? Infinity
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
 * @param {Object} versionContext - Version context from parent { version, versionMeta }
 * @returns {Promise<Object>} { pages, assetCollection, iconCollection, header, footer, left, right, notFound, versionedScopes }
 */
async function collectPagesRecursive(dirPath, parentRoute, siteRoot, orderConfig = {}, parentFetch = null, versionContext = null) {
  const entries = await readdir(dirPath)
  const pages = []
  let assetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let iconCollection = {
    icons: new Set(),
    bySource: new Map()
  }
  let notFound = null
  const versionedScopes = new Map() // scope route → versionMeta

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
      pageConfig,
      childOrderConfig: {
        pages: pageConfig.pages,
        index: pageConfig.index
      }
    })
  }

  // Sort page folders by order (ascending), then alphabetically
  // Pages without explicit order come after ordered pages (order ?? Infinity)
  pageFolders.sort((a, b) => {
    const orderA = a.order ?? Infinity
    const orderB = b.order ?? Infinity
    if (orderA !== orderB) return orderA - orderB
    return a.name.localeCompare(b.name)
  })

  // Check if this directory contains version folders (versioned section)
  const folderNames = pageFolders.map(f => f.name)
  const detectedVersions = detectVersions(folderNames)

  // If versioned section, handle version folders specially
  if (detectedVersions && !versionContext) {
    // Read parent page.yml for version metadata
    const parentConfig = await readYamlFile(join(dirPath, 'page.yml'))
    const versionMeta = buildVersionMetadata(detectedVersions, parentConfig)

    // Record this versioned scope
    versionedScopes.set(parentRoute, versionMeta)

    // Process version folders
    for (const folder of pageFolders) {
      const { name: entry, path: entryPath, childOrderConfig, pageConfig } = folder

      if (isVersionFolder(entry)) {
        // This is a version folder
        const versionInfo = versionMeta.versions.find(v => v.id === entry)
        const isLatest = versionInfo?.latest || false

        // For latest version, use parent route directly
        // For other versions, add version prefix to route
        // Handle root scope specially to avoid double slash (//v1 → /v1)
        const versionRoute = isLatest
          ? parentRoute
          : parentRoute === '/'
            ? `/${entry}`
            : `${parentRoute}/${entry}`

        // Recurse into version folder with version context
        const subResult = await collectPagesRecursive(
          entryPath,
          versionRoute,
          siteRoot,
          childOrderConfig,
          parentFetch,
          {
            version: versionInfo,
            versionMeta,
            scope: parentRoute // The route where versioning is scoped
          }
        )

        pages.push(...subResult.pages)
        assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
        iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
        // Merge any nested versioned scopes (shouldn't happen often, but possible)
        for (const [scope, meta] of subResult.versionedScopes) {
          versionedScopes.set(scope, meta)
        }
      } else {
        // Non-version folders in a versioned section
        // These could be shared across versions - process normally
        const result = await processPage(entryPath, entry, siteRoot, {
          isIndex: false,
          parentRoute,
          parentFetch
        })

        if (result) {
          pages.push(result.page)
          assetCollection = mergeAssetCollections(assetCollection, result.assetCollection)
          iconCollection = mergeIconCollections(iconCollection, result.iconCollection)
        }
      }
    }

    // Return early - we've handled all children
    return { pages, assetCollection, iconCollection, notFound, versionedScopes }
  }

  // Determine which page is the index for this level
  // A directory with its own .md content is a real page, not a container —
  // never promote a child as index, even if explicit config says so
  // (that config is likely a leftover from before the directory had content)
  const regularFolders = pageFolders
  const hasExplicitOrder = orderConfig?.index || (Array.isArray(orderConfig?.pages) && orderConfig.pages.length > 0)
  const hasMdContent = entries.some(e => isMarkdownFile(e))
  const indexPageName = hasMdContent ? null : determineIndexPage(orderConfig, regularFolders)

  // Second pass: process each page folder
  for (const folder of pageFolders) {
    const { name: entry, path: entryPath, childOrderConfig } = folder
    const isIndex = entry === indexPageName

    // Process this directory as a page
    // Pass parentFetch so dynamic routes can inherit parent's data schema
    const result = await processPage(entryPath, entry, siteRoot, {
      isIndex,
      parentRoute,
      parentFetch,
      versionContext
    })

    if (result) {
      const { page, assetCollection: pageAssets, iconCollection: pageIcons } = result
      assetCollection = mergeAssetCollections(assetCollection, pageAssets)
      iconCollection = mergeIconCollections(iconCollection, pageIcons)

      // Handle 404 page - only at root level
      if (parentRoute === '/' && entry === '404') {
        notFound = page
      } else {
        pages.push(page)
      }

      // Recursively process subdirectories
      {
        // The child route depends on whether this page is the index
        // For explicit index (from site.yml `index:` or `pages:`), children use parentRoute
        // since that's a true structural promotion. For auto-detected index, children use
        // the page's original folder path so they nest correctly under it.
        const childParentRoute = isIndex
          ? (hasExplicitOrder ? parentRoute : (page.sourcePath || page.route))
          : page.route
        // Pass this page's fetch config to children (for dynamic routes that inherit parent data)
        const childFetch = page.fetch || parentFetch
        // Pass version context to children (maintains version scope)
        const subResult = await collectPagesRecursive(entryPath, childParentRoute, siteRoot, childOrderConfig, childFetch, versionContext)
        pages.push(...subResult.pages)
        assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
        iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
        // Merge any versioned scopes from children
        for (const [scope, meta] of subResult.versionedScopes) {
          versionedScopes.set(scope, meta)
        }
      }
    }
  }

  return { pages, assetCollection, iconCollection, notFound, versionedScopes }
}

/**
 * Load foundation variables from schema.json
 *
 * @param {string} foundationPath - Path to foundation directory
 * @returns {Promise<Object>} Foundation variables or empty object
 */
async function loadFoundationVars(foundationPath) {
  if (!foundationPath) return {}

  // Try dist/meta/schema.json first (built foundation), then root schema.json
  const distSchemaPath = join(foundationPath, 'dist', 'meta', 'schema.json')
  const rootSchemaPath = join(foundationPath, 'schema.json')

  const schemaPath = existsSync(distSchemaPath) ? distSchemaPath : rootSchemaPath

  if (!existsSync(schemaPath)) {
    return {}
  }

  try {
    const schemaContent = await readFile(schemaPath, 'utf8')
    const schema = JSON.parse(schemaContent)
    // Foundation config is in _self, support both 'vars' (new) and 'themeVars' (legacy)
    return schema._self?.vars || schema._self?.themeVars || schema.themeVars || {}
  } catch (err) {
    console.warn('[content-collector] Failed to load foundation schema:', err.message)
    return {}
  }
}

/**
 * Collect layout panels from the layout/ directory
 *
 * Layout panels (header, footer, left, right) are persistent regions
 * that appear on every page. They live in layout/ parallel to pages/.
 *
 * @param {string} layoutDir - Path to layout directory
 * @param {string} siteRoot - Path to site root
 * @returns {Promise<Object>} { header, footer, left, right }
 */
async function collectLayoutPanels(layoutDir, siteRoot) {
  const result = { header: null, footer: null, left: null, right: null }

  if (!existsSync(layoutDir)) return result

  const knownPanels = ['header', 'footer', 'left', 'right']
  const entries = await readdir(layoutDir)

  for (const entry of entries) {
    if (!knownPanels.includes(entry)) continue
    const entryPath = join(layoutDir, entry)
    const stats = await stat(entryPath)
    if (!stats.isDirectory()) continue

    const pageResult = await processPage(entryPath, entry, siteRoot, {
      isIndex: false,
      parentRoute: '/layout'
    })

    if (pageResult) {
      result[entry] = pageResult.page
    }
  }

  return result
}

/**
 * Collect all site content
 *
 * @param {string} sitePath - Path to site directory
 * @param {Object} options - Collection options
 * @param {string} options.foundationPath - Path to foundation directory (for theme vars)
 * @returns {Promise<Object>} Site content object with assets manifest
 */
export async function collectSiteContent(sitePath, options = {}) {
  const { foundationPath } = options
  const pagesPath = join(sitePath, 'pages')
  const layoutPath = join(sitePath, 'layout')

  // Read site config and raw theme config
  const siteConfig = await readYamlFile(join(sitePath, 'site.yml'))
  const rawThemeConfig = await readYamlFile(join(sitePath, 'theme.yml'))

  // Load foundation vars and process theme
  const foundationVars = await loadFoundationVars(foundationPath)
  const { config: processedTheme, css: themeCSS, warnings } = buildTheme(rawThemeConfig, { foundationVars })

  // Log theme warnings
  if (warnings?.length > 0) {
    warnings.forEach(w => console.warn(`[theme] ${w}`))
  }

  // Check if pages directory exists
  if (!existsSync(pagesPath)) {
    return {
      config: siteConfig,
      theme: {
        ...processedTheme,
        css: themeCSS
      },
      pages: [],
      assets: {}
    }
  }

  // Extract page ordering config from site.yml
  const siteOrderConfig = {
    pages: siteConfig.pages,
    index: siteConfig.index
  }

  // Collect layout panels from layout/ directory
  const { header, footer, left, right } = await collectLayoutPanels(layoutPath, sitePath)

  // Recursively collect all pages
  const { pages, assetCollection, iconCollection, notFound, versionedScopes } =
    await collectPagesRecursive(pagesPath, '/', sitePath, siteOrderConfig)

  // Deduplicate: remove content-less container pages whose route duplicates
  // a content-bearing page (e.g., a promoted index page)
  const routeCounts = new Map()
  for (const page of pages) {
    const existing = routeCounts.get(page.route)
    if (!existing) {
      routeCounts.set(page.route, [page])
    } else {
      existing.push(page)
    }
  }
  for (const [route, group] of routeCounts) {
    if (group.length > 1) {
      // Keep the page with content, remove content-less duplicates
      const withContent = group.filter(p => p.sections && p.sections.length > 0)
      const toRemove = withContent.length > 0
        ? group.filter(p => !p.sections || p.sections.length === 0)
        : group.slice(1) // If none have content, keep first
      for (const page of toRemove) {
        const idx = pages.indexOf(page)
        if (idx !== -1) pages.splice(idx, 1)
      }
    }
  }

  // Compute parent route for each page (hierarchy declaration)
  // This runs once at build time so runtime doesn't need to re-derive hierarchy
  const pageRouteMap = new Map()
  for (const page of pages) {
    pageRouteMap.set(page.route, page)
    if (page.sourcePath) {
      pageRouteMap.set(page.sourcePath, page)
    }
  }
  for (const page of pages) {
    const segments = page.route.split('/').filter(Boolean)
    if (segments.length <= 1) {
      page.parent = null
      continue
    }
    const parentRoute = '/' + segments.slice(0, -1).join('/')
    const parentPage = pageRouteMap.get(parentRoute)
    page.parent = parentPage ? parentPage.route : null
  }

  // Sort pages by order
  pages.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

  // Log asset summary
  const assetCount = Object.keys(assetCollection.assets).length
  const explicitCount = assetCollection.hasExplicitPoster.size + assetCollection.hasExplicitPreview.size
  if (assetCount > 0) {
    console.log(`[content-collector] Found ${assetCount} asset references${explicitCount > 0 ? ` (${explicitCount} with explicit poster/preview)` : ''}`)
  }

  // Build icon manifest from collected icons
  const iconManifest = buildIconManifest(iconCollection)
  if (iconManifest.count > 0) {
    console.log(`[content-collector] Found ${iconManifest.count} icon references from ${iconManifest.families.length} families: ${iconManifest.families.join(', ')}`)
  }

  // Convert versionedScopes Map to plain object for JSON serialization
  const versionedScopesObj = Object.fromEntries(versionedScopes)

  return {
    config: {
      ...siteConfig,
      fetch: parseFetchConfig(siteConfig.fetch),
    },
    theme: {
      ...processedTheme,
      css: themeCSS
    },
    pages,
    header,
    footer,
    left,
    right,
    notFound,
    // Versioned scopes: route → { versions, latestId }
    versionedScopes: versionedScopesObj,
    assets: assetCollection.assets,
    hasExplicitPoster: assetCollection.hasExplicitPoster,
    hasExplicitPreview: assetCollection.hasExplicitPreview,
    // Icon manifest for preloading
    icons: iconManifest
  }
}

export default collectSiteContent
