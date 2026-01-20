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
 * Discover all exposed components in a foundation
 * Returns map of componentName -> meta
 */
export async function discoverComponents(srcDir) {
  const componentsDir = join(srcDir, 'components')

  if (!existsSync(componentsDir)) {
    return {}
  }

  const entries = await readdir(componentsDir, { withFileTypes: true })
  const components = {}

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const componentDir = join(componentsDir, entry.name)
    const result = await loadComponentMeta(componentDir)

    if (result && result.meta) {
      // Check if explicitly not exposed
      if (result.meta.exposed === false) {
        continue
      }

      components[entry.name] = {
        name: entry.name,
        ...result.meta,
      }
    }
  }

  return components
}

/**
 * Build complete schema for a foundation
 * Returns { _self: foundationMeta, ComponentName: componentMeta, ... }
 */
export async function buildSchema(srcDir) {
  const foundationMeta = await loadFoundationMeta(srcDir)
  const components = await discoverComponents(srcDir)

  return {
    _self: foundationMeta,
    ...components,
  }
}

/**
 * Get list of exposed component names
 */
export async function getExposedComponents(srcDir) {
  const components = await discoverComponents(srcDir)
  return Object.keys(components)
}
