/**
 * Data Fetcher Utilities
 *
 * Handles parsing fetch configurations and executing data fetches
 * from local files (public/) or remote URLs.
 *
 * Supports:
 * - Simple string paths: "/data/team.json"
 * - Full config objects with schema, prerender, merge, transform options
 * - Local JSON/YAML files
 * - Remote URLs
 * - Transform paths to extract nested data
 *
 * @module @uniweb/build/site/data-fetcher
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'

/**
 * Infer schema name from path or URL
 * Extracts filename without extension as the schema key
 *
 * @param {string} pathOrUrl - File path or URL
 * @returns {string} Schema name
 *
 * @example
 * inferSchemaFromPath('/data/team-members.json') // 'team-members'
 * inferSchemaFromPath('https://api.com/users')   // 'users'
 */
function inferSchemaFromPath(pathOrUrl) {
  if (!pathOrUrl) return 'data'

  // Get the last path segment
  const segment = pathOrUrl.split('/').pop()
  // Remove query string
  const filename = segment.split('?')[0]
  // Remove extension
  return filename.replace(/\.(json|yaml|yml)$/i, '')
}

/**
 * Get a nested value from an object using dot notation
 *
 * @param {object} obj - Source object
 * @param {string} path - Dot-separated path (e.g., 'data.items')
 * @returns {any} The nested value or undefined
 */
function getNestedValue(obj, path) {
  if (!obj || !path) return obj

  const parts = path.split('.')
  let current = obj

  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }

  return current
}

/**
 * Normalize a fetch configuration to standard form
 *
 * @param {string|object} fetch - Simple path string or full config object
 * @returns {object|null} Normalized config or null if invalid
 *
 * @example
 * // Simple string
 * parseFetchConfig('/data/team.json')
 * // Returns: { path: '/data/team.json', schema: 'team', prerender: true, merge: false }
 *
 * // Full config
 * parseFetchConfig({ path: '/team', schema: 'person', prerender: false })
 * // Returns: { path: '/team', schema: 'person', prerender: false, merge: false }
 */
export function parseFetchConfig(fetch) {
  if (!fetch) return null

  // Simple string: "/data/team.json"
  if (typeof fetch === 'string') {
    const schema = inferSchemaFromPath(fetch)
    return {
      path: fetch,
      url: undefined,
      schema,
      prerender: true,
      merge: false,
      transform: undefined,
    }
  }

  // Full config object
  if (typeof fetch !== 'object') return null

  const {
    path,
    url,
    schema,
    prerender = true,
    merge = false,
    transform,
  } = fetch

  // Must have either path or url
  if (!path && !url) return null

  return {
    path,
    url,
    schema: schema || inferSchemaFromPath(path || url),
    prerender,
    merge,
    transform,
  }
}

/**
 * Execute a fetch operation
 *
 * @param {object} config - Normalized fetch config from parseFetchConfig
 * @param {object} options - Execution options
 * @param {string} options.siteRoot - Site root directory
 * @param {string} [options.publicDir='public'] - Public directory name
 * @returns {Promise<{ data: any, error?: string }>} Fetched data or error
 *
 * @example
 * const result = await executeFetch(
 *   { path: '/data/team.json', schema: 'team' },
 *   { siteRoot: '/path/to/site' }
 * )
 * // result.data contains the parsed JSON
 */
export async function executeFetch(config, options = {}) {
  if (!config) return { data: null }

  const { path, url, transform } = config
  const { siteRoot, publicDir = 'public' } = options

  try {
    let data

    if (path) {
      // Local file from public/
      const filePath = join(siteRoot, publicDir, path)

      if (!existsSync(filePath)) {
        console.warn(`[data-fetcher] File not found: ${filePath}`)
        return { data: [], error: `File not found: ${path}` }
      }

      const content = await readFile(filePath, 'utf8')

      // Parse based on extension
      if (path.endsWith('.json')) {
        data = JSON.parse(content)
      } else if (path.endsWith('.yaml') || path.endsWith('.yml')) {
        data = yaml.load(content)
      } else {
        // Try JSON first, then YAML
        try {
          data = JSON.parse(content)
        } catch {
          data = yaml.load(content)
        }
      }
    } else if (url) {
      // Remote URL
      const response = await globalThis.fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      data = await response.json()
    }

    // Apply transform if specified (extract nested data)
    if (transform && data) {
      data = getNestedValue(data, transform)
    }

    // Ensure we return an array or object, defaulting to empty array
    return { data: data ?? [] }
  } catch (error) {
    console.warn(`[data-fetcher] Fetch failed: ${error.message}`)
    return { data: [], error: error.message }
  }
}

/**
 * Merge fetched data into existing content
 *
 * @param {object} content - Existing content object with data property
 * @param {any} fetchedData - Data from fetch
 * @param {string} schema - Schema key to store under
 * @param {boolean} [merge=false] - If true, merge with existing data; if false, replace
 * @returns {object} Updated content object
 *
 * @example
 * const content = { data: { team: [{ name: 'Local' }] } }
 * const fetched = [{ name: 'Remote' }]
 *
 * // Replace (default)
 * mergeDataIntoContent(content, fetched, 'team', false)
 * // content.data.team = [{ name: 'Remote' }]
 *
 * // Merge
 * mergeDataIntoContent(content, fetched, 'team', true)
 * // content.data.team = [{ name: 'Local' }, { name: 'Remote' }]
 */
export function mergeDataIntoContent(content, fetchedData, schema, merge = false) {
  if (fetchedData === null || fetchedData === undefined || !schema) {
    return content
  }

  // Create a new content object with updated data
  const result = {
    ...content,
    data: { ...(content.data || {}) },
  }

  if (merge && result.data[schema] !== undefined) {
    // Merge mode: combine with existing data
    const existing = result.data[schema]

    if (Array.isArray(existing) && Array.isArray(fetchedData)) {
      // Arrays: concatenate
      result.data[schema] = [...existing, ...fetchedData]
    } else if (
      typeof existing === 'object' &&
      existing !== null &&
      typeof fetchedData === 'object' &&
      fetchedData !== null &&
      !Array.isArray(existing) &&
      !Array.isArray(fetchedData)
    ) {
      // Objects: shallow merge
      result.data[schema] = { ...existing, ...fetchedData }
    } else {
      // Different types: fetched data wins
      result.data[schema] = fetchedData
    }
  } else {
    // Replace mode (default): fetched data overwrites
    result.data[schema] = fetchedData
  }

  return result
}

/**
 * Execute multiple fetch operations in parallel
 *
 * @param {object[]} configs - Array of normalized fetch configs
 * @param {object} options - Execution options (same as executeFetch)
 * @returns {Promise<Map<string, any>>} Map of schema -> data
 */
export async function executeMultipleFetches(configs, options = {}) {
  if (!configs || configs.length === 0) {
    return new Map()
  }

  const results = await Promise.all(
    configs.map(async (config) => {
      const result = await executeFetch(config, options)
      return { schema: config.schema, data: result.data }
    })
  )

  const dataMap = new Map()
  for (const { schema, data } of results) {
    if (data !== null) {
      dataMap.set(schema, data)
    }
  }

  return dataMap
}
