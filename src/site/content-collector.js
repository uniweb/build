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
import { join, parse, resolve, sep } from 'node:path'
import { existsSync, statSync, realpathSync } from 'node:fs'
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
 * Extract inset references from a ProseMirror document.
 *
 * Walks top-level nodes for `inset_ref` (produced by content-reader
 * for `![alt](@ComponentName){params}` syntax). Each ref is removed from the
 * document and replaced with an `inset_placeholder` node carrying a
 * unique refId. The extracted refs are returned as an array.
 *
 * @param {Object} doc - ProseMirror document (mutated in place)
 * @returns {Array} Array of { refId, type, params, description }
 */
function extractInsets(doc) {
  if (!doc?.content || !Array.isArray(doc.content)) return []

  const insets = []
  let refIndex = 0

  for (let i = 0; i < doc.content.length; i++) {
    const node = doc.content[i]
    if (node.type === 'inset_ref') {
      const { component, alt, ...params } = node.attrs || {}
      const refId = `inset_${refIndex++}`
      insets.push({
        refId,
        type: component,
        params: Object.keys(params).length > 0 ? params : {},
        description: alt || null,
      })
      // Replace in-place with placeholder
      doc.content[i] = {
        type: 'inset_placeholder',
        attrs: { refId },
      }
    }
  }

  return insets
}

/**
 * Check if a file is a markdown file that should be processed.
 * Excludes:
 * - Files not ending in .md
 * - Files starting with _ (drafts/private)
 * - README.md (repo documentation, not site content)
 */
function isMarkdownFile(filename) {
  if (!filename.endsWith('.md')) return false
  if (filename.startsWith('_')) return false
  if (filename.toLowerCase() === 'readme.md') return false
  return true
}

/**
 * Check if a folder should be ignored.
 * Excludes folders starting with _ (drafts/private).
 */
function isIgnoredFolder(name) {
  return name.startsWith('_')
}

/**
 * Read folder configuration, determining content mode from config file presence.
 *
 * - folder.yml present → folder mode (md files are child pages)
 * - page.yml present → page mode (md files are sections of this page)
 * - Neither → inherit mode from parent
 *
 * Internal mode values: 'pages' (folder mode), 'sections' (page mode)
 *
 * @param {string} dirPath - Directory path
 * @param {string} inheritedMode - Mode inherited from parent ('sections' or 'pages')
 * @returns {Promise<{config: Object, mode: string, source: string}>}
 */
async function readFolderConfig(dirPath, inheritedMode) {
  const folderYml = await readYamlFile(join(dirPath, 'folder.yml'))
  if (Object.keys(folderYml).length > 0) {
    return { config: folderYml, mode: 'pages', source: 'folder.yml' }
  }
  const pageYml = await readYamlFile(join(dirPath, 'page.yml'))
  if (Object.keys(pageYml).length > 0) {
    return { config: pageYml, mode: 'sections', source: 'page.yml' }
  }
  // Check for empty folder.yml (presence signals folder mode even if empty)
  if (existsSync(join(dirPath, 'folder.yml'))) {
    return { config: {}, mode: 'pages', source: 'folder.yml' }
  }
  return { config: {}, mode: inheritedMode, source: 'inherited' }
}

/**
 * Extract page mounts from site.yml paths: config.
 *
 * Keys like `pages/docs: ../../../docs` map a route segment to an external
 * directory. All validation happens upfront before any page collection begins.
 *
 * @param {Object} pathsConfig - The paths: object from site.yml
 * @param {string} sitePath - Absolute path to the site directory
 * @param {string} pagesPath - Resolved absolute path to the pages directory
 * @returns {Map<string, string>|null} Route segment → canonical absolute path, or null
 */
function resolveMounts(pathsConfig, sitePath, pagesPath) {
  if (!pathsConfig || typeof pathsConfig !== 'object') return null

  // Extract entries with "pages/" prefix (e.g., "pages/docs": "../../../docs")
  const mountEntries = Object.entries(pathsConfig)
    .filter(([key]) => key.startsWith('pages/'))
    .map(([key, value]) => [key.slice('pages/'.length), value])

  if (mountEntries.length === 0) return null

  const resolved = new Map()
  const canonicalPagesPath = existsSync(pagesPath) ? realpathSync(pagesPath) : resolve(pagesPath)

  for (const [routeSegment, relativePath] of mountEntries) {
    // Validate route segment (simple name, no slashes, no special chars)
    if (!routeSegment || routeSegment.includes('/') || routeSegment.startsWith('.') || routeSegment.startsWith('_')) {
      throw new Error(
        `[content-collector] Invalid mount "pages/${routeSegment}" in site.yml paths.\n` +
        `  The segment after "pages/" must be a simple name (no slashes, dots, or underscores prefix).`
      )
    }

    const absolutePath = resolve(sitePath, relativePath)

    // Check existence
    if (!existsSync(absolutePath)) {
      throw new Error(
        `[content-collector] External pages path does not exist: ${absolutePath}\n` +
        `  Declared in site.yml: pages/${routeSegment}: ${relativePath}`
      )
    }

    // Check it's a directory
    if (!statSync(absolutePath).isDirectory()) {
      throw new Error(
        `[content-collector] External pages path is not a directory: ${absolutePath}\n` +
        `  Declared in site.yml: pages/${routeSegment}: ${relativePath}`
      )
    }

    const canonical = realpathSync(absolutePath)

    // Reject node_modules
    if (canonical.includes(`${sep}node_modules${sep}`)) {
      throw new Error(
        `[content-collector] External pages path must not be inside node_modules: ${canonical}\n` +
        `  Declared in site.yml: pages/${routeSegment}: ${relativePath}`
      )
    }

    // Self-inclusion: must not overlap with site pages directory
    if (
      canonical === canonicalPagesPath ||
      canonical.startsWith(canonicalPagesPath + sep) ||
      canonicalPagesPath.startsWith(canonical + sep)
    ) {
      throw new Error(
        `[content-collector] External pages path overlaps with site pages directory:\n` +
        `  Path: ${canonical}\n` +
        `  Site pages: ${canonicalPagesPath}\n` +
        `  Declared in site.yml: pages/${routeSegment}`
      )
    }

    // Cross-mount overlap: no mount target should be ancestor/descendant of another
    for (const [otherKey, otherPath] of resolved) {
      if (
        canonical === otherPath ||
        canonical.startsWith(otherPath + sep) ||
        otherPath.startsWith(canonical + sep)
      ) {
        throw new Error(
          `[content-collector] External pages paths overlap:\n` +
          `  "pages/${routeSegment}" → ${canonical}\n` +
          `  "pages/${otherKey}" → ${otherPath}`
        )
      }
    }

    resolved.set(routeSegment, canonical)
  }

  return resolved.size > 0 ? resolved : null
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
 * Extract the name from a config array item.
 * Handles both string entries ("hero") and object entries ({ features: [...] }).
 * @param {*} item - Array item from sections: or pages: config
 * @returns {string|null} The name, or null if not a valid entry
 */
function extractItemName(item) {
  if (typeof item === 'string') return item
  if (typeof item === 'object' && item !== null) {
    const keys = Object.keys(item)
    if (keys.length === 1) return keys[0]
  }
  return null
}

/**
 * Parse a config array that may contain '...' rest markers.
 *
 * Returns structured info:
 * - mode 'strict': no '...' — only listed items visible in navigation
 * - mode 'inclusive': '...' present — pinned items + auto-discovered rest
 * - mode 'all': array is just ['...'] — equivalent to omitting config
 *
 * @param {Array} arr - Config array (may contain '...' strings and/or objects)
 * @returns {{ mode: 'strict'|'inclusive'|'all', before: Array, after: Array }|null}
 */
function parseWildcardArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null

  const firstRestIndex = arr.indexOf('...')
  if (firstRestIndex === -1) {
    return { mode: 'strict', before: [...arr], after: [] }
  }

  // Find last '...' index
  let lastRestIndex = firstRestIndex
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === '...') { lastRestIndex = i; break }
  }

  const before = arr.slice(0, firstRestIndex).filter(x => x !== '...')
  const after = arr.slice(lastRestIndex + 1).filter(x => x !== '...')

  if (before.length === 0 && after.length === 0) {
    return { mode: 'all', before: [], after: [] }
  }

  return { mode: 'inclusive', before, after }
}

/**
 * Apply wildcard-aware ordering to a list of named items.
 *
 * - strict: listed items first in listed order, then unlisted (all items returned)
 * - inclusive: before items, then rest (in existing order), then after items
 * - all/null: return items unchanged
 *
 * @param {Array} items - Items with a .name property
 * @param {{ mode: string, before: Array, after: Array }|null} parsed - From parseWildcardArray
 * @returns {Array} Reordered items
 */
function applyWildcardOrder(items, parsed) {
  if (!parsed || parsed.mode === 'all') return items

  const itemMap = new Map(items.map(i => [i.name, i]))
  const beforeNames = parsed.before.map(extractItemName).filter(Boolean)
  const afterNames = parsed.after.map(extractItemName).filter(Boolean)
  const allPinnedNames = new Set([...beforeNames, ...afterNames])

  const beforeItems = beforeNames.filter(n => itemMap.has(n)).map(n => itemMap.get(n))
  const afterItems = afterNames.filter(n => itemMap.has(n)).map(n => itemMap.get(n))
  const rest = items.filter(i => !allPinnedNames.has(i.name))

  if (parsed.mode === 'strict') {
    // Listed items first, then unlisted (hiding is applied separately)
    return [...beforeItems, ...rest]
  }

  // Inclusive: before + rest + after
  return [...beforeItems, ...rest, ...afterItems]
}

/**
 * Find the markdown file for a section name, handling numeric prefixes.
 * Tries exact match first ("hero.md"), then prefix-based ("1-hero.md").
 *
 * @param {string} pagePath - Directory containing section files
 * @param {string} sectionName - Logical section name (e.g., 'hero')
 * @param {string[]} [cachedFiles] - Pre-read directory listing (optimization)
 * @returns {{ filePath: string, stableName: string, prefix: string|null }|null}
 */
function findSectionFile(pagePath, sectionName, cachedFiles) {
  const exactPath = join(pagePath, `${sectionName}.md`)
  if (existsSync(exactPath)) {
    return { filePath: exactPath, stableName: sectionName, prefix: null }
  }

  const files = cachedFiles || []
  for (const file of files) {
    if (!isMarkdownFile(file)) continue
    const { name } = parse(file)
    const { prefix, name: parsedName } = parseNumericPrefix(name)
    if (parsedName === sectionName) {
      return { filePath: join(pagePath, file), stableName: sectionName, prefix }
    }
  }

  return null
}

/**
 * Extract a direct child's folder name from its route, relative to parentRoute.
 * Returns null for the index page (route === parentRoute) or non-direct-children.
 *
 * @param {string} route - Page route (e.g., '/about')
 * @param {string} parentRoute - Parent route (e.g., '/')
 * @returns {string|null}
 */
function getDirectChildName(route, parentRoute) {
  if (!route || route === parentRoute) return null
  const prefix = parentRoute === '/' ? '/' : parentRoute + '/'
  if (!route.startsWith(prefix)) return null
  const rest = route.slice(prefix.length)
  if (rest.includes('/')) return null
  return rest
}

/**
 * Process a markdown file as a standalone page (folder mode).
 * Creates a page with a single section from the markdown content.
 *
 * @param {string} filePath - Path to markdown file
 * @param {string} fileName - Filename (e.g., "getting-started.md")
 * @param {string} siteRoot - Site root directory for asset resolution
 * @param {string} parentRoute - Parent route (e.g., '/docs')
 * @returns {Promise<Object>} Page data with assets manifest
 */
async function processFileAsPage(filePath, fileName, siteRoot, parentRoute) {
  const { name } = parse(fileName)
  const { prefix, name: stableName } = parseNumericPrefix(name)
  const pageName = stableName || name
  const route = parentRoute === '/' ? `/${pageName}` : `${parentRoute}/${pageName}`

  // Process the markdown as a single section
  const { section, assetCollection, iconCollection } = await processMarkdownFile(
    filePath, '1', siteRoot, pageName
  )

  const fileStat = await stat(filePath)

  return {
    page: {
      route,
      sourcePath: null,
      id: null,
      isIndex: false,
      title: pageName,
      description: '',
      label: null,
      lastModified: fileStat.mtime?.toISOString() || null,
      isDynamic: false,
      paramName: null,
      parentSchema: null,
      version: null,
      versionMeta: null,
      versionScope: null,
      hidden: false,
      hideInHeader: false,
      hideInFooter: false,
      layout: {},
      seo: {
        noindex: false,
        image: null,
        changefreq: null,
        priority: null
      },
      fetch: null,
      sections: [section],
      order: prefix ? parseFloat(prefix) : undefined
    },
    assetCollection,
    iconCollection
  }
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

  // Extract @ component references → insets (mutates doc)
  const insets = extractInsets(proseMirrorContent)

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
    type: type || component || null,  // frontmatter: type > component (legacy)
    preset,
    input,
    params: { ...params, ...props },
    content: proseMirrorContent,
    fetch: parseFetchConfig(resolvedFetch),
    ...(insets.length > 0 ? { insets } : {}),
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

  // Cache directory listing for prefix-based file resolution
  const cachedFiles = await readdir(pagePath)

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

    // Look for the markdown file (exact match or prefix-based, e.g., "hero" → "1-hero.md")
    const found = findSectionFile(pagePath, sectionName, cachedFiles)
    if (!found) {
      console.warn(`[content-collector] Section file not found: ${sectionName}.md`)
      index++
      continue
    }
    const filePath = found.filePath

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
async function processPage(pagePath, pageName, siteRoot, { isIndex = false, parentRoute = '/', parentFetch = null, versionContext = null, layoutName = null } = {}) {
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
  const sectionsParsed = Array.isArray(sectionsConfig) ? parseWildcardArray(sectionsConfig) : null

  if (sectionsConfig === undefined || sectionsConfig === '*' || sectionsParsed?.mode === 'all') {
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

  } else if (sectionsParsed?.mode === 'inclusive') {
    // Inclusive: pinned sections + auto-discovered rest via '...' wildcard
    const files = await readdir(pagePath)
    const mdFiles = files.filter(isMarkdownFile).sort(compareFilenames)

    // Build name → file info map from discovered files
    const discoveredMap = new Map()
    for (const file of mdFiles) {
      const { name } = parse(file)
      const { prefix, name: stableName } = parseNumericPrefix(name)
      const key = stableName || name
      if (!discoveredMap.has(key)) {
        discoveredMap.set(key, { file, prefix, stableName: key })
      }
    }

    // Create items with .name property for applyWildcardOrder
    const allItems = [...discoveredMap.keys()].map(name => ({ name }))
    const ordered = applyWildcardOrder(allItems, sectionsParsed)

    // Collect subsection configs from the original array (e.g., { features: [a, b] })
    const subsectionConfigs = new Map()
    for (const item of [...sectionsParsed.before, ...sectionsParsed.after]) {
      if (typeof item === 'object' && item !== null) {
        const keys = Object.keys(item)
        if (keys.length === 1) {
          subsectionConfigs.set(keys[0], item[keys[0]])
        }
      }
    }

    // Process sections in wildcard-expanded order
    const sections = []
    let sectionIndex = 1
    for (const { name } of ordered) {
      const entry = discoveredMap.get(name)
      if (!entry) {
        console.warn(`[content-collector] Section '${name}' not found in ${pagePath}`)
        continue
      }

      const id = String(sectionIndex)
      const { section, assetCollection: sectionAssets, iconCollection: sectionIcons } =
        await processMarkdownFile(join(pagePath, entry.file), id, siteRoot, entry.stableName)
      sections.push(section)
      pageAssetCollection = mergeAssetCollections(pageAssetCollection, sectionAssets)
      pageIconCollection = mergeIconCollections(pageIconCollection, sectionIcons)

      // Track last modified
      const fileStat = await stat(join(pagePath, entry.file))
      if (!lastModified || fileStat.mtime > lastModified) {
        lastModified = fileStat.mtime
      }

      // Process subsections if configured (e.g., { features: [logocloud, stats] })
      const subsections = subsectionConfigs.get(name)
      if (Array.isArray(subsections) && subsections.length > 0) {
        const subResult = await processExplicitSections(subsections, pagePath, siteRoot, id)
        section.subsections = subResult.sections
        pageAssetCollection = mergeAssetCollections(pageAssetCollection, subResult.assetCollection)
        pageIconCollection = mergeIconCollections(pageIconCollection, subResult.iconCollection)
        if (subResult.lastModified && (!lastModified || subResult.lastModified > lastModified)) {
          lastModified = subResult.lastModified
        }
      }

      sectionIndex++
    }

    hierarchicalSections = buildSectionHierarchy(sections)

  } else if (Array.isArray(sectionsConfig) && sectionsConfig.length > 0) {
    // Strict: explicit sections array (only listed sections processed)
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
  const { seo = {}, layout: layoutConfig, ...restConfig } = pageConfig

  // Resolve layout name: page.yml layout (string or object.name) > inherited from parent > null
  const pageLayoutName = typeof layoutConfig === 'string' ? layoutConfig
    : layoutConfig?.name || null
  const resolvedLayoutName = pageLayoutName || layoutName || null

  // Layout panel visibility (from object form of layout config)
  const layoutObj = typeof layoutConfig === 'object' && layoutConfig !== null ? layoutConfig : {}

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

      // Layout options (named layout + per-page overrides)
      layout: {
        ...(resolvedLayoutName ? { name: resolvedLayoutName } : {}),
        ...(layoutObj.hide ? { hide: layoutObj.hide } : {}),
        ...(layoutObj.params ? { params: layoutObj.params } : {}),
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

  // 1. Explicit pages array - first non-'...' item is index
  if (Array.isArray(pagesArray) && pagesArray.length > 0) {
    const parsed = parseWildcardArray(pagesArray)
    if (parsed && parsed.before.length > 0) {
      return extractItemName(parsed.before[0])
    }
    // Array starts with '...' or is ['...'] — no index from pages, fall through
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
 * @param {Object} orderConfig - { pages: [...], index: 'name', order: [...] } from parent's config
 * @param {Object} parentFetch - Parent page's fetch config (for dynamic child routes)
 * @param {Object} versionContext - Version context from parent { version, versionMeta }
 * @param {string} contentMode - 'sections' (default) or 'pages' (md files are child pages)
 * @returns {Promise<Object>} { pages, assetCollection, iconCollection, notFound, versionedScopes }
 */
async function collectPagesRecursive(dirPath, parentRoute, siteRoot, orderConfig = {}, parentFetch = null, versionContext = null, contentMode = 'sections', mounts = null, parentLayoutName = null) {
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

  // First pass: discover all page folders and read their config
  const pageFolders = []
  for (const entry of entries) {
    if (isIgnoredFolder(entry)) continue // Skip _prefixed folders
    const entryPath = join(dirPath, entry)
    const stats = await stat(entryPath)
    if (!stats.isDirectory()) continue

    // Read folder.yml or page.yml to determine mode and get config
    const { config: dirConfig, mode: dirMode } = await readFolderConfig(entryPath, contentMode)
    const numericOrder = typeof dirConfig.order === 'number' ? dirConfig.order : undefined

    // Extract layout name from folder config (folder.yml layout: or page.yml layout:)
    const folderLayout = typeof dirConfig.layout === 'string' ? dirConfig.layout
      : dirConfig.layout?.name || null

    pageFolders.push({
      name: entry,
      path: entryPath,
      order: numericOrder,
      dirConfig,
      dirMode,
      childOrderConfig: {
        pages: dirConfig.pages,
        index: dirConfig.index
      },
      childLayoutName: folderLayout
    })
  }

  // Inject virtual entries for mounts without physical directories
  if (mounts) {
    for (const [routeSegment, mountPath] of mounts) {
      if (!pageFolders.some(f => f.name === routeSegment)) {
        const { config: mountConfig } = await readFolderConfig(mountPath, 'pages')
        const mountLayout = typeof mountConfig.layout === 'string' ? mountConfig.layout
          : mountConfig.layout?.name || null
        pageFolders.push({
          name: routeSegment,
          path: mountPath,
          order: typeof mountConfig.order === 'number' ? mountConfig.order : undefined,
          dirConfig: { title: mountConfig.title || routeSegment, ...mountConfig },
          dirMode: 'pages',
          childOrderConfig: {
            pages: mountConfig.pages,
            index: mountConfig.index
          },
          childLayoutName: mountLayout
        })
      }
    }
  }

  // Sort page folders by order (ascending), then alphabetically
  // Pages without explicit order come after ordered pages (order ?? Infinity)
  pageFolders.sort((a, b) => {
    const orderA = a.order ?? Infinity
    const orderB = b.order ?? Infinity
    if (orderA !== orderB) return orderA - orderB
    return a.name.localeCompare(b.name)
  })

  // Apply ordering: pages: (wildcard-aware) > order: [array] (backward compat) > default
  let orderedFolders
  let strictPageNames = null

  const pagesParsed = Array.isArray(orderConfig?.pages) ? parseWildcardArray(orderConfig.pages) : null

  if (pagesParsed && pagesParsed.mode !== 'all') {
    orderedFolders = applyWildcardOrder(pageFolders, pagesParsed)
    if (pagesParsed.mode === 'strict') {
      strictPageNames = new Set(pagesParsed.before.map(extractItemName).filter(Boolean))
    }
  } else {
    orderedFolders = pageFolders
  }

  // Check if this directory contains version folders (versioned section)
  const folderNames = orderedFolders.map(f => f.name)
  const detectedVersions = detectVersions(folderNames)

  // If versioned section, handle version folders specially (always page mode)
  if (detectedVersions && !versionContext) {
    const parentConfig = await readYamlFile(join(dirPath, 'page.yml'))
    const versionMeta = buildVersionMetadata(detectedVersions, parentConfig)
    versionedScopes.set(parentRoute, versionMeta)

    for (const folder of orderedFolders) {
      const { name: entry, path: entryPath, childOrderConfig, childLayoutName } = folder

      if (isVersionFolder(entry)) {
        const versionInfo = versionMeta.versions.find(v => v.id === entry)
        const isLatest = versionInfo?.latest || false
        const versionRoute = isLatest
          ? parentRoute
          : parentRoute === '/'
            ? `/${entry}`
            : `${parentRoute}/${entry}`

        const subResult = await collectPagesRecursive(
          entryPath, versionRoute, siteRoot, childOrderConfig, parentFetch,
          { version: versionInfo, versionMeta, scope: parentRoute },
          'sections', null, childLayoutName || parentLayoutName
        )

        pages.push(...subResult.pages)
        assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
        iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
        for (const [scope, meta] of subResult.versionedScopes) {
          versionedScopes.set(scope, meta)
        }
      } else {
        const result = await processPage(entryPath, entry, siteRoot, {
          isIndex: false, parentRoute, parentFetch,
          layoutName: childLayoutName || parentLayoutName
        })
        if (result) {
          pages.push(result.page)
          assetCollection = mergeAssetCollections(assetCollection, result.assetCollection)
          iconCollection = mergeIconCollections(iconCollection, result.iconCollection)
        }
      }
    }

    return { pages, assetCollection, iconCollection, notFound, versionedScopes }
  }

  // --- Pages mode: .md files are child pages ---
  if (contentMode === 'pages') {
    // Collect and process .md files as individual pages
    const mdFiles = entries.filter(isMarkdownFile).sort(compareFilenames)
    const mdPageItems = []

    for (const file of mdFiles) {
      const { name } = parse(file)
      const { name: stableName } = parseNumericPrefix(name)
      const result = await processFileAsPage(join(dirPath, file), file, siteRoot, parentRoute)
      if (result) {
        mdPageItems.push({ name: stableName || name, result })
      }
    }

    // Apply ordering: pages: (wildcard-aware) > order: [array] (backward compat) > default
    let orderedMdPages
    let strictPageNamesFM = null

    const pagesParsedFM = Array.isArray(orderConfig?.pages) ? parseWildcardArray(orderConfig.pages) : null

    if (pagesParsedFM && pagesParsedFM.mode !== 'all') {
      orderedMdPages = applyWildcardOrder(mdPageItems, pagesParsedFM)
      if (pagesParsedFM.mode === 'strict') {
        strictPageNamesFM = new Set(pagesParsedFM.before.map(extractItemName).filter(Boolean))
      }
    } else {
      orderedMdPages = mdPageItems
    }

    // In folder mode, determine index: pages: first item, or explicit index:
    let indexName = null
    if (pagesParsedFM && pagesParsedFM.before.length > 0) {
      indexName = extractItemName(pagesParsedFM.before[0])
    } else {
      indexName = orderConfig?.index || null
    }

    // Add md-file-pages
    for (const { name, result } of orderedMdPages) {
      const { page, assetCollection: pageAssets, iconCollection: pageIcons } = result
      assetCollection = mergeAssetCollections(assetCollection, pageAssets)
      iconCollection = mergeIconCollections(iconCollection, pageIcons)

      // Handle index: promote to parent route
      if (name === indexName) {
        page.isIndex = true
        page.sourcePath = page.route
        page.route = parentRoute
      }

      // Inherit layout name from parent (folder.yml or site.yml cascade)
      if (parentLayoutName && !page.layout.name) {
        page.layout.name = parentLayoutName
      }

      pages.push(page)
    }

    // Process subdirectories
    for (const folder of orderedFolders) {
      const { name: entry, path: entryPath, dirConfig, dirMode, childOrderConfig, childLayoutName } = folder
      const isIndex = entry === indexName
      const effectiveLayout = childLayoutName || parentLayoutName

      if (dirMode === 'sections') {
        // Subdirectory overrides to page mode — process normally
        const result = await processPage(entryPath, entry, siteRoot, {
          isIndex, parentRoute, parentFetch, versionContext,
          layoutName: effectiveLayout
        })

        if (result) {
          const { page, assetCollection: pageAssets, iconCollection: pageIcons } = result
          assetCollection = mergeAssetCollections(assetCollection, pageAssets)
          iconCollection = mergeIconCollections(iconCollection, pageIcons)
          pages.push(page)

          // Recurse into subdirectories (page mode)
          const childDirPath = mounts?.get(entry) || entryPath
          const childParentRoute = isIndex ? parentRoute : page.route
          const childFetch = page.fetch || parentFetch
          const subResult = await collectPagesRecursive(childDirPath, childParentRoute, siteRoot, childOrderConfig, childFetch, versionContext, 'sections', null, effectiveLayout)
          pages.push(...subResult.pages)
          assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
          iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
          for (const [scope, meta] of subResult.versionedScopes) {
            versionedScopes.set(scope, meta)
          }
        }
      } else {
        // Container directory in folder mode — create minimal page, recurse
        const containerRoute = isIndex
          ? parentRoute
          : parentRoute === '/' ? `/${entry}` : `${parentRoute}/${entry}`

        // Resolve layout for container page
        const containerLayoutObj = typeof dirConfig.layout === 'object' && dirConfig.layout !== null ? dirConfig.layout : {}

        const containerPage = {
          route: containerRoute,
          sourcePath: isIndex ? (parentRoute === '/' ? `/${entry}` : `${parentRoute}/${entry}`) : null,
          id: dirConfig.id || null,
          isIndex,
          title: dirConfig.title || entry,
          description: dirConfig.description || '',
          label: dirConfig.label || null,
          lastModified: null,
          isDynamic: false,
          paramName: null,
          parentSchema: null,
          version: versionContext?.version || null,
          versionMeta: versionContext?.versionMeta || null,
          versionScope: versionContext?.scope || null,
          hidden: dirConfig.hidden || false,
          hideInHeader: dirConfig.hideInHeader || false,
          hideInFooter: dirConfig.hideInFooter || false,
          layout: {
            ...(effectiveLayout ? { name: effectiveLayout } : {}),
            ...(containerLayoutObj.hide ? { hide: containerLayoutObj.hide } : {}),
            ...(containerLayoutObj.params ? { params: containerLayoutObj.params } : {}),
          },
          seo: {
            noindex: dirConfig.seo?.noindex || false,
            image: dirConfig.seo?.image || null,
            changefreq: dirConfig.seo?.changefreq || null,
            priority: dirConfig.seo?.priority || null
          },
          fetch: null,
          sections: [],
          order: typeof dirConfig.order === 'number' ? dirConfig.order : undefined
        }

        pages.push(containerPage)

        // Recurse in folder mode
        const childDirPath = mounts?.get(entry) || entryPath
        const subResult = await collectPagesRecursive(childDirPath, containerRoute, siteRoot, childOrderConfig, parentFetch, versionContext, 'pages', null, effectiveLayout)
        pages.push(...subResult.pages)
        assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
        iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
        for (const [scope, meta] of subResult.versionedScopes) {
          versionedScopes.set(scope, meta)
        }
      }
    }

    // When pages: is strict (no '...'), hide unlisted direct children from navigation
    if (strictPageNamesFM) {
      for (const page of pages) {
        const childName = getDirectChildName(page.route, parentRoute)
          || (page.sourcePath ? getDirectChildName(page.sourcePath, parentRoute) : null)
        if (childName && !strictPageNamesFM.has(childName) && !page.hidden) {
          page.hidden = true
        }
      }
    }

    return { pages, assetCollection, iconCollection, notFound, versionedScopes }
  }

  // --- Sections mode (default): existing behavior ---

  // Determine which page is the index for this level
  // A directory with its own .md content is a real page, not a container —
  // never promote a child as index, even if explicit config says so
  const hasExplicitOrder = orderConfig?.index || (Array.isArray(orderConfig?.pages) && orderConfig.pages.length > 0)
  const hasMdContent = entries.some(e => isMarkdownFile(e))
  const indexPageName = hasMdContent ? null : determineIndexPage(orderConfig, orderedFolders)

  // Second pass: process each page folder
  for (const folder of orderedFolders) {
    const { name: entry, path: entryPath, dirConfig, dirMode, childOrderConfig, childLayoutName } = folder
    const isIndex = entry === indexPageName
    const effectiveLayout = childLayoutName || parentLayoutName

    if (dirMode === 'pages') {
      // Child directory switches to folder mode (has folder.yml) —
      // create container page with empty sections, recurse in folder mode
      const containerRoute = isIndex
        ? parentRoute
        : parentRoute === '/' ? `/${entry}` : `${parentRoute}/${entry}`

      // Resolve layout for container page
      const containerLayoutObj = typeof dirConfig.layout === 'object' && dirConfig.layout !== null ? dirConfig.layout : {}

      const containerPage = {
        route: containerRoute,
        sourcePath: isIndex ? (parentRoute === '/' ? `/${entry}` : `${parentRoute}/${entry}`) : null,
        id: dirConfig.id || null,
        isIndex,
        title: dirConfig.title || entry,
        description: dirConfig.description || '',
        label: dirConfig.label || null,
        lastModified: null,
        isDynamic: false,
        paramName: null,
        parentSchema: null,
        version: versionContext?.version || null,
        versionMeta: versionContext?.versionMeta || null,
        versionScope: versionContext?.scope || null,
        hidden: dirConfig.hidden || false,
        hideInHeader: dirConfig.hideInHeader || false,
        hideInFooter: dirConfig.hideInFooter || false,
        layout: {
          ...(effectiveLayout ? { name: effectiveLayout } : {}),
          ...(containerLayoutObj.hide ? { hide: containerLayoutObj.hide } : {}),
          ...(containerLayoutObj.params ? { params: containerLayoutObj.params } : {}),
        },
        seo: {
          noindex: dirConfig.seo?.noindex || false,
          image: dirConfig.seo?.image || null,
          changefreq: dirConfig.seo?.changefreq || null,
          priority: dirConfig.seo?.priority || null
        },
        fetch: null,
        sections: [],
        order: typeof dirConfig.order === 'number' ? dirConfig.order : undefined
      }

      if (parentRoute === '/' && entry === '404') {
        notFound = containerPage
      } else {
        pages.push(containerPage)
      }

      const childDirPath = mounts?.get(entry) || entryPath
      const subResult = await collectPagesRecursive(childDirPath, containerRoute, siteRoot, childOrderConfig, parentFetch, versionContext, 'pages', null, effectiveLayout)
      pages.push(...subResult.pages)
      assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
      iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
      for (const [scope, meta] of subResult.versionedScopes) {
        versionedScopes.set(scope, meta)
      }
    } else {
      // Sections mode — process directory as a page (existing behavior)
      const result = await processPage(entryPath, entry, siteRoot, {
        isIndex, parentRoute, parentFetch, versionContext,
        layoutName: effectiveLayout
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
          const childDirPath = mounts?.get(entry) || entryPath
          const childParentRoute = isIndex
            ? (hasExplicitOrder ? parentRoute : (page.sourcePath || page.route))
            : page.route
          const childFetch = page.fetch || parentFetch
          const subResult = await collectPagesRecursive(childDirPath, childParentRoute, siteRoot, childOrderConfig, childFetch, versionContext, dirMode, null, effectiveLayout)
          pages.push(...subResult.pages)
          assetCollection = mergeAssetCollections(assetCollection, subResult.assetCollection)
          iconCollection = mergeIconCollections(iconCollection, subResult.iconCollection)
          for (const [scope, meta] of subResult.versionedScopes) {
            versionedScopes.set(scope, meta)
          }
        }
      }
    }
  }

  // When pages: is strict (no '...'), hide unlisted direct children from navigation
  if (strictPageNames) {
    for (const page of pages) {
      const childName = getDirectChildName(page.route, parentRoute)
        || (page.sourcePath ? getDirectChildName(page.sourcePath, parentRoute) : null)
      if (childName && !strictPageNames.has(childName) && !page.hidden) {
        page.hidden = true
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
 * Collect areas from a single directory (general named areas, not hardcoded).
 *
 * Supports two forms per area:
 *   - Folder: dir/header/ (directory with .md files, like a page)
 *   - File shorthand: dir/header.md (single markdown file)
 * Folder takes priority when both exist.
 *
 * @param {string} dir - Directory to scan for area files
 * @param {string} siteRoot - Path to site root
 * @param {string} routePrefix - Route prefix for area pages (e.g., '/layout' or '/layout/marketing')
 * @returns {Promise<Object>} Map of areaName -> page data
 */
async function collectAreasFromDir(dir, siteRoot, routePrefix = '/layout') {
  const result = {}

  if (!existsSync(dir)) return result

  const entries = await readdir(dir, { withFileTypes: true })

  // Track which area names we've already processed (folder form takes priority)
  const processed = new Set()

  // First pass: directories (folder form, higher priority)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue

    const areaName = entry.name
    const entryPath = join(dir, areaName)
    const pageResult = await processPage(entryPath, areaName, siteRoot, {
      isIndex: false,
      parentRoute: routePrefix
    })
    if (pageResult) {
      result[areaName] = pageResult.page
      processed.add(areaName)
    }
  }

  // Second pass: markdown file shorthand (only if not already processed as folder)
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue

    const areaName = entry.name.replace('.md', '')
    if (processed.has(areaName)) continue

    const filePath = join(dir, entry.name)
    const { section } = await processMarkdownFile(filePath, '1', siteRoot, areaName)
    result[areaName] = {
      route: `${routePrefix}/${areaName}`,
      title: areaName.charAt(0).toUpperCase() + areaName.slice(1),
      description: '',
      layout: {},
      sections: [section]
    }
  }

  return result
}

/**
 * Check if a directory looks like a named layout (contains area-like .md files or area subdirs)
 * vs an area in folder form (contains section content processed by processPage).
 *
 * Heuristic: if a directory contains .md files at the top level AND no page.yml,
 * it's a named layout (those .md files are its area definitions).
 * If it has page.yml or looks like a page directory, it's an area folder.
 *
 * @param {string} dirPath - Path to the directory
 * @returns {Promise<boolean>} True if this looks like a named layout directory
 */
async function isNamedLayoutDir(dirPath) {
  // If it has page.yml, it's an area folder (processPage will handle it)
  if (existsSync(join(dirPath, 'page.yml'))) return false

  const entries = await readdir(dirPath)
  // If directory contains .md files but no page.yml, it's a named layout
  return entries.some(e => e.endsWith('.md') && !e.startsWith('_') && !e.startsWith('.'))
}

/**
 * Collect layout areas from the layout/ directory, including named layout subdirectories.
 *
 * Root-level .md files and area directories form the "default" layout's areas.
 * Subdirectories that themselves contain .md files (without page.yml) are named layouts,
 * each with its own set of areas.
 *
 * @param {string} layoutDir - Path to layout directory
 * @param {string} siteRoot - Path to site root
 * @returns {Promise<Object>} { layouts }
 */
async function collectLayouts(layoutDir, siteRoot) {
  if (!existsSync(layoutDir)) {
    return { layouts: null }
  }

  const entries = await readdir(layoutDir, { withFileTypes: true })

  // Separate root-level entries into:
  // 1. Area .md files (for default layout)
  // 2. Area directories (for default layout) vs named layout directories
  const defaultAreaFiles = []
  const defaultAreaDirs = []
  const namedLayoutDirs = []

  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue

    if (entry.isFile() && entry.name.endsWith('.md')) {
      defaultAreaFiles.push(entry)
    } else if (entry.isDirectory()) {
      const dirPath = join(layoutDir, entry.name)
      if (await isNamedLayoutDir(dirPath)) {
        namedLayoutDirs.push(entry)
      } else {
        defaultAreaDirs.push(entry)
      }
    }
  }

  // Collect default layout areas
  const defaultAreas = await collectAreasFromDir(layoutDir, siteRoot, '/layout')
  // Remove any named layout directories that got collected as areas
  for (const dir of namedLayoutDirs) {
    delete defaultAreas[dir.name]
  }

  // Collect named layout areas
  const namedLayouts = {}
  for (const entry of namedLayoutDirs) {
    const subdir = join(layoutDir, entry.name)
    namedLayouts[entry.name] = await collectAreasFromDir(subdir, siteRoot, `/layout/${entry.name}`)
  }

  const hasDefaultAreas = Object.keys(defaultAreas).length > 0
  const hasNamedLayouts = Object.keys(namedLayouts).length > 0

  if (!hasDefaultAreas && !hasNamedLayouts) {
    return { layouts: null }
  }

  // Always use the layouts object format (general areas)
  const layouts = {}
  if (hasDefaultAreas) {
    layouts.default = defaultAreas
  }
  Object.assign(layouts, namedLayouts)

  return { layouts }
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

  // Read site config and raw theme config
  const siteConfig = await readYamlFile(join(sitePath, 'site.yml'))

  // Resolve content paths from site.yml paths: group, defaulting to standard locations
  const pagesPath = siteConfig.paths?.pages
    ? resolve(sitePath, siteConfig.paths.pages)
    : join(sitePath, 'pages')

  const mounts = resolveMounts(siteConfig.paths, sitePath, pagesPath)

  const layoutPath = siteConfig.paths?.layout
    ? resolve(sitePath, siteConfig.paths.layout)
    : join(sitePath, 'layout')
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

  // Determine root content mode from folder.yml/page.yml presence in pages directory
  const { mode: rootContentMode } = await readFolderConfig(pagesPath, 'sections')

  // Collect layout areas from layout/ directory (including named layout subdirectories)
  const { layouts } = await collectLayouts(layoutPath, sitePath)

  // Site-level layout name (from site.yml layout: field)
  const siteLayoutName = typeof siteConfig.layout === 'string' ? siteConfig.layout
    : siteConfig.layout?.name || null

  // Recursively collect all pages
  const { pages, assetCollection, iconCollection, notFound, versionedScopes } =
    await collectPagesRecursive(pagesPath, '/', sitePath, siteOrderConfig, null, null, rootContentMode, mounts, siteLayoutName)

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

  // Page order is determined by per-level sorting during collection:
  // 1. Numeric 'order' property in page.yml (lower first, within each level)
  // 2. pages: array in parent config (wildcard-aware, overrides numeric order)
  // 3. order: [array] in parent config (non-strict, backward compat)
  // No global re-sort — collection order is authoritative.

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
    // Layout area sets: { default: { header: page, footer: page, ... }, marketing: { ... } }
    layouts,
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

// Exported for testing
export {
  extractItemName,
  parseWildcardArray,
  applyWildcardOrder,
  getDirectChildName,
  extractInsets
}

export default collectSiteContent
