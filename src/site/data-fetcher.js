/**
 * Data Fetcher Utilities
 *
 * Handles parsing fetch configurations and executing data fetches
 * from local files (public/) or remote URLs.
 *
 * Supports:
 * - Simple string paths: "/data/team.json"
 * - Full config objects with schema, prerender, merge, transform options
 * - Named-query references: { query: 'articles', limit: 3 }
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
import { matchWhere, queryDataUrl } from '@uniweb/core'

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
 * Apply a where-object predicate to an array of items.
 *
 * The where-object is the new query language (see @uniweb/core's
 * matchWhere). Structured JSON predicate; the runtime evaluator walks
 * the object against each record. Same shape ships to backends that
 * declare `supports: [where]`.
 *
 * @param {Array} items - Items to filter
 * @param {object} where - Where-object predicate
 * @returns {Array} Filtered items in source order
 */
export function applyWhere(items, where) {
  if (!where || !Array.isArray(items)) return items
  return matchWhere(where, items)
}

/**
 * Apply post-processing to fetched data (where, filter, sort, limit)
 *
 * Order of operations:
 *   1. where (where-object predicate, new) — narrows the record set
 *   2. filter (legacy DSL string) — narrows further if both are set; deprecated
 *   3. sort
 *   4. limit
 *
 * `where:` and `filter:` may both appear during the deprecation window
 * but in practice authors should pick one. Using `filter:` emits a dev
 * warning at parse time (see parseFetchConfig).
 *
 * @param {any} data - Fetched data
 * @param {object} config - Fetch config with optional where, filter, sort, limit
 * @returns {any} Processed data
 */
export function applyPostProcessing(data, config) {
  if (!data || !Array.isArray(data)) return data
  if (!config.where && !config.filter && !config.sort && !config.limit) return data

  let result = data

  // Apply where-object predicate first (new path)
  if (config.where) {
    result = applyWhere(result, config.where)
  }

  // Apply legacy filter expression (deprecated)
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
 * parseFetchConfig({ query: 'articles', limit: 3, sort: 'date desc' })
 * // Returns: { path: '/data/articles.json', schema: 'articles', limit: 3, sort: 'date desc', ... }
 */
// ─── Unrecognized-key reporting ───────────────────────────────────────
//
// `parseFetchConfig` reads an explicit allowlist and builds a new object, so
// anything the author wrote that is not on that list is DROPPED — silently,
// with no warning and no trace in the output. A typo (`wehre:`), a field from
// another config block, or a capability the author believed existed all look
// identical to having written nothing.
//
// ⛔ That silence is the defect, not the dropping. We cannot act on a key we do
// not understand, but we can refuse to pretend it was never there. Reported
// once per key name per process so a 200-record build does not print 200 lines.
const RECOGNIZED_FETCH_KEYS = {
  refine: new Set(['refine', 'inherit', 'detail', 'limit', 'sort', 'where', 'filter']),
  query: new Set([
    'query', 'as', 'schema', 'prerender', 'merge', 'transform',
    'where', 'limit', 'sort', 'detailPage', 'filter',
  ]),
  source: new Set([
    'path', 'url', 'as', 'schema', 'prerender', 'merge', 'transform', 'detail',
    'detailPage', 'where', 'limit', 'sort', 'filter',
  ]),
}

const warnedUnknownFetchKeys = new Set()

function warnUnknownFetchKeys(fetch, shape) {
  const recognized = RECOGNIZED_FETCH_KEYS[shape]
  for (const key of Object.keys(fetch)) {
    if (recognized.has(key)) continue
    const seenKey = `${shape}:${key}`
    if (warnedUnknownFetchKeys.has(seenKey)) continue
    warnedUnknownFetchKeys.add(seenKey)
    console.warn(
      `[uniweb] fetch: unrecognized key "${key}" was ignored. ` +
        `Keys recognized on this declaration: ${[...recognized].sort().join(', ')}.`
    )
  }
}

/** Test seam — reset the once-per-key memo so suites do not leak into each other. */
export function _resetUnknownFetchKeyWarnings() {
  warnedUnknownFetchKeys.clear()
}

/**
 * Normalize a parsed `fetch` to a list. **Use this at every consumption point.**
 *
 * `parseFetchConfig` returns an object for one declaration and an array for
 * several, so `cfg.path` on a multi-fetch page reads `undefined` rather than
 * throwing — the silent-empty class. Reaching for this instead of a property is
 * what keeps that from happening.
 *
 * @param {Object|Array|null} fetch - a PARSED fetch (post-`parseFetchConfig`).
 * @returns {Array<Object>} zero, one, or many configs.
 */
export function toFetchList(fetch) {
  if (!fetch) return []
  return Array.isArray(fetch) ? fetch : [fetch]
}

/**
 * Parse a `fetch:` (or desugared `data:`) declaration.
 *
 * ⭐ **A LIST MEANS "FETCH EACH".** `data: [team, articles]` declares two needs
 * and they land under two keys in `content.data` — a component reads
 * `content.data.team` and `content.data.articles` independently, so the
 * declaration is plural by necessity.
 *
 * ⚖️ **Plural DECLARATIONS are not plural REQUESTS.** How many round trips this
 * becomes belongs to the fetcher: `EntityStore` already assembles every config
 * before dispatching any of them and awaits them together, which is exactly
 * where a batching source would coalesce. Nothing here should encode a
 * transport assumption — the file lane genuinely has two artifacts, and most
 * sources cannot batch at all.
 *
 * ⛔ **A one-entry list collapses to an object, deliberately.** The returned
 * shape reflects the cardinality of the RESULT, not of the input syntax, so
 * every declaration that resolves to a single fetch is byte-identical to what
 * this emitted before — the array shape appears only where content could not
 * previously have worked. (Before 2026-09-02 a list kept `[0]` and discarded the
 * rest silently, so the only content whose shape changes is content that was
 * already broken.)
 *
 * @param {string|Object|Array|null} fetch
 * @returns {Object|Array<Object>|null}
 */
export function parseFetchConfig(fetch) {
  if (!fetch) return null

  if (Array.isArray(fetch)) {
    const parsed = fetch.map((f) => parseFetchConfig(f)).filter(Boolean)
    // Flatten: a nested array is not a meaningful authoring shape, and letting
    // one through would put an array inside an array where every consumer
    // expects configs.
    const flat = parsed.flat()
    if (flat.length === 0) return null
    return flat.length === 1 ? flat[0] : flat
  }

  // Simple string: "/data/team.json"
  if (typeof fetch === 'string') {
    const inferred = inferSchemaFromPath(fetch)
    return {
      path: fetch,
      url: undefined,
      // Both spellings — see the note in the named-query branch below.
      as: inferred,
      schema: inferred,
      prerender: true,
      merge: false,
      transform: undefined,
    }
  }

  // Full config object
  if (typeof fetch !== 'object') return null

  // Refine config: { refine: true, detail: false, limit: 3 }
  // No URL — merges with the parent fetch config at runtime; only carries
  // override props. The legacy spelling `inherit: true` is accepted for one
  // release with a warning, then removed.
  //
  // Note on build-vs-runtime scope: this parser passes `sort` and `filter`
  // through on refine configs, but the runtime EntityStore only applies
  // `detail`, `limit`, and `order` overrides. `sort` / `filter` on a refine
  // block are currently accepted by the parser but not honored at runtime.
  // Preserved as-is in this rename commit; revisit separately if needed.
  if (fetch.refine === true || fetch.inherit === true) {
    warnUnknownFetchKeys(fetch, 'refine')
    if (fetch.inherit === true && fetch.refine !== true) {
      console.warn(
        "[uniweb] 'fetch: { inherit: true }' is deprecated; rename to 'fetch: { refine: true }'. " +
        'Accepted for one release; will be removed in the next minor.'
      )
    }
    if (fetch.filter !== undefined) warnFilterDeprecated()
    return {
      refine: true,
      ...(fetch.detail !== undefined ? { detail: fetch.detail } : {}),
      ...(fetch.limit !== undefined ? { limit: fetch.limit } : {}),
      ...(fetch.sort !== undefined ? { sort: fetch.sort } : {}),
      ...(fetch.where !== undefined ? { where: fetch.where } : {}),
      ...(fetch.filter !== undefined ? { filter: fetch.filter } : {}),
    }
  }

  // ⛔ THE RETIRED SPELLING IS AN ERROR, NOT A WARNING. An unrecognized key is
  // warned about and IGNORED, so `fetch: { collection: X }` would fall through to
  // the source shape, find neither `path` nor `url`, and resolve to null — a
  // SILENTLY EMPTY result, which is worse than the old name simply working. The
  // author sees a page render with no data and nothing saying why.
  if (fetch.collection !== undefined) {
    throw new Error(
      `[uniweb] fetch: \`collection: ${JSON.stringify(fetch.collection)}\` is retired. ` +
        `Write \`query: ${JSON.stringify(fetch.collection)}\` and declare it in queries.yml. ` +
        `A query names a schema and the folder supplies its records.`
    )
  }

  // Named-query reference: { query: 'articles', limit: 3 }
  if (fetch.query) {
    warnUnknownFetchKeys(fetch, 'query')
    if (fetch.filter !== undefined) warnFilterDeprecated()
    return {
      // ⭐ **`query` IS EMITTED, and that is what makes the two producers agree.**
      // The sync lane has always emitted it (`uwx/site.js`) and this one did not,
      // for the same declaration — so `resolveQuerySource` fired on a published
      // site and never on a `--link`-deployed one. Measured 2026-09-02 against a
      // host declaring `config.records`:
      //
      //   --link   endpoint undefined, path /data/articles.json   ← the STATIC file
      //   publish  endpoint /_api/q/articles                       ← the live lane
      //
      // Same site, same declaration, two verbs, two data sources. Publishing to a
      // platform that declares a live lane is supposed to READ from it — the
      // compiled `/data/*.json` is the escape hatch for entities with no known
      // data schema, which never sync, not a second way to serve the ones that do.
      //
      // ⚠️ Not in the cache key: `deriveCacheKey` hashes {path,url,endpoint,schema,
      // transform}, so adding this moves no cached entry.
      query: fetch.query,
      path: queryDataUrl(fetch.query),
      url: undefined,
      // ⭐ **`as`, not `schema`.** The BINDING KEY — the `content.data.<key>` a
      // component reads — defaults to the query name. It was called `schema`
      // until 2026-09-02, which collided with the MODEL REF of the same name on a
      // `queries` declaration; `fetch.schema` is still accepted as input so
      // existing content keeps working, and is never emitted.
      // ⛔ **BOTH SPELLINGS ARE EMITTED, and this is not the overload coming back.**
      // `bindingKey()` reads `as ?? schema`, so NEW core needs only `as`. But a
      // published site renders at ITS OWN pinned runtime version, and every
      // runtime shipped to date bundles a core whose resolver does
      // `if (!cfg?.schema) continue` — so an `as`-only payload served by an older
      // runtime is SKIPPED ENTIRELY. No data, nothing thrown, nothing logged.
      //
      // ⭐ The compatibility runs the OTHER WAY from `bindingKey`'s: that one is
      // old payloads meeting new code, this one is new payloads meeting old code,
      // and only the first was covered. Caught by frontend before it shipped.
      //
      // ⇒ Emit both until every serving runtime carries `bindingKey`, then drop
      // `schema` here. Until then a reader may see this as redundant; it is a
      // compatibility duplicate and the comment is what tells them apart.
      as: fetch.as || fetch.schema || fetch.query,
      schema: fetch.as || fetch.schema || fetch.query,
      prerender: fetch.prerender ?? true,
      merge: fetch.merge ?? false,
      transform: fetch.transform,
      // Query operators
      where: fetch.where,
      limit: fetch.limit,
      sort: fetch.sort,
      // Canonical detail page for a list card's href (page:<stable_id> ref;
      // resolved to a route template + interpolated per record at runtime).
      detailPage: fetch.detailPage,
      // Legacy post-processing (deprecated, see warning above)
      filter: fetch.filter,
    }
  }

  warnUnknownFetchKeys(fetch, 'source')
  const {
    path,
    url,
    as,
    schema,
    prerender = url ? false : true,
    merge = false,
    transform,
    detail,
    detailPage,
    // Query operators
    where,
    limit,
    sort,
    // Legacy post-processing (deprecated)
    filter,
  } = fetch

  // Must have either path or url
  if (!path && !url) return null

  if (filter !== undefined) warnFilterDeprecated()

  return {
    path,
    url,
    // Both spellings — see the note in the named-query branch above.
    as: as ?? schema ?? inferSchemaFromPath(path || url),
    schema: as ?? schema ?? inferSchemaFromPath(path || url),
    prerender,
    merge,
    transform,
    detail,
    // Canonical detail page for a list card's href (page:<stable_id>).
    detailPage,
    // Query operators
    where,
    limit,
    sort,
    // Legacy post-processing (deprecated)
    filter,
  }
}

let filterDeprecationWarned = false
function warnFilterDeprecated() {
  if (filterDeprecationWarned) return
  filterDeprecationWarned = true
  console.warn(
    "[uniweb] 'fetch: { filter: ... }' (DSL string) is deprecated; use 'where: { ... }' " +
    'with a where-object. Example: where: { tags: \"featured\" } instead of ' +
    "filter: 'tags contains featured'. " +
    'Accepted for one release; will be removed in the next minor.'
  )
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
