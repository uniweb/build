/**
 * Schema Discovery and Loading Utilities
 *
 * Discovers component meta files and loads them for schema.json generation.
 * Schema data is for editor-time only, not runtime.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

// Component meta file name
const META_FILE_NAME = 'meta.js'

// Foundation config file name
const FOUNDATION_FILE_NAME = 'foundation.js'

// Default paths to scan for content interfaces (relative to srcDir)
// sections/ is the primary convention; components/ supported for backward compatibility
const DEFAULT_COMPONENT_PATHS = ['sections', 'components']

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
    return {
      ...module.default,
      vars: module.vars || module.default?.vars,
      Layout: module.Layout || module.default?.Layout,
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
 * Discover components in a single path
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string} relativePath - Path relative to srcDir (e.g., 'components' or 'components/sections')
 * @returns {Object} Map of componentName -> { name, path, ...meta }
 */
async function discoverComponentsInPath(srcDir, relativePath) {
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
      if (result.meta.exposed === false) {
        continue
      }

      components[entry.name] = {
        name: entry.name,
        path: join(relativePath, entry.name), // e.g., 'components/Hero' or 'components/sections/Hero'
        ...result.meta,
      }
    }
  }

  return components
}

/**
 * Discover all section types in a foundation
 *
 * Scans directories for folders containing meta.js files.
 * Each discovered folder becomes a section type — a component that content
 * authors can reference by name in frontmatter (e.g., `type: Hero`).
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string[]} [componentPaths] - Paths to scan for section types (relative to srcDir).
 *                                      Default: ['sections', 'components']
 * @returns {Object} Map of sectionTypeName -> { name, path, ...meta }
 */
export async function discoverComponents(srcDir, componentPaths = DEFAULT_COMPONENT_PATHS) {
  const components = {}

  for (const relativePath of componentPaths) {
    const found = await discoverComponentsInPath(srcDir, relativePath)

    for (const [name, meta] of Object.entries(found)) {
      if (components[name]) {
        // Component already found in an earlier path - skip (first wins)
        console.warn(`Warning: Component "${name}" found in multiple paths. Using ${components[name].path}, ignoring ${meta.path}`)
        continue
      }
      components[name] = meta
    }
  }

  return components
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
 * @param {string[]} [componentPaths] - Paths to search for components
 */
export async function buildSchema(srcDir, componentPaths) {
  // Load identity from package.json
  const identity = await loadPackageJson(srcDir)

  // Load configuration from foundation.js
  const foundationConfig = await loadFoundationConfig(srcDir)

  // Discover components
  const components = await discoverComponents(srcDir, componentPaths)

  return {
    // Merge identity and config - identity fields take precedence
    _self: {
      ...foundationConfig,
      ...identity,
    },
    ...components,
  }
}

/**
 * Get list of section type names
 *
 * @param {string} srcDir - Source directory
 * @param {string[]} [componentPaths] - Paths to scan for section types
 */
export async function getExposedComponents(srcDir, componentPaths) {
  const components = await discoverComponents(srcDir, componentPaths)
  return Object.keys(components)
}
