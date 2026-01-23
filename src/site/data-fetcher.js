/**
 * Data Fetcher Utilities
 *
 * Handles parsing fetch configurations and executing data fetches
 * from local files (public/) or remote URLs.
 *
 * Supports:
 * - Simple string paths: "/data/team.json"
 * - Full config objects with schema, prerender, merge, transform options
 * - Collection references: { collection: 'articles', limit: 3 }
 * - Local JSON/YAML files
 * - Remote URLs
 * - Transform paths to extract nested data
 * - Post-processing: limit, sort, filter
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
 * Parse a filter value from string
 *
 * @param {string} raw - Raw value string
 * @returns {any} Parsed value
 */
function parseFilterValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw)

  // Remove quotes if present
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }

  return raw
}

/**
 * Apply filter expression to array of items
 *
 * Supported operators: ==, !=, >, <, >=, <=, contains
 *
 * @param {Array} items - Items to filter
 * @param {string} filterExpr - Filter expression (e.g., "published != false")
 * @returns {Array} Filtered items
 *
 * @example
 * applyFilter(items, 'published != false')
 * applyFilter(items, 'tags contains featured')
 */
export function applyFilter(items, filterExpr) {
  if (!filterExpr || !Array.isArray(items)) return items

  const match = filterExpr.match(/^(\S+)\s*(==|!=|>=?|<=?|contains)\s*(.+)$/)
  if (!match) return items

  const [, field, op, rawValue] = match
  const value = parseFilterValue(rawValue.trim())

  return items.filter(item => {
    const itemValue = getNestedValue(item, field)
    switch (op) {
      case '==': return itemValue === value
      case '!=': return itemValue !== value
      case '>': return itemValue > value
      case '<': return itemValue < value
      case '>=': return itemValue >= value
      case '<=': return itemValue <= value
      case 'contains':
        return Array.isArray(itemValue)
          ? itemValue.includes(value)
          : String(itemValue).includes(value)
      default: return true
    }
  })
}

/**
 * Apply sort expression to array of items
 *
 * @param {Array} items - Items to sort
 * @param {string} sortExpr - Sort expression (e.g., "date desc" or "order asc, title asc")
 * @returns {Array} Sorted items (new array)
 *
 * @example
 * applySort(items, 'date desc')
 * applySort(items, 'order asc, title asc')
 */
export function applySort(items, sortExpr) {
  if (!sortExpr || !Array.isArray(items)) return items

  const sorts = sortExpr.split(',').map(s => {
    const [field, dir = 'asc'] = s.trim().split(/\s+/)
    return { field, desc: dir.toLowerCase() === 'desc' }
  })

  return [...items].sort((a, b) => {
    for (const { field, desc } of sorts) {
      const aVal = getNestedValue(a, field) ?? ''
      const bVal = getNestedValue(b, field) ?? ''
      if (aVal < bVal) return desc ? 1 : -1
      if (aVal > bVal) return desc ? -1 : 1
    }
    return 0
  })
}

/**
 * Apply post-processing to fetched data (filter, sort, limit)
 *
 * @param {any} data - Fetched data
 * @param {object} config - Fetch config with optional filter, sort, limit
 * @returns {any} Processed data
 */
export function applyPostProcessing(data, config) {
  if (!data || !Array.isArray(data)) return data
  if (!config.filter && !config.sort && !config.limit) return data

  let result = data

  // Apply filter first
  if (config.filter) {
    result = applyFilter(result, config.filter)
  }

  // Apply sort
  if (config.sort) {
    result = applySort(result, config.sort)
  }

  // Apply limit last
  if (config.limit && config.limit > 0) {
    result = result.slice(0, config.limit)
  }

  return result
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
 *
 * // Collection reference
 * parseFetchConfig({ collection: 'articles', limit: 3, sort: 'date desc' })
 * // Returns: { path: '/data/articles.json', schema: 'articles', limit: 3, sort: 'date desc', ... }
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

  // Collection reference: { collection: 'articles', limit: 3 }
  if (fetch.collection) {
    return {
      path: `/data/${fetch.collection}.json`,
      url: undefined,
      schema: fetch.schema || fetch.collection,
      prerender: fetch.prerender ?? true,
      merge: fetch.merge ?? false,
      transform: fetch.transform,
      // Post-processing options
      limit: fetch.limit,
      sort: fetch.sort,
      filter: fetch.filter,
    }
  }

  const {
    path,
    url,
    schema,
    prerender = true,
    merge = false,
    transform,
    // Post-processing options (also supported for path/url fetches)
    limit,
    sort,
    filter,
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
    // Post-processing options
    limit,
    sort,
    filter,
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
 *
 * @example
 * // With post-processing
 * const result = await executeFetch(
 *   { path: '/data/articles.json', limit: 3, sort: 'date desc' },
 *   { siteRoot: '/path/to/site' }
 * )
 * // result.data contains the 3 most recent articles
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

    // Apply post-processing (filter, sort, limit)
    data = applyPostProcessing(data, config)

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
 * Convert a plural schema name to singular
 * Used for dynamic routes where the parent has "articles" and
 * each child page gets the singular "article" for the current item
 *
 * @param {string} name - Plural name (e.g., 'articles', 'posts', 'people')
 * @returns {string} Singular name (e.g., 'article', 'post', 'person')
 *
 * @example
 * singularize('articles') // 'article'
 * singularize('posts')    // 'post'
 * singularize('people')   // 'person'
 * singularize('categories') // 'category'
 */
export function singularize(name) {
  if (!name) return name

  // Handle common irregular plurals
  const irregulars = {
    people: 'person',
    children: 'child',
    men: 'man',
    women: 'woman',
    feet: 'foot',
    teeth: 'tooth',
    mice: 'mouse',
    geese: 'goose',
  }

  if (irregulars[name]) return irregulars[name]

  // Standard rules (in order of specificity)
  if (name.endsWith('ies')) {
    // categories -> category
    return name.slice(0, -3) + 'y'
  }
  if (name.endsWith('ves')) {
    // leaves -> leaf
    return name.slice(0, -3) + 'f'
  }
  if (name.endsWith('es') && (name.endsWith('shes') || name.endsWith('ches') || name.endsWith('xes') || name.endsWith('sses') || name.endsWith('zes'))) {
    // boxes -> box, watches -> watch
    return name.slice(0, -2)
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    // articles -> article
    return name.slice(0, -1)
  }

  return name
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
