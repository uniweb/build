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
 */
function parseNumericPrefix(filename) {
  const match = filename.match(/^(\d+(?:\.\d+)*)-?(.*)$/)
  if (match) {
    return { prefix: match[1], name: match[2] || match[1] }
  }
  return { prefix: null, name: filename }
}

/**
 * Compare filenames for sorting by numeric prefix
 */
function compareFilenames(a, b) {
  const { prefix: prefixA } = parseNumericPrefix(parse(a).name)
  const { prefix: prefixB } = parseNumericPrefix(parse(b).name)

  if (!prefixA && !prefixB) return a.localeCompare(b)
  if (!prefixA) return 1
  if (!prefixB) return -1

  const partsA = prefixA.split('.').map(Number)
  const partsB = prefixB.split('.').map(Number)

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

  const { type, component, preset, input, props, ...params } = frontMatter

  // Convert markdown to ProseMirror
  const proseMirrorContent = markdownToProseMirror(markdown)

  const section = {
    id,
    component: type || component || 'Section',
    preset,
    input,
    params: { ...params, ...props },
    content: proseMirrorContent,
    subsections: []
  }

  // Collect assets referenced in this section
  const assetCollection = collectSectionAssets(section, filePath, siteRoot)

  return { section, assetCollection }
}

/**
 * Build section hierarchy from flat list
 */
function buildSectionHierarchy(sections) {
  const sectionMap = new Map()
  const topLevel = []

  // First pass: create map
  for (const section of sections) {
    sectionMap.set(section.id, section)
  }

  // Second pass: build hierarchy
  for (const section of sections) {
    if (!section.id.includes('.')) {
      topLevel.push(section)
      continue
    }

    const parts = section.id.split('.')
    const parentId = parts.slice(0, -1).join('.')
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
 * @param {string} pageName - Name of the page
 * @param {string} siteRoot - Site root directory for asset resolution
 * @returns {Object} Page data with assets manifest
 */
async function processPage(pagePath, pageName, siteRoot) {
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
  let route = '/' + pageName
  if (pageName === 'home' || pageName === 'index') {
    route = '/'
  } else if (pageName.startsWith('@')) {
    route = '/' + pageName
  }

  // Extract configuration
  const { seo = {}, layout = {}, ...restConfig } = pageConfig

  return {
    page: {
      route,
      title: pageConfig.title || pageName,
      description: pageConfig.description || '',
      label: pageConfig.label || null, // Short label for navigation (defaults to title)
      order: pageConfig.order,
      lastModified: lastModified?.toISOString(),

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
      sections: hierarchicalSections
    },
    assetCollection: pageAssetCollection
  }
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

  // Get page directories
  const entries = await readdir(pagesPath)
  const pages = []
  let siteAssetCollection = {
    assets: {},
    hasExplicitPoster: new Set(),
    hasExplicitPreview: new Set()
  }
  let header = null
  let footer = null

  for (const entry of entries) {
    const entryPath = join(pagesPath, entry)
    const stats = await stat(entryPath)

    if (!stats.isDirectory()) continue

    const result = await processPage(entryPath, entry, sitePath)
    if (!result) continue

    const { page, assetCollection } = result
    siteAssetCollection = mergeAssetCollections(siteAssetCollection, assetCollection)

    // Handle special pages
    if (entry === '@header' || page.route === '/@header') {
      header = page
    } else if (entry === '@footer' || page.route === '/@footer') {
      footer = page
    } else {
      pages.push(page)
    }
  }

  // Sort pages by order
  pages.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

  // Log asset summary
  const assetCount = Object.keys(siteAssetCollection.assets).length
  const explicitCount = siteAssetCollection.hasExplicitPoster.size + siteAssetCollection.hasExplicitPreview.size
  if (assetCount > 0) {
    console.log(`[content-collector] Found ${assetCount} asset references${explicitCount > 0 ? ` (${explicitCount} with explicit poster/preview)` : ''}`)
  }

  return {
    config: siteConfig,
    theme: themeConfig,
    pages,
    header,
    footer,
    assets: siteAssetCollection.assets,
    hasExplicitPoster: siteAssetCollection.hasExplicitPoster,
    hasExplicitPreview: siteAssetCollection.hasExplicitPreview
  }
}

export default collectSiteContent
