/**
 * Collection Processor
 *
 * Materializes each named QUERY over the site's records into JSON data.
 * Collections are defined in site.yml and processed at build time.
 *
 * ⛔ A COLLECTION `.md` IS NOT A PAGE-SECTION `.md`. Same extension, unrelated
 * meanings, and the sync-side reader states this too
 * (`build/src/uwx/collection-source.js`) because getting it backwards produces
 * confident nonsense:
 *
 *   - collection record — frontmatter is structured DATA whose shape is the
 *     collection's data schema; the body is the value of ONE declared field
 *     (the Model's content body field). Not "metadata".
 *   - page section — frontmatter is foundation/runtime CONFIG (`type:`, params,
 *     `theme:`); the body is authored content with no schema behind it.
 *
 * ⭐ And `.md` is the HYBRID case, not the general one. It exists for records
 * that are part data and part prose — a blog article. YAML and JSON records are
 * data only, have no body, and express nesting and arrays natively; they are the
 * plain case rather than the exception. Reasoning about records from the
 * markdown shape alone imports a body and a content field that most records
 * do not have.
 *
 * Features:
 * - Discovers markdown (.md), data (.yml/.yaml), JSON (.json), and BibTeX (.bib)
 *   files in collection folders
 * - Parses frontmatter for record data (markdown), full YAML or JSON (data items),
 *   or BibTeX → CSL-JSON (bibliography items)
 * - Pure-data formats (YAML, JSON, BibTeX) accept either one record per file
 *   (mapping at the top, slug from filename) or many records per file (array
 *   at the top, each item carries its own slug; BibTeX always produces an
 *   array, with the cite key as slug). Multiple files in the same folder
 *   merge — the loader flattens one level after collecting them.
 * - Converts markdown body to ProseMirror JSON
 * - Supports filtering, sorting, and limiting
 * - Auto-generates excerpts and extracts first images (markdown items only)
 *
 * @module @uniweb/build/site/collection-processor
 *
 * @example
 * // queries.yml
 * articles:
 *   schema: '@/article'
 *   sort: date desc
 *
 * // Usage
 * const byQuery = await processQueries(siteDir, config.queries)
 * await writeQueryFiles(siteDir, byQuery)
 */

import { readFile, readdir, stat, writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { join, basename, extname, dirname, relative, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { parseBibtex } from '@citestyle/bibtex'
import { DATA_DIR } from '@uniweb/core'
import { applyWhere, applyFilter, applySort } from './data-fetcher.js'
import { resolveAssetPath, walkContentAssets, isLocalAssetPath } from './assets.js'
import { readEntityPool, groupPoolBySchema, ENTITIES_DIR } from './entity-pool.js'
import { readRecordsConfig, resolveFolder, FOLDER_MISSING } from './records-config.js'
import { parseFrontmatter } from '../utils/frontmatter.js'

// Try to import content-reader for markdown parsing
let markdownToProseMirror
try {
  const contentReader = await import('@uniweb/content-reader')
  markdownToProseMirror = contentReader.markdownToProseMirror
} catch {
  // Simplified fallback
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
 * Parse collection config from site.yml
 *
 * @param {string} name - Collection name
 * @param {string|Object} config - Simple path string or full config object
 * @returns {Object} Normalized config
 *
 * @example
 * // Simple form
 * parseQueryConfig('articles', '@/article')
 *
 * // Extended form
 * parseQueryConfig('articles', {
 *   path: 'collections/articles',
 *   route: '/blog',
 *   sort: 'date desc',
 *   filter: 'published != false',
 *   limit: 100
 * })
 */
function parseQueryConfig(name, config) {
  // ⚠️ `queries.yml`'s TERSEST form is a bare key — `articles:` — which YAML
  // parses as NULL. The resolver normalizes that away, so the build path never
  // sees it; a caller reading raw config (as this function's own docstring
  // shows) would have crashed on the shortest thing an author can write.
  if (config === null || config === undefined) config = {}
  if (typeof config === 'string') {
    // The string shorthand names the SCHEMA — `entities/{schema}/` supplies the
    // records, so there is no directory for a query to name.
    return {
      name,
      schema: config,
      url: null,
      route: null,
      sort: null,
      where: null,
      filter: null,
      limit: 0,
      excerpt: { maxLength: 160 },
      deferred: null,
    }
  }

  return {
    name,
    // The query's schema selects its records from the pool — `entities/{schema}/`
    // declares the model, so the entities of a schema ARE the query's records.
    schema: config.schema || null,
    url: config.url || null,
    route: config.route || null,
    sort: config.sort || null,
    // `where:` is the CANONICAL predicate; `filter:` is the deprecated string DSL
    // it replaced. Both are carried and both are applied below, in the same order
    // `data-fetcher.js::applyPostProcessing` uses — see the note there.
    where: config.where || null,
    filter: config.filter || null,
    limit: config.limit || 0,
    excerpt: {
      maxLength: config.excerpt?.maxLength || 160,
      field: config.excerpt?.field || null
    },
    // `deferred:` lists fields that are heavy (article body, full nested
    // arrays). Those fields are stripped from the cascade payload that
    // ships with `data: <name>` declarations, and per-record full files
    // are emitted at public/data/<name>/<slug>.json. Components that
    // need the full record fetch the per-record file on demand, either
    // automatically on dynamic-route pages (entity-store routes the
    // singular detail there) or via the kit's useEntityDetail hook.
    deferred: Array.isArray(config.deferred) ? config.deferred.slice() : null,
    // `detailUrl:` names the per-record endpoint pattern for API-backed
    // remote sources (where the build emits no per-record files because
    // there are no on-disk source files to materialize). Used by the
    // runtime's auto-detail injection and the useEntityDetail kit hook.
    // Pattern uses {slug} as the placeholder; substitution at runtime
    // pulls from the dynamic-route param (entity-store) or the record's
    // slug field (useEntityDetail). File-backed queries leave
    // this null and get the static-file default /data/<name>/<slug>.json.
    detailUrl: typeof config.detailUrl === 'string' ? config.detailUrl : null,
    // `queryable:` declares the queryable surface — which fields a
    // foundation can offer for filtering UI, with their type and
    // type-specific metadata (enum options, range bounds). Foundations
    // read this metadata via the kit's useQueryable hook to
    // render filter controls and compose where-objects from user
    // interactions. The framework doesn't validate the shape here —
    // foundations get whatever the author wrote; documentation defines
    // the conventional types (enum/boolean/range/text).
    queryable: (config.queryable && typeof config.queryable === 'object') ? config.queryable : null,
  }
}


/**
 * Extract plain text from ProseMirror content
 *
 * @param {Object} node - ProseMirror node
 * @returns {string} Plain text
 */
function extractPlainText(node) {
  if (!node) return ''

  if (node.type === 'text') {
    return node.text || ''
  }

  if (Array.isArray(node.content)) {
    return node.content.map(extractPlainText).join('')
  }

  return ''
}

/**
 * Extract excerpt from content
 *
 * @param {Object} frontmatter - Parsed frontmatter
 * @param {Object} content - ProseMirror content
 * @param {Object} excerptConfig - Excerpt configuration
 * @returns {string} Excerpt text
 */
function extractExcerpt(frontmatter, content, excerptConfig) {
  const { maxLength = 160, field = null } = excerptConfig || {}

  // Check for explicit excerpt in frontmatter
  if (frontmatter.excerpt) {
    return frontmatter.excerpt.slice(0, maxLength)
  }

  // Check for alternative field (e.g., 'description')
  if (field && frontmatter[field]) {
    return frontmatter[field].slice(0, maxLength)
  }

  // Auto-extract from content
  const text = extractPlainText(content)
  if (!text) return ''

  // Clean and truncate
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned

  // Truncate at word boundary
  const truncated = cleaned.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > maxLength * 0.7
    ? truncated.slice(0, lastSpace) + '...'
    : truncated + '...'
}

/**
 * Extract first image from ProseMirror content
 *
 * @param {Object} node - ProseMirror node
 * @returns {string|null} Image URL or null
 */
function extractFirstImage(node) {
  if (!node) return null

  if (node.type === 'image' && node.attrs?.src) {
    return node.attrs.src
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const img = extractFirstImage(child)
      if (img) return img
    }
  }

  return null
}

/**
 * Check if a path is external (http/https/data URL)
 */
function isExternalUrl(src) {
  return /^(https?:)?\/\//.test(src) || src.startsWith('data:')
}

/**
 * Process assets in collection content
 * - Resolves relative paths to site-root-relative paths
 * - Copies co-located assets to public/records/<schema>/
 * - Updates paths in the content in place
 *
 * @param {Object} content - ProseMirror document
 * @param {string} itemPath - Path to the markdown file
 * @param {string} siteRoot - Site root directory
 * @param {string} queryName - Name of the collection (e.g., 'articles')
 * @returns {Promise<Object>} Asset manifest for this item
 */
async function processRecordAssets(content, itemPath, siteRoot, poolDirs, basePath) {
  const assets = {}
  const itemDir = dirname(itemPath)
  const publicDir = join(siteRoot, 'public')
  // ⭐ THE RECORD'S OWN HOME, keyed by its pool position — `public/records/<schema
  // dirs>/`. It was `public/collections/<queryName>/`, which meant the SAME image
  // was copied once per query that returned the record, under two URLs. Third
  // instance of the same conflation (after the freeform locale tree and the
  // translation manifest): an asset belongs to a record, and which query selects
  // it is not a fact about it.
  const targetDir = join(publicDir, 'records', poolDirs)

  // Walk content and collect asset paths
  const assetNodes = []
  walkContentAssets(content, (node, path, attrName) => {
    assetNodes.push({ node, attrName })
  })

  for (const { node, attrName } of assetNodes) {
    const src = node.attrs.src
    if (!src || isExternalUrl(src)) continue

    // Resolve the path
    const result = resolveAssetPath(src, itemPath, siteRoot)
    if (result.external || !result.resolved) continue

    let finalPath = src

    // Handle relative paths (co-located assets)
    if (src.startsWith('./') || src.startsWith('../')) {
      // Check if file exists at resolved location
      if (existsSync(result.resolved)) {
        // Copy to public/collections/<collection>/
        const assetFilename = basename(result.resolved)
        const targetPath = join(targetDir, assetFilename)

        // Ensure target directory exists
        await mkdir(targetDir, { recursive: true })

        // Copy the asset
        await copyFile(result.resolved, targetPath)

        // Update path to site-root-relative
        finalPath = `${basePath}records/${poolDirs}/${assetFilename}`

        assets[src] = {
          original: src,
          resolved: result.resolved,
          copied: targetPath,
          publicPath: finalPath
        }
      }
    }
    // Handle absolute site paths - just validate they exist
    else if (src.startsWith('/')) {
      const publicPath = join(publicDir, src)
      if (existsSync(publicPath)) {
        assets[src] = {
          original: src,
          resolved: publicPath,
          publicPath: src
        }
      }
    }

    // Update the node's src attribute if path changed
    if (finalPath !== src) {
      node.attrs.src = finalPath
    }

    // Also handle poster/preview attributes
    if (node.attrs.poster && !isExternalUrl(node.attrs.poster)) {
      const posterResult = resolveAssetPath(node.attrs.poster, itemPath, siteRoot)
      if (posterResult.resolved && existsSync(posterResult.resolved)) {
        const posterFilename = basename(posterResult.resolved)
        const posterTarget = join(targetDir, posterFilename)
        await mkdir(targetDir, { recursive: true })
        await copyFile(posterResult.resolved, posterTarget)
        node.attrs.poster = `${basePath}records/${poolDirs}/${posterFilename}`
      }
    }

    if (node.attrs.preview && !isExternalUrl(node.attrs.preview)) {
      const previewResult = resolveAssetPath(node.attrs.preview, itemPath, siteRoot)
      if (previewResult.resolved && existsSync(previewResult.resolved)) {
        const previewFilename = basename(previewResult.resolved)
        const previewTarget = join(targetDir, previewFilename)
        await mkdir(targetDir, { recursive: true })
        await copyFile(previewResult.resolved, previewTarget)
        node.attrs.preview = `${basePath}records/${poolDirs}/${previewFilename}`
      }
    }
  }

  return assets
}

/**
 * Process assets in a data item (YAML/JSON)
 * - Recursively walks the data object looking for local asset paths
 * - Copies co-located assets to public/records/<schema>/
 * - Rewrites paths to absolute URLs (with base path)
 *
 * @param {Object} data - Parsed data object (mutated in place)
 * @param {string} itemPath - Path to the data file
 * @param {string} siteRoot - Site root directory
 * @param {string} queryName - Name of the collection
 * @param {string} basePath - Site base path (e.g., '/' or '/docs/')
 */
async function processDataItemAssets(data, itemPath, siteRoot, poolDirs, basePath) {
  const targetDir = join(siteRoot, 'public', 'records', poolDirs)

  async function walk(parent, key) {
    const val = parent[key]
    if (typeof val === 'string' && isLocalAssetPath(val)) {
      if (val.startsWith('./') || val.startsWith('../')) {
        const resolved = resolve(dirname(itemPath), val)
        if (existsSync(resolved)) {
          const filename = basename(resolved)
          await mkdir(targetDir, { recursive: true })
          await copyFile(resolved, join(targetDir, filename))
          parent[key] = `${basePath}records/${poolDirs}/${filename}`
        }
      } else if (val.startsWith('/')) {
        // Absolute site path — just prepend base
        parent[key] = `${basePath}${val.slice(1)}`
      }
      return
    }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) await walk(val, i)
      return
    }
    if (val && typeof val === 'object') {
      for (const k of Object.keys(val)) await walk(val, k)
    }
  }

  for (const key of Object.keys(data)) {
    if (key === 'slug') continue
    await walk(data, key)
  }
}

// Filter and sort utilities are imported from data-fetcher.js

/**
 * Process a single data item from a YAML file
 *
 * YAML items are pure data — no ProseMirror conversion, no body, no excerpt,
 * no image extraction, no lastModified.
 *
 * A YAML file containing a top-level array returns all items (single-file
 * collection); each item must carry its own `slug`. A YAML file containing
 * a mapping returns a single item with `slug` derived from the filename.
 * Mirrors `processJsonItem` for parity across pure-data formats.
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - YAML filename (.yml or .yaml)
 * @returns {Promise<Object|Array|null>} Processed item(s) or null if unpublished
 */
async function processDataItem(dir, filename, siteRoot, poolDirs, basePath) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const data = yaml.load(raw) || {}

  // Array → multiple items (single-file collection)
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        await processDataItemAssets(item, filepath, siteRoot, poolDirs, basePath)
      }
    }
    return data
  }

  // Mapping → single item
  if (data.published === false) return null
  const slug = basename(filename, extname(filename))
  const item = { slug, ...data }
  await processDataItemAssets(item, filepath, siteRoot, poolDirs, basePath)
  return item
}

/**
 * Process a single data item from a JSON file
 *
 * JSON items are pure data — like YAML items, no ProseMirror conversion.
 * A JSON file containing an array returns all items (single-file collection).
 * A JSON file containing an object returns a single item with slug from filename.
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - JSON filename
 * @returns {Promise<Object|Array|null>} Processed item(s) or null if unpublished
 */
async function processJsonItem(dir, filename, siteRoot, poolDirs, basePath) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const slug = basename(filename, '.json')
  const data = JSON.parse(raw)

  // Array → multiple items (single-file collection)
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        await processDataItemAssets(item, filepath, siteRoot, poolDirs, basePath)
      }
    }
    return data
  }

  // Object → single item
  if (data.published === false) return null
  const item = { slug, ...data }
  await processDataItemAssets(item, filepath, siteRoot, poolDirs, basePath)
  return item
}

/**
 * Process a single BibTeX file into an array of CSL-JSON bibliography items.
 *
 * Each `@entry{key, ...}` becomes one item. The BibTeX cite key is preserved
 * as `id` (CSL-JSON convention) and copied to `slug` so per-record file
 * emission and runtime lookups behave the same as for other formats.
 *
 * No asset processing — bibliography records reference URLs and DOIs, not
 * local files.
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - BibTeX filename (.bib)
 * @returns {Promise<Array<Object>>} Array of CSL-JSON items, each with `slug`
 */
async function processBibtexItem(dir, filename) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const entries = parseBibtex(raw)
  return entries
    .filter(entry => entry && entry.id)
    .map(entry => ({ slug: entry.id, ...entry }))
}

/**
 * Process a single content item from a markdown file
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - Markdown filename
 * @param {Object} config - Collection configuration
 * @param {string} siteRoot - Site root directory for asset resolution
 * @returns {Promise<Object|null>} Processed item or null if unpublished
 */
async function processContentItem(dir, filename, config, siteRoot, basePath, poolDirs) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const slug = basename(filename, extname(filename))

  // Parse frontmatter and body
  const { frontmatter, body } = parseFrontmatter(raw, filepath)

  // Skip unpublished items by default
  if (frontmatter.published === false) {
    return null
  }

  // Parse markdown body to ProseMirror
  const content = markdownToProseMirror(body)

  // Process assets (resolve paths, copy co-located files)
  // This modifies content in place, updating paths to site-root-relative
  await processRecordAssets(content, filepath, siteRoot, poolDirs, basePath)

  // Extract excerpt
  const excerpt = extractExcerpt(frontmatter, content, config.excerpt)

  // Extract first image (frontmatter takes precedence)
  // Note: paths in content have already been updated by processRecordAssets
  const image = frontmatter.image || extractFirstImage(content)

  return {
    slug,
    ...frontmatter,
    excerpt,
    image,
    content
  }
}

/**
 * Every source file in a collection, as paths relative to the collection root —
 * `hello.md`, `2024/spring.md`, `2024/q1/notes.yml`.
 *
 * Nesting is how an author gives a collection an internal structure, and it is
 * what the `path` field and the `under` predicate address. Before this walk the
 * scan was a flat `readdir`, so a record in a subdirectory was not ignored with
 * a warning — it was invisible, and the site simply rendered without it.
 *
 * `_`-prefixed and dot-prefixed names are skipped at every level, files and
 * directories alike: `_drafts/` stays out of the build the same way `_draft.md`
 * always has. That is also the escape hatch for a subdirectory that holds
 * something other than records.
 */
async function collectSourceFiles(dir, rel = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(join(dir, entry.name), relPath)))
    } else if (/\.(md|ya?ml|json|bib)$/i.test(entry.name)) {
      out.push(relPath)
    }
  }
  return out
}

/**
 * A slug identifies one record within its collection — it is what a `[slug]`
 * route matches and what a per-record file is named. Two files in different
 * branches can now share a stem (`2024/notes.md`, `2025/notes.md`), which makes
 * a previously theoretical collision reachable in ordinary authoring.
 *
 * The build does not rename or drop either record: the cascade keeps both, and
 * whichever sorts last wins the route and the per-record file. That is a real
 * ambiguity only the author can resolve, so it is reported rather than repaired.
 */
function warnDuplicateSlugs(items, queryName) {
  const seen = new Map()
  for (const item of items) {
    if (!item || item.slug === undefined) continue
    const slug = String(item.slug)
    const where = item.path ? `${item.path}/` : ''
    if (seen.has(slug)) {
      console.warn(
        `[query-processor] Query "${queryName}" has more than one record with ` +
          `slug "${slug}" (${seen.get(slug)}${slug}, ${where}${slug}). Its detail route and ` +
          `per-record file resolve to only one of them — give them distinct slugs.`
      )
      continue
    }
    seen.set(slug, where)
  }
}

/**
 * Collect and process all items in a collection folder
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} config - Parsed collection config
 * @returns {Promise<Array>} Array of processed items
 */
async function collectItems(siteDir, config, entitiesDir, basePath) {
  // ⭐ THE QUERY NAMES A SCHEMA AND THE POOL FOLLOWS — the same resolution the
  // sync lane makes, from the same reader, so the two lanes cannot disagree
  // about which files are a query's records. They used to: this one recursed
  // into a collection directory and sync did not.
  const pooled = config.poolEntities || []
  if (pooled.length === 0) return []

  const dirOf = (e) => resolve(siteDir, entitiesDir || ENTITIES_DIR, ...e.dirs)

  // Process all entity files (markdown → content items, YAML/JSON → data items,
  // BibTeX → CSL-JSON bibliography items).
  let items = await Promise.all(
    pooled.map((e) => {
      const dir = dirOf(e)
      const file = `${e.slug}${e.ext}`
      if (e.ext === '.bib') {
        return processBibtexItem(dir, file)
      }
      if (e.ext === '.json') {
        return processJsonItem(dir, file, siteDir, e.dirs.join('/'), basePath)
      }
      if (e.ext === '.yml' || e.ext === '.yaml') {
        return processDataItem(dir, file, siteDir, e.dirs.join('/'), basePath)
      }
      return processContentItem(dir, file, config, siteDir, basePath, e.dirs.join('/'))
    })
  )

  // ⭐ `path` IS THE PLACEMENT `records.yml` GAVE THE RECORD, and it is the whole
  // reason folders exist: `where: { path: { under: 'archive' } }` is how a query
  // asks for a slice. Structure is query scope, not navigation.
  //
  // ⛔ THIS WAS HARDCODED TO `''` FOR A WHILE, AND THE COMMENT SAID "until the
  // folder producer lands". It landed, and this was not revisited — so every
  // folder slice matched NOTHING on the delivery lane, silently, which is the one
  // failure mode the whole design is built to prevent. Measured before the fix: a
  // two-record site with an `archive` folder returned `[]` for its own slice.
  //
  // ⚠️ It stays a SCALAR. `matchUnder` in `core/src/where.js` is string-only, so
  // an array would match nothing — one placement per entity is the ruling.
  items = items.map((result, i) => {
    const path = pooled[i] ? (config.placements?.get(pooled[i].id)?.path ?? '') : ''
    if (Array.isArray(result)) return result.map((item) => item && { ...item, path })
    return result && { ...result, path }
  })

  // Flatten one level: array-form YAML/JSON files and every .bib file
  // contribute their entries individually.
  items = items.flat()

  // Filter out nulls (unpublished items)
  items = items.filter(Boolean)

  warnDuplicateSlugs(items, config.name)

  // Add routes to items if collection has a route configured
  if (config.route) {
    const baseRoute = config.route.replace(/\/$/, '') // Remove trailing slash
    items = items.map(item => ({
      ...item,
      route: `${baseRoute}/${item.slug}`
    }))
  }

  // ⛔ ORDER MATCHES `data-fetcher.js::applyPostProcessing` — where, filter, sort,
  // limit. Two lanes evaluate the same declaration (this one materializes a query
  // to `/data/<name>.json`; that one runs a page-level `fetch:`), so a difference
  // in order is a difference in RESULT for any query that both narrows and limits.
  //
  // ⚠️ `where` was missing here entirely until 2026-08-29: `parseQueryConfig`
  // read `filter` and never `where`, so the CANONICAL predicate was parsed, put on
  // the sync wire, stored — and never applied, while the DEPRECATED one it replaced
  // worked. An author following current guidance got silence and shipped unfiltered
  // data. Pinned by `tests/collection-query-terms.test.js`.
  if (config.where) {
    items = applyWhere(items, config.where)
  }

  // Apply the legacy filter expression (deprecated)
  if (config.filter) {
    items = applyFilter(items, config.filter)
  }

  // Apply sort
  if (config.sort) {
    items = applySort(items, config.sort)
  }

  // Apply limit
  if (config.limit > 0) {
    items = items.slice(0, config.limit)
  }

  return items
}

/**
 * Process all content collections defined in site.yml
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} queriesConfig - the resolved QUERY declarations
 * @param {string} [entitiesDir] - pool directory override (`site.yml::paths.entities`)
 * @returns {Promise<Object>} Map of collection name to items array
 *
 * @example
 * const collections = await processQueries('/path/to/site', {
 *   articles: { path: 'collections/articles', sort: 'date desc' },
 *   products: 'collections/products'
 * })
 * // { articles: [...], products: [...] }
 */
export async function processQueries(siteDir, queriesConfig, entitiesDir, basePath = '/') {
  if (!queriesConfig || typeof queriesConfig !== 'object') {
    return {}
  }

  // ⭐ ONE POOL WALK FOR EVERY QUERY. Two queries over the same schema read one
  // set of files; a query reads none of another schema's.
  const pool = await readEntityPool(siteDir, { dir: entitiesDir })
  if (pool.errors.length) {
    for (const e of pool.errors) console.warn(`[query-processor] ${e}`)
  }

  // ⛔ `records.yml` DECIDES WHAT IS PUBLISHED ON THIS LANE TOO, and it did not
  // until now. Only the sync lane honoured it, so removing a record from
  // `records.yml` left it shipping in `/data/<name>.json` on every static host —
  // an author unpublishes a draft and it stays public. Measured before the fix.
  //
  // ⚖️ MISSING IS NOT EMPTY HERE EITHER, but it means something different from
  // what it means to sync. There is no server folder to leave alone, so a site
  // with no `records.yml` is simply not managing publication, and its whole pool
  // is delivered. (Making missing mean "publish nothing" would turn every site
  // without the file into a silently empty one.)
  const recordsCfg = await readRecordsConfig(siteDir)
  if (recordsCfg.error) console.warn(`[query-processor] ${recordsCfg.error}`)
  const managed = recordsCfg.state !== FOLDER_MISSING
  const folder = managed ? resolveFolder(recordsCfg.entries, pool.entities) : null
  if (folder) {
    for (const e of folder.errors) console.error(`[query-processor] ${e}`)
  }
  const published = folder
    ? pool.entities.filter((e) => folder.placements.has(e.id))
    : pool.entities

  const poolBySchema = groupPoolBySchema(published)

  const results = {}

  for (const [name, config] of Object.entries(queriesConfig)) {
    const parsed = parseQueryConfig(name, config)
    parsed.poolEntities = parsed.schema ? poolBySchema.get(parsed.schema) || [] : []
    parsed.placements = folder?.placements ?? null
    if (parsed.poolEntities.length === 0 && !parsed.url) {
      console.warn(
        `[query-processor] Query "${name}" matches no records — nothing ` +
          `published declares ${parsed.schema || '(no schema)'}. ` +
          (managed ? 'Check records.yml lists them.' : 'Check entities/.')
      )
    }
    const items = await collectItems(siteDir, parsed, entitiesDir, basePath)
    results[name] = items
    console.log(`[query-processor] Processed ${name}: ${items.length} items`)
  }

  return results
}

/**
 * Reconcile a deferred collection's per-record directory with the records it
 * should hold this run — delete the `<slug>.json` files that are no longer
 * backed by a record.
 *
 * Why this is not optional. `public/data/` is a persistent, normally-committed
 * directory, so anything written there survives until something removes it.
 * Without this, unpublishing a record (`published: false`, which the build
 * honours automatically) or deleting its source file drops it from the cascade
 * listing — it vanishes from the site — while its per-record file stays on
 * disk with the full body, gets committed, and gets deployed. The author has
 * every reason to believe the content is gone. It is still fetchable at a URL
 * that was public a moment ago.
 *
 * `public/data/` is the build's output directory and nothing else — authors
 * provide structured data through `collections/`, which is the only supported
 * way. So `<name>/` is entirely ours and the reconciliation is total: anything
 * in it that this run did not write is stale by definition. `expected` is
 * empty when a collection stops declaring `deferred:`, which correctly clears
 * a directory that will otherwise never be written again.
 *
 * NOT covered: a collection removed from `site.yml` entirely. There is no
 * declaration left to reconcile against, so pruning it would mean the build
 * asserting ownership of a directory on a name match alone. That needs the
 * ownership question answered on purpose, not as a side effect of this.
 *
 * @param {string} dataDir - `public/data/`, the containing output directory
 * @param {string} name - the declared collection name
 * @param {Set<string>} expected - filenames this run wrote, e.g. `hello.json`
 * @returns {Promise<string[]>} the entry names removed
 */
async function pruneOrphanedRecords(dataDir, name, expected) {
  const recordsDir = join(dataDir, name)

  // This routine deletes, and `name` reaches it from site.yml. A name that
  // resolves outside the output directory would make the traversal somebody
  // else's files, so refuse rather than trust the caller.
  const contained = resolve(recordsDir)
  if (contained !== resolve(dataDir, name) || !contained.startsWith(resolve(dataDir) + sep)) {
    console.warn(
      `[query-processor] Refusing to prune "${name}" — it does not resolve ` +
      `inside ${dataDir}`
    )
    return []
  }
  if (!existsSync(recordsDir)) return []

  const removed = []
  for (const entry of await readdir(recordsDir, { withFileTypes: true })) {
    if (expected.has(entry.name)) continue
    await rm(join(recordsDir, entry.name), { recursive: true, force: true })
    removed.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
  }
  return removed
}

/**
 * Write collection data to JSON files in public/data/
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} collections - Map of collection name to items array
 * @returns {Promise<void>}
 *
 * @example
 * await writeQueryFiles('/path/to/site', {
 *   articles: [{ slug: 'hello', title: 'Hello World', ... }]
 * })
 * // Creates public/data/articles.json
 */
export async function writeQueryFiles(siteDir, byQuery, queriesConfig = null) {
  if (!byQuery || Object.keys(byQuery).length === 0) {
    return
  }

  const dataDir = join(siteDir, 'public', DATA_DIR)
  await mkdir(dataDir, { recursive: true })

  for (const [name, items] of Object.entries(byQuery)) {
    const rawConfig = queriesConfig?.[name]
    const parsed = rawConfig ? parseQueryConfig(name, rawConfig) : null
    const deferred = parsed?.deferred

    if (deferred && deferred.length > 0) {
      // `deferred:` is set — emit two payloads:
      //   1. The cascade JSON at /data/<name>.json with deferred fields stripped.
      //      This is what `data: <name>` declarations deliver everywhere.
      //   2. Per-record full files at /data/<name>/<slug>.json with every field.
      //      Dynamic-route singular fetches and useEntityDetail hooks read these.
      const recordsDir = join(dataDir, name)
      await mkdir(recordsDir, { recursive: true })

      const written = new Set()
      for (const item of items) {
        if (!item || typeof item !== 'object' || !item.slug) continue
        const filename = `${item.slug}.json`
        await writeFile(join(recordsDir, filename), JSON.stringify(item, null, 2))
        written.add(filename)
      }
      const perRecordCount = written.size
      const pruned = await pruneOrphanedRecords(dataDir, name, written)

      const stripped = items.map((item) => {
        if (!item || typeof item !== 'object') return item
        const out = { ...item }
        for (const field of deferred) delete out[field]
        return out
      })
      const cascadePath = join(dataDir, `${name}.json`)
      await writeFile(cascadePath, JSON.stringify(stripped, null, 2))
      console.log(
        `[query-processor] Generated ${cascadePath} (${items.length} items, ` +
        `deferred: [${deferred.join(', ')}]) + ${perRecordCount} per-record files`
      )
      if (pruned.length > 0) {
        // A deletion is always worth naming. These files were public a moment
        // ago, so "which ones went" is the question an author will have.
        console.log(
          `[query-processor] Removed ${pruned.length} stale per-record ` +
          `file(s) from ${recordsDir}: ${pruned.join(', ')}`
        )
      }
    } else {
      const filepath = join(dataDir, `${name}.json`)
      await writeFile(filepath, JSON.stringify(items, null, 2))
      console.log(`[query-processor] Generated ${filepath} (${items.length} items)`)

      // This collection is not deferred, so it has no per-record files. If it
      // used to, the directory is still there and will never be written again
      // — every file in it is stale. Same reconciliation, empty expected set.
      const pruned = await pruneOrphanedRecords(dataDir, name, new Set())
      if (pruned.length > 0) {
        console.log(
          `[query-processor] Removed ${pruned.length} per-record file(s) ` +
          `from ${join(dataDir, name)} — "${name}" no longer declares deferred:`
        )
      }
    }
  }
}

/**
 * Get last modified time for a collection
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} config - Collection config
 * @returns {Promise<Date|null>} Most recent modification time
 */
export async function getQueryLastModified(siteDir, config) {
  const parsed = parseQueryConfig('temp', config)
  const poolDir = join(siteDir, parsed.path)

  if (!existsSync(poolDir)) {
    return null
  }

  const files = await readdir(poolDir)
  const itemFiles = files.filter(f =>
    !f.startsWith('_') &&
    (f.endsWith('.md') || f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json') || f.endsWith('.bib'))
  )

  let lastModified = null

  for (const file of itemFiles) {
    const fileStat = await stat(join(poolDir, file))
    if (!lastModified || fileStat.mtime > lastModified) {
      lastModified = fileStat.mtime
    }
  }

  return lastModified
}
