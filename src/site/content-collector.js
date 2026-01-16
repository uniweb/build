/**
 * Content Collector
 *
 * Collects site content from a pages/ directory structure:
 * - site.yml: Site configuration
 * - pages/: Directory of page folders
 *   - page.yml: Page metadata
 *   - *.md: Section content with YAML frontmatter
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
 */
async function processMarkdownFile(filePath, id) {
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

  const { component, preset, input, props, ...params } = frontMatter

  // Convert markdown to ProseMirror
  const proseMirrorContent = markdownToProseMirror(markdown)

  return {
    id,
    component: component || 'Section',
    preset,
    input,
    params: { ...params, ...props },
    content: proseMirrorContent,
    subsections: []
  }
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
 * Process a page directory
 */
async function processPage(pagePath, pageName) {
  const pageConfig = await readYamlFile(join(pagePath, 'page.yml'))

  if (pageConfig.hidden) return null

  // Get markdown files
  const files = await readdir(pagePath)
  const mdFiles = files.filter(isMarkdownFile).sort(compareFilenames)

  // Process sections
  const sections = []
  for (const file of mdFiles) {
    const { name } = parse(file)
    const { prefix } = parseNumericPrefix(name)
    const id = prefix || name

    const section = await processMarkdownFile(join(pagePath, file), id)
    sections.push(section)
  }

  // Build hierarchy
  const hierarchicalSections = buildSectionHierarchy(sections)

  // Determine route
  let route = '/' + pageName
  if (pageName === 'home' || pageName === 'index') {
    route = '/'
  } else if (pageName.startsWith('@')) {
    route = '/' + pageName
  }

  return {
    route,
    title: pageConfig.title || pageName,
    description: pageConfig.description || '',
    order: pageConfig.order,
    sections: hierarchicalSections
  }
}

/**
 * Collect all site content
 *
 * @param {string} sitePath - Path to site directory
 * @returns {Promise<Object>} Site content object
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
      pages: []
    }
  }

  // Get page directories
  const entries = await readdir(pagesPath)
  const pages = []
  let header = null
  let footer = null

  for (const entry of entries) {
    const entryPath = join(pagesPath, entry)
    const stats = await stat(entryPath)

    if (!stats.isDirectory()) continue

    const page = await processPage(entryPath, entry)
    if (!page) continue

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

  return {
    config: siteConfig,
    theme: themeConfig,
    pages,
    header,
    footer
  }
}

export default collectSiteContent
