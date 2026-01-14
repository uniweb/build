/**
 * Schema Discovery and Loading Utilities
 *
 * Discovers component meta files, loads them, and extracts
 * runtime-relevant configuration.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

// Meta file names in order of preference
const META_FILE_NAMES = ['meta.js', 'config.js', 'config.yml', 'meta.yml']

// Keys that should be extracted for runtime (embedded in foundation.js)
const RUNTIME_KEYS = ['input', 'props']

/**
 * Simple YAML parser for backwards compatibility
 * Supports basic key-value, nested objects, and arrays
 */
function parseYaml(content) {
  const lines = content.split('\n')
  return parseYamlLines(lines, 0).value
}

function getIndent(line) {
  const match = line.match(/^(\s*)/)
  return match ? match[1].length : 0
}

function parseYamlValue(value) {
  const trimmed = value.trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (!isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed)
  return trimmed
}

function parseYamlLines(lines, startIndex, baseIndent = 0) {
  const result = {}
  let i = startIndex

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }

    const indent = getIndent(line)
    if (indent < baseIndent && i > startIndex) break
    if (trimmed.startsWith('- ')) {
      i++
      continue
    }

    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) {
      i++
      continue
    }

    const key = trimmed.slice(0, colonIndex).trim()
    const valueAfterColon = trimmed.slice(colonIndex + 1).trim()

    const nextLine = lines[i + 1]
    const nextTrimmed = nextLine?.trim()
    const nextIndent = nextLine ? getIndent(nextLine) : 0

    if (nextTrimmed?.startsWith('- ') && nextIndent > indent) {
      const arrayResult = parseYamlArray(lines, i + 1, nextIndent)
      result[key] = arrayResult.value
      i = arrayResult.endIndex
    } else if (!valueAfterColon && nextIndent > indent) {
      const nestedResult = parseYamlLines(lines, i + 1, nextIndent)
      result[key] = nestedResult.value
      i = nestedResult.endIndex
    } else {
      result[key] = parseYamlValue(valueAfterColon)
      i++
    }
  }

  return { value: result, endIndex: i }
}

function parseYamlArray(lines, startIndex, baseIndent) {
  const result = []
  let i = startIndex

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }

    const indent = getIndent(line)
    if (indent < baseIndent) break

    if (trimmed.startsWith('- ')) {
      const afterDash = trimmed.slice(2)
      const colonIndex = afterDash.indexOf(':')

      if (colonIndex !== -1) {
        const key = afterDash.slice(0, colonIndex).trim()
        const value = afterDash.slice(colonIndex + 1).trim()
        const obj = { [key]: parseYamlValue(value) }
        const itemIndent = indent + 2
        i++

        while (i < lines.length) {
          const propLine = lines[i]
          const propTrimmed = propLine?.trim()

          if (!propTrimmed || propTrimmed.startsWith('#')) {
            i++
            continue
          }

          const propIndent = getIndent(propLine)
          if (propIndent < itemIndent || propTrimmed.startsWith('- ')) break

          const propColonIndex = propTrimmed.indexOf(':')
          if (propColonIndex !== -1) {
            const propKey = propTrimmed.slice(0, propColonIndex).trim()
            const propValue = propTrimmed.slice(propColonIndex + 1).trim()
            obj[propKey] = parseYamlValue(propValue)
          }
          i++
        }

        result.push(obj)
      } else {
        result.push(parseYamlValue(afterDash))
        i++
      }
    } else {
      break
    }
  }

  return { value: result, endIndex: i }
}

/**
 * Load a meta file (JS or YAML)
 */
async function loadMetaFile(filePath) {
  if (filePath.endsWith('.js')) {
    // Dynamic import for JS files
    const fileUrl = pathToFileURL(filePath).href
    const module = await import(fileUrl)
    return module.default
  } else {
    // Parse YAML
    const content = await readFile(filePath, 'utf-8')
    return parseYaml(content)
  }
}

/**
 * Find and load meta file for a component directory
 * Returns null if no meta file found
 */
export async function loadComponentMeta(componentDir) {
  for (const fileName of META_FILE_NAMES) {
    const filePath = join(componentDir, fileName)
    if (existsSync(filePath)) {
      try {
        const meta = await loadMetaFile(filePath)
        return { meta, fileName, filePath }
      } catch (error) {
        console.warn(`Warning: Failed to load ${filePath}:`, error.message)
        return null
      }
    }
  }
  return null
}

/**
 * Load foundation-level meta file
 */
export async function loadFoundationMeta(srcDir) {
  for (const fileName of META_FILE_NAMES) {
    const filePath = join(srcDir, fileName)
    if (existsSync(filePath)) {
      try {
        return await loadMetaFile(filePath)
      } catch (error) {
        console.warn(`Warning: Failed to load foundation meta ${filePath}:`, error.message)
        return {}
      }
    }
  }
  return {}
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
 * Extract runtime-relevant config from meta
 * Only includes keys that are needed at render time
 */
export function extractRuntimeConfig(meta) {
  if (!meta) return {}

  const config = {}
  for (const key of RUNTIME_KEYS) {
    if (meta[key] !== undefined) {
      config[key] = meta[key]
    }
  }
  return config
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
 * Build runtime config (minimal, for embedding in foundation.js)
 */
export async function buildRuntimeConfig(srcDir) {
  const foundationMeta = await loadFoundationMeta(srcDir)
  const components = await discoverComponents(srcDir)

  const componentConfigs = {}
  for (const [name, meta] of Object.entries(components)) {
    const config = extractRuntimeConfig(meta)
    if (Object.keys(config).length > 0) {
      componentConfigs[name] = config
    }
  }

  return {
    foundation: extractRuntimeConfig(foundationMeta),
    components: componentConfigs,
  }
}

/**
 * Get list of exposed component names
 */
export async function getExposedComponents(srcDir) {
  const components = await discoverComponents(srcDir)
  return Object.keys(components)
}
