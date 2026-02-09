/**
 * Schema Discovery and Loading Utilities
 *
 * Discovers section type meta files and loads them for schema.json generation.
 * Schema data is for editor-time only, not runtime.
 *
 * Discovery rules:
 * - sections/ root: bare files and folders are addressable by default (implicit empty meta)
 * - sections/ nested: meta.js required for addressability
 * - Additional paths (via config): meta.js required for addressability
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inferTitle } from './utils/infer-title.js'

// Component meta file name
const META_FILE_NAME = 'meta.js'

// Foundation config file name
const FOUNDATION_FILE_NAME = 'foundation.js'

// Default paths to scan for section types (relative to srcDir)
const DEFAULT_SECTION_PATHS = ['sections']

// Extensions recognized as component entry files
const COMPONENT_EXTENSIONS = new Set(['.jsx', '.tsx', '.js', '.ts'])

// The primary sections path where relaxed discovery applies
const SECTIONS_PATH = 'sections'

// The layouts path where layout components are discovered
const LAYOUTS_PATH = 'layouts'

/**
 * Load a meta.js file via dynamic import
 */
async function loadMetaFile(filePath) {
  const fileUrl = pathToFileURL(filePath).href
  const module = await import(fileUrl)
  return module.default
}

/**
 * Find and load meta file for a component directory
 * Returns null if no meta file found
 */
export async function loadComponentMeta(componentDir) {
  const filePath = join(componentDir, META_FILE_NAME)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const meta = await loadMetaFile(filePath)
    return { meta, fileName: META_FILE_NAME, filePath }
  } catch (error) {
    console.warn(`Warning: Failed to load ${filePath}:`, error.message)
    return null
  }
}

/**
 * Load package.json from foundation root
 * Extracts identity fields: name, version, description
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @returns {Object} Identity fields from package.json
 */
export async function loadPackageJson(srcDir) {
  // package.json is in the foundation root (parent of srcDir)
  const foundationRoot = dirname(srcDir)
  const packagePath = join(foundationRoot, 'package.json')

  if (!existsSync(packagePath)) {
    return {}
  }

  try {
    const content = await readFile(packagePath, 'utf-8')
    const pkg = JSON.parse(content)

    // Extract only identity fields for schema
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
    }
  } catch (error) {
    console.warn(`Warning: Failed to load package.json:`, error.message)
    return {}
  }
}

/**
 * Load foundation-level config file (foundation.js)
 *
 * Contains foundation-wide configuration:
 * - vars: CSS custom properties sites can override
 * - Layout: Custom layout component
 * - Future: providers, middleware, etc.
 */
export async function loadFoundationConfig(srcDir) {
  const filePath = join(srcDir, FOUNDATION_FILE_NAME)
  if (!existsSync(filePath)) {
    return {}
  }
  try {
    const module = await import(pathToFileURL(filePath).href)
    // Support both default export and named exports
    // Note: Layout/layouts no longer read from foundation.js — layouts come from src/layouts/ discovery
    return {
      ...module.default,
      vars: module.vars || module.default?.vars,
      defaultLayout: module.default?.defaultLayout,
    }
  } catch (error) {
    console.warn(`Warning: Failed to load foundation config ${filePath}:`, error.message)
    return {}
  }
}

/**
 * @deprecated Use loadFoundationConfig instead
 */
export async function loadFoundationMeta(srcDir) {
  return loadFoundationConfig(srcDir)
}

/**
 * Check if a filename looks like a PascalCase component (starts with uppercase)
 */
function isComponentFileName(name) {
  return /^[A-Z]/.test(name)
}

/**
 * Check if a name is a valid layout identifier.
 * Layout names are lowercase identifiers (e.g., 'docs', 'marketing')
 * but PascalCase is also accepted for backward compatibility.
 * Skips private names (leading _ or .).
 */
function isLayoutName(name) {
  return /^[a-zA-Z]/.test(name)
}

/**
 * Check if a directory has a valid entry file (Name.ext or index.ext)
 */
function hasEntryFile(dirPath, dirName) {
  for (const ext of ['.jsx', '.tsx', '.js', '.ts']) {
    if (existsSync(join(dirPath, `${dirName}${ext}`))) return true
    if (existsSync(join(dirPath, `index${ext}`))) return true
  }
  return false
}

/**
 * Create an implicit empty meta for a section type discovered without meta.js
 */
function createImplicitMeta(name) {
  return { title: inferTitle(name) }
}

/**
 * Build a component entry with title inference applied
 */
function buildComponentEntry(name, relativePath, meta) {
  const entry = {
    name,
    path: relativePath,
    ...meta,
  }
  // Apply title inference if meta has no explicit title
  if (!entry.title) {
    entry.title = inferTitle(name)
  }
  return entry
}

/**
 * Discover section types in sections/ with relaxed rules
 *
 * Root level: bare files and folders are addressable by default.
 * Nested levels: meta.js required for addressability.
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string} sectionsRelPath - Relative path to sections dir (e.g., 'sections')
 */
async function discoverSectionsInPath(srcDir, sectionsRelPath) {
  const fullPath = join(srcDir, sectionsRelPath)

  if (!existsSync(fullPath)) {
    return {}
  }

  const entries = await readdir(fullPath, { withFileTypes: true })
  const components = {}

  // Collect names from both files and directories to detect collisions
  const fileNames = new Set()
  const dirNames = new Set()

  for (const entry of entries) {
    const ext = extname(entry.name)
    if (entry.isFile() && COMPONENT_EXTENSIONS.has(ext)) {
      const name = basename(entry.name, ext)
      if (isComponentFileName(name)) {
        fileNames.add(name)
      }
    } else if (entry.isDirectory()) {
      dirNames.add(entry.name)
    }
  }

  // Check for name collisions (e.g., Hero.jsx AND Hero/)
  for (const name of fileNames) {
    if (dirNames.has(name)) {
      throw new Error(
        `Name collision in ${sectionsRelPath}/: both "${name}.jsx" (or similar) and "${name}/" exist. ` +
        `Use one or the other, not both.`
      )
    }
  }

  // Discover bare files at root
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (!COMPONENT_EXTENSIONS.has(ext)) continue
    const name = basename(entry.name, ext)
    if (!isComponentFileName(name)) continue

    const meta = createImplicitMeta(name)
    components[name] = {
      ...buildComponentEntry(name, sectionsRelPath, meta),
      // Bare file: the entry file IS the file itself (not inside a subdirectory)
      entryFile: entry.name,
    }
  }

  // Discover directories at root
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isComponentFileName(entry.name)) continue

    const dirPath = join(fullPath, entry.name)
    const relativePath = join(sectionsRelPath, entry.name)
    const result = await loadComponentMeta(dirPath)

    if (result && result.meta) {
      // Has meta.js — use explicit meta
      if (result.meta.hidden) continue
      components[entry.name] = buildComponentEntry(entry.name, relativePath, result.meta)
    } else if (hasEntryFile(dirPath, entry.name)) {
      // No meta.js but has entry file — implicit section type at root
      components[entry.name] = buildComponentEntry(entry.name, relativePath, createImplicitMeta(entry.name))
    }

    // Recurse into subdirectories for nested section types (meta.js required)
    await discoverNestedSections(srcDir, dirPath, relativePath, components)
  }

  return components
}

/**
 * Discover layout components in src/layouts/ with relaxed rules
 *
 * Same discovery pattern as sections: root-level files and directories
 * are addressable by default. No recursion — layouts are flat.
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string} layoutsRelPath - Relative path to layouts dir (e.g., 'layouts')
 * @returns {Object} Map of layoutName -> { name, path, ...meta }
 */
export async function discoverLayoutsInPath(srcDir, layoutsRelPath = LAYOUTS_PATH) {
  const fullPath = join(srcDir, layoutsRelPath)

  if (!existsSync(fullPath)) {
    return {}
  }

  const entries = await readdir(fullPath, { withFileTypes: true })
  const layouts = {}

  // Collect names from both files and directories to detect collisions
  const fileNames = new Set()
  const dirNames = new Set()

  for (const entry of entries) {
    const ext = extname(entry.name)
    if (entry.isFile() && COMPONENT_EXTENSIONS.has(ext)) {
      const name = basename(entry.name, ext)
      if (isLayoutName(name)) {
        fileNames.add(name)
      }
    } else if (entry.isDirectory()) {
      if (isLayoutName(entry.name)) {
        dirNames.add(entry.name)
      }
    }
  }

  // Check for name collisions (e.g., docs.jsx AND docs/)
  for (const name of fileNames) {
    if (dirNames.has(name)) {
      throw new Error(
        `Name collision in ${layoutsRelPath}/: both "${name}.jsx" (or similar) and "${name}/" exist. ` +
        `Use one or the other, not both.`
      )
    }
  }

  // Discover bare files at root
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (!COMPONENT_EXTENSIONS.has(ext)) continue
    const name = basename(entry.name, ext)
    if (!isLayoutName(name)) continue

    const meta = createImplicitMeta(name)
    layouts[name] = {
      ...buildComponentEntry(name, layoutsRelPath, meta),
      entryFile: entry.name,
    }
  }

  // Discover directories at root (no recursion for layouts)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isLayoutName(entry.name)) continue

    const dirPath = join(fullPath, entry.name)
    const relativePath = join(layoutsRelPath, entry.name)
    const result = await loadComponentMeta(dirPath)

    if (result && result.meta) {
      if (result.meta.hidden) continue
      layouts[entry.name] = buildComponentEntry(entry.name, relativePath, result.meta)
    } else if (hasEntryFile(dirPath, entry.name)) {
      layouts[entry.name] = buildComponentEntry(entry.name, relativePath, createImplicitMeta(entry.name))
    }
  }

  return layouts
}

/**
 * Recursively discover nested section types that have meta.js
 *
 * @param {string} srcDir - Source directory
 * @param {string} parentFullPath - Absolute path to parent directory
 * @param {string} parentRelPath - Relative path from srcDir to parent
 * @param {Object} components - Accumulator for discovered components
 */
async function discoverNestedSections(srcDir, parentFullPath, parentRelPath, components) {
  let entries
  try {
    entries = await readdir(parentFullPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dirPath = join(parentFullPath, entry.name)
    const relativePath = join(parentRelPath, entry.name)
    const result = await loadComponentMeta(dirPath)

    if (result && result.meta) {
      if (result.meta.hidden) continue
      components[entry.name] = buildComponentEntry(entry.name, relativePath, result.meta)
    }

    // Continue recursing regardless — deeper levels may have meta.js
    await discoverNestedSections(srcDir, dirPath, relativePath, components)
  }
}

/**
 * Discover section types in a non-sections path (meta.js required)
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string} relativePath - Path relative to srcDir
 * @returns {Object} Map of sectionTypeName -> { name, path, ...meta }
 */
async function discoverExplicitSectionsInPath(srcDir, relativePath) {
  const fullPath = join(srcDir, relativePath)

  if (!existsSync(fullPath)) {
    return {}
  }

  const entries = await readdir(fullPath, { withFileTypes: true })
  const components = {}

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const componentDir = join(fullPath, entry.name)
    const result = await loadComponentMeta(componentDir)

    if (result && result.meta) {
      // Check if explicitly hidden from discovery
      if (result.meta.hidden) {
        continue
      }

      components[entry.name] = buildComponentEntry(entry.name, join(relativePath, entry.name), result.meta)
    }
  }

  return components
}

/**
 * Discover all section types in a foundation
 *
 * For the 'sections' path: relaxed discovery (bare files and folders at root,
 * meta.js required for nested levels).
 * For other paths: strict discovery (meta.js required).
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string[]} [sectionPaths] - Paths to scan for section types (relative to srcDir).
 *                                    Default: ['sections']
 * @returns {Object} Map of sectionTypeName -> { name, path, ...meta }
 */
export async function discoverComponents(srcDir, sectionPaths = DEFAULT_SECTION_PATHS) {
  const sections = {}

  for (const relativePath of sectionPaths) {
    // Use relaxed discovery for the primary sections path
    const found = relativePath === SECTIONS_PATH
      ? await discoverSectionsInPath(srcDir, relativePath)
      : await discoverExplicitSectionsInPath(srcDir, relativePath)

    for (const [name, meta] of Object.entries(found)) {
      if (sections[name]) {
        // Section type already found in an earlier path — skip (first wins)
        console.warn(`Warning: Section type "${name}" found in multiple paths. Using ${sections[name].path}, ignoring ${meta.path}`)
        continue
      }
      sections[name] = meta
    }
  }

  return sections
}

/**
 * Build complete schema for a foundation
 * Returns { _self: { identity + config }, ComponentName: componentMeta, ... }
 *
 * The _self object contains:
 * - Identity from package.json (name, version, description)
 * - Configuration from foundation.js (vars, Layout, etc.)
 *
 * @param {string} srcDir - Source directory
 * @param {string[]} [sectionPaths] - Paths to scan for section types
 */
export async function buildSchema(srcDir, sectionPaths) {
  // Load identity from package.json
  const identity = await loadPackageJson(srcDir)

  // Load configuration from foundation.js
  const foundationConfig = await loadFoundationConfig(srcDir)

  // Discover section types
  const components = await discoverComponents(srcDir, sectionPaths)

  // Discover layouts from src/layouts/
  const layouts = await discoverLayoutsInPath(srcDir)

  // Determine extension role
  const isExtension = !!foundationConfig.extension

  // Warn if extension declares things it shouldn't
  if (isExtension) {
    if (foundationConfig.vars && Object.keys(foundationConfig.vars).length > 0) {
      console.warn(`Warning: Extension declares theme variables (vars). Extensions don't define theme variables — the primary foundation owns those.`)
    }
    if (Object.keys(layouts).length > 0) {
      console.warn(`Warning: Extension provides layouts. Extensions don't provide layouts — the primary foundation owns the layout.`)
    }
  }

  // Build _self, stripping the raw extension boolean in favor of normalized role
  const { extension: _ext, ...configWithoutExtension } = foundationConfig

  return {
    _self: {
      ...configWithoutExtension,
      ...identity,
      // foundation.js overrides package.json for editor-facing identity
      ...(foundationConfig.name && { name: foundationConfig.name }),
      ...(foundationConfig.description && { description: foundationConfig.description }),
      ...(foundationConfig.defaultLayout && { defaultLayout: foundationConfig.defaultLayout }),
      ...(isExtension && { role: 'extension' }),
    },
    // Layout metadata (full, for editor)
    ...(Object.keys(layouts).length > 0 && { _layouts: layouts }),
    ...components,
  }
}

/**
 * Get list of section type names
 *
 * @param {string} srcDir - Source directory
 * @param {string[]} [sectionPaths] - Paths to scan for section types
 */
export async function getExposedComponents(srcDir, sectionPaths) {
  const components = await discoverComponents(srcDir, sectionPaths)
  return Object.keys(components)
}
