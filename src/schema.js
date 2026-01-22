/**
 * Schema Discovery and Loading Utilities
 *
 * Discovers component meta files and loads them for schema.json generation.
 * Schema data is for editor-time only, not runtime.
 */

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

// Meta file name (standardized to meta.js)
const META_FILE_NAME = 'meta.js'

// Default component paths (relative to srcDir)
const DEFAULT_COMPONENT_PATHS = ['components']

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
 * Load foundation-level meta file
 */
export async function loadFoundationMeta(srcDir) {
  const filePath = join(srcDir, META_FILE_NAME)
  if (!existsSync(filePath)) {
    return {}
  }
  try {
    return await loadMetaFile(filePath)
  } catch (error) {
    console.warn(`Warning: Failed to load foundation meta ${filePath}:`, error.message)
    return {}
  }
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
      // Check if explicitly not exposed
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
 * Discover all exposed components in a foundation
 *
 * @param {string} srcDir - Source directory (e.g., 'src')
 * @param {string[]} [componentPaths] - Paths to search for components (relative to srcDir)
 *                                      Default: ['components']
 * @returns {Object} Map of componentName -> { name, path, ...meta }
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
 * Returns { _self: foundationMeta, ComponentName: componentMeta, ... }
 *
 * @param {string} srcDir - Source directory
 * @param {string[]} [componentPaths] - Paths to search for components
 */
export async function buildSchema(srcDir, componentPaths) {
  const foundationMeta = await loadFoundationMeta(srcDir)
  const components = await discoverComponents(srcDir, componentPaths)

  return {
    _self: foundationMeta,
    ...components,
  }
}

/**
 * Get list of exposed component names
 *
 * @param {string} srcDir - Source directory
 * @param {string[]} [componentPaths] - Paths to search for components
 */
export async function getExposedComponents(srcDir, componentPaths) {
  const components = await discoverComponents(srcDir, componentPaths)
  return Object.keys(components)
}
