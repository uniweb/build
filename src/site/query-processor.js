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
 * - Applies the query's fixed `where` and orders by its `sort`; its `limit` is
 *   left to the runtime, which makes each page's set, so every record the query's
 *   fixed `where` selects compiles
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
import { join, basename, extname, dirname, relative, resolve, sep, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { parseBibtex } from '@citestyle/bibtex'
import { DATA_DIR, withoutRouteVariables } from '@uniweb/core'
import { applyWhere, applySort, refuseUnder, refuseOutsideLanguage, refuseQueryRoute, refuseLimit } from './data-fetcher.js'
import { resolveAssetPath, walkContentAssets, isLocalAssetPath } from './assets.js'
import { readEntityPool, groupPoolBySchema, poolDirsForSchema } from './entity-pool.js'
import { readRecordsConfig, resolveFolder } from './records-config.js'
import { isDraftRecord } from './record-draft.js'
import { resolveRecordSchemas } from './queries-config.js'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { toDeliveredRecord, contentBodyField, misplacedFields, mapReferences, recordLayout } from '@uniweb/schemas/conform'
import { collectNestedRefs } from '@uniweb/schemas/format'

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
 *   schema: '@/article',
 *   sort: 'date desc',
 *   where: { featured: true },
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
    // The string shorthand names the SCHEMA — `records/{schema}/` supplies the
    // records, so there is no directory for a query to name.
    return {
      name,
      schema: config,
      url: null,
      scope: null,
      sort: null,
      where: null,
      filter: null,
      limit: 0,
      excerpt: { maxLength: 160 },
      deferred: null,
    }
  }

  refuseUnder(config.where, `queries.${name}`)
  refuseOutsideLanguage(config.where, `queries.${name}`)
  refuseQueryRoute(config, `queries.${name}`)
  refuseLimit(config.limit, `queries.${name}`)
  return {
    name,
    // The query's schema selects its records — `records/{schema}/` declares the
    // model, so the site's records of a schema are the query's records.
    schema: config.schema || null,
    url: config.url || null,
    // The folder branch the query reads (`folder.yml` placement). ⛔ Not read
    // here until 2026-09-11: a named query's `scope` was ignored on this lane.
    scope: typeof config.scope === 'string' ? config.scope : null,
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
    // ships with `query: <name>` declarations, and per-record full files
    // are emitted at public/data/<name>/<slug>.json. Components that
    // need the full record fetch the per-record file on demand, either
    // automatically on dynamic-route pages (entity-store routes the
    // singular detail there) or via kit's useWholeRecord hook.
    deferred: Array.isArray(config.deferred) ? config.deferred.slice() : null,
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
 * Where a record's co-located asset is published — its path below `public/records/`.
 *
 * ⭐ THE RECORD'S OWN HOME, keyed by where the file sits in the pool. It was
 * `public/collections/<queryName>/`, which meant the SAME image was copied once per
 * query that returned the record, under two URLs. Third instance of the same
 * conflation (after the freeform locale tree and the translation manifest): an asset
 * belongs to a record, and which query selects it is not a fact about it.
 *
 * ⭐ ITS PATH UNDER THE RECORDS ROOT, whole. ⛔ Until 2026-09-14 it was the record's
 * schema folder plus the asset's BASENAME, so `./a/pic.png` and `./b/pic.png` under
 * one schema folder were copied to one file — the last one won — and a record showed
 * another record's picture. Now a file beside its record keeps the URL it always had
 * (`article/pic.png`), a file in a subfolder keeps its subfolder (`article/img/pic.png`),
 * and one elsewhere under the root keeps its own path (`../shared/logo.svg` from
 * `records/article/` → `shared/logo.svg`).
 *
 * A file OUTSIDE the records root has no such path, so it is named for where it is:
 * `_external/<hash>-<name>`, the hash being the first 8 hex digits of the sha-256 of
 * its path relative to the records root — the same on every machine with the same
 * layout, and different for two files that share a name.
 *
 * @param {string} resolved - the asset's absolute path
 * @param {string} recordsRoot - the site's records root, absolute
 * @returns {string} a `/`-separated path below `records/`
 */
function recordAssetPath(resolved, recordsRoot) {
  const rel = relative(recordsRoot, resolved)
  const posix = rel.split(sep).join('/')
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  if (inside) return posix
  const hash = createHash('sha256').update(posix).digest('hex').slice(0, 8)
  return `_external/${hash}-${basename(resolved)}`
}

/**
 * Copy one of a record's assets to its home under `public/records/` (`recordAssetPath`).
 *
 * @returns {Promise<{ url: string, copied: string }>} its URL under `basePath`, and the copy
 */
async function publishRecordAsset(resolved, siteRoot, recordsRoot, basePath) {
  const path = recordAssetPath(resolved, recordsRoot)
  const copied = join(siteRoot, 'public', 'records', ...path.split('/'))
  await mkdir(dirname(copied), { recursive: true })
  await copyFile(resolved, copied)
  return { url: `${basePath}records/${path}`, copied }
}

/**
 * Process assets in collection content
 * - Resolves relative paths to site-root-relative paths
 * - Copies co-located assets to public/records/, by their path under the records
 *   root (`recordAssetPath`)
 * - Updates paths in the content in place
 *
 * @param {Object} content - ProseMirror document
 * @param {string} itemPath - Path to the markdown file
 * @param {string} siteRoot - Site root directory
 * @param {string} recordsRoot - The site's records directory, absolute
 * @param {string} basePath - Site base path (e.g., '/' or '/docs/')
 * @returns {Promise<Object>} Asset manifest for this item
 */
async function processRecordAssets(content, itemPath, siteRoot, recordsRoot, basePath) {
  const assets = {}
  const publicDir = join(siteRoot, 'public')

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
        // Copy to public/records/, and point the content at the copy
        const { url, copied } = await publishRecordAsset(result.resolved, siteRoot, recordsRoot, basePath)
        finalPath = url

        assets[src] = {
          original: src,
          resolved: result.resolved,
          copied,
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
        node.attrs.poster = (await publishRecordAsset(posterResult.resolved, siteRoot, recordsRoot, basePath)).url
      }
    }

    if (node.attrs.preview && !isExternalUrl(node.attrs.preview)) {
      const previewResult = resolveAssetPath(node.attrs.preview, itemPath, siteRoot)
      if (previewResult.resolved && existsSync(previewResult.resolved)) {
        node.attrs.preview = (await publishRecordAsset(previewResult.resolved, siteRoot, recordsRoot, basePath)).url
      }
    }
  }

  return assets
}

/**
 * Process assets in a record's data — a YAML/JSON record, or a markdown record's
 * frontmatter
 * - Recursively walks the data object looking for local asset paths
 * - Copies co-located assets to public/records/, by their path under the records
 *   root (`recordAssetPath`)
 * - Rewrites paths to absolute URLs (with base path)
 *
 * @param {Object} data - Parsed data object (mutated in place)
 * @param {string} itemPath - Path to the record's file
 * @param {string} siteRoot - Site root directory
 * @param {string} recordsRoot - The site's records directory, absolute
 * @param {string} basePath - Site base path (e.g., '/' or '/docs/')
 */
async function processDataItemAssets(data, itemPath, siteRoot, recordsRoot, basePath) {
  async function walk(parent, key) {
    const val = parent[key]
    if (typeof val === 'string' && isLocalAssetPath(val)) {
      if (val.startsWith('./') || val.startsWith('../')) {
        const resolved = resolve(dirname(itemPath), val)
        if (existsSync(resolved)) {
          parent[key] = (await publishRecordAsset(resolved, siteRoot, recordsRoot, basePath)).url
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
 * @param {Object} config - the parsed query (`includeDrafts`, `dataSchema`)
 * @returns {Promise<Object|Array|null>} Processed item(s), or null for a draft this run withholds
 */
async function processDataItem(dir, filename, siteRoot, recordsRoot, basePath, config) {
  const filepath = join(dir, filename)
  const where = relative(siteRoot, filepath)
  const raw = await readFile(filepath, 'utf-8')
  const data = yaml.load(raw, YAML_OPTIONS) || {}
  return processDataRecords(data, basename(filename, extname(filename)), filepath, where, siteRoot, recordsRoot, basePath, config)
}

/**
 * The records a YAML or JSON file holds, delivered (`deliverRecord`): an array → one
 * record per entry, each carrying its own `slug`; a mapping → one record, its `slug` the
 * file's name unless it states one.
 */
async function processDataRecords(data, fileSlug, filepath, where, siteRoot, recordsRoot, basePath, config) {
  // Array → multiple items (single-file collection). A draft entry is dropped
  // BEFORE its assets are copied, so nothing of it ships.
  if (Array.isArray(data)) {
    const out = []
    for (const [i, item] of data.entries()) {
      if (withheld(item, `${where} [${i}]`, config.includeDrafts)) continue
      if (item && typeof item === 'object') {
        await processDataItemAssets(item, filepath, siteRoot, recordsRoot, basePath)
      }
      out.push(deliverRecord(item, config, `${where} [${i}]`))
    }
    return out
  }

  // Mapping → single item
  if (withheld(data, where, config.includeDrafts)) return null
  const item = { slug: fileSlug, ...data }
  await processDataItemAssets(item, filepath, siteRoot, recordsRoot, basePath)
  return deliverRecord(item, config, where)
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
 * @param {Object} config - the parsed query (`includeDrafts`, `dataSchema`)
 * @returns {Promise<Object|Array|null>} Processed item(s), or null for a draft this run withholds
 */
async function processJsonItem(dir, filename, siteRoot, recordsRoot, basePath, config) {
  const filepath = join(dir, filename)
  const where = relative(siteRoot, filepath)
  const raw = await readFile(filepath, 'utf-8')
  const data = JSON.parse(raw)
  return processDataRecords(data, basename(filename, '.json'), filepath, where, siteRoot, recordsRoot, basePath, config)
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
 * @param {string} siteRoot - Site root, for messages
 * @param {boolean} [includeDrafts] - keep `draft: true` records (a preview)
 * @returns {Promise<Array<Object>>} Array of CSL-JSON items, each with `slug`
 */
async function processBibtexItem(dir, filename, siteRoot, includeDrafts = false) {
  const filepath = join(dir, filename)
  const where = relative(siteRoot, filepath)
  const raw = await readFile(filepath, 'utf-8')
  const entries = parseBibtex(raw)
  return entries
    .filter(entry => entry && entry.id && !withheld(entry, `${where} @${entry.id}`, includeDrafts))
    .map(entry => ({ slug: entry.id, ...entry }))
}

/**
 * Is this record left out of this run? A draft is, unless the run previews drafts.
 * `isDraftRecord` also refuses the retired `published: false` — on every run.
 */
function withheld(data, where, includeDrafts) {
  return isDraftRecord(data, where) && !includeDrafts
}

/**
 * Process a single content item from a markdown file
 *
 * @param {string} dir - Collection directory path
 * @param {string} filename - Markdown filename
 * @param {Object} config - Collection configuration
 * @param {string} siteRoot - Site root directory for asset resolution
 * @param {string} basePath - Site base path (e.g., '/' or '/docs/')
 * @param {string} recordsRoot - The site's records directory, absolute
 * @returns {Promise<Object|null>} Processed item, or null for a draft this run withholds
 */
async function processContentItem(dir, filename, config, siteRoot, basePath, recordsRoot) {
  const filepath = join(dir, filename)
  const raw = await readFile(filepath, 'utf-8')
  const slug = basename(filename, extname(filename))

  // Parse frontmatter and body
  const { frontmatter, body } = parseFrontmatter(raw, filepath)

  // A draft is left out — before its assets are copied, so nothing of it ships.
  if (withheld(frontmatter, relative(siteRoot, filepath), config.includeDrafts)) {
    return null
  }

  // ⭐ THE FRONTMATTER IS THE RECORD'S DATA, so a co-located path in it is published
  // exactly as a YAML or JSON record's field is. ⛔ Until 2026-09-14 it was neither
  // copied nor rewritten: `image: ./cover.jpg` reached the compiled record as written,
  // a path relative to a file no visitor can reach, while the same line in a `.yml`
  // record was published.
  await processDataItemAssets(frontmatter, filepath, siteRoot, recordsRoot, basePath)

  // Parse markdown body to ProseMirror
  const content = markdownToProseMirror(body)

  // Process assets (resolve paths, copy co-located files)
  // This modifies content in place, updating paths to site-root-relative
  await processRecordAssets(content, filepath, siteRoot, recordsRoot, basePath)

  return deliverRecord({ slug, ...frontmatter }, config, relative(siteRoot, filepath), { doc: content, markdown: body })
}

/**
 * One record as its file holds it → the record a component receives.
 *
 * ⭐ THE SHAPE A HOST'S RECORDS SERVICE ANSWERS — measured 2026-09-24 on a local
 * backend: the brief's fields at the top and every other section under its own name
 * (`@uniweb/schemas/conform`'s `toDeliveredRecord`), with a markdown body in the
 * schema's content body field — the ProseMirror document for a `format: prosemirror`
 * field (`article_body.content`, for `@std/article`), the markdown source for a markup
 * `text` one. A component is written against one shape, so a static site hands it that
 * one (ruled 2026-09-24 [Diego]: the same as hosted). ⛔ Until then a record reached a
 * component as its file held it, its body in `content` at the top — a shape no host
 * delivers.
 *
 * `$name` is the record's handle, taken BEFORE the lift: a brief may declare a `slug`
 * field of its own (`@std/article`'s does), and the lift puts that one over the file's.
 *
 * A record whose query has no data schema (`resolveRecordSchemas`) is delivered as its
 * file holds it, a markdown body as `content`, which is what the static lane always did;
 * so is a body its schema has no field for — a push refuses that one. A markdown record
 * also gets `excerpt` and `image` where it states none, derived from its body: the
 * static lane's own, and not what a host adds.
 *
 * Its references are delivered hydrated, as a host delivers them (`referenceHydrator`).
 *
 * ⛔ A record written in the retired flat form (`misplacedFields`) STOPS THE BUILD, as it
 * stops a push: which section a key belongs in is not a guess to make.
 *
 * @param {*} record - the record as its file holds it, `slug` included
 * @param {Object} config - the parsed query (`dataSchema`, `excerpt`)
 * @param {string} where - the file, and the entry in a file of several, for a message
 * @param {{ doc: Object, markdown: string }|null} [body] - a markdown record's body
 * @returns {*} the delivered record (anything but a record, as it came)
 */
function deliverRecord(record, config, where, body = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  const schema = config.dataSchema || null
  let out
  if (!schema) {
    out = body
      ? {
          ...record,
          excerpt: extractExcerpt(record, body.doc, config.excerpt),
          // paths in the record and the body have already been rewritten
          image: record.image || extractFirstImage(body.doc),
          content: body.doc,
        }
      : { ...record }
  } else {
    const misplaced = misplacedFields(schema, record)
    if (misplaced.length) throw new Error(flatFormRefusal(where, config.schema, schema, misplaced))
    out = { ...toDeliveredRecord(schema, record) }
    if (body) {
      placeBody(out, schema, body)
      out.excerpt = extractExcerpt(out, body.doc, config.excerpt)
      out.image = out.image || extractFirstImage(body.doc)
    }
    if (config.references) out = config.references.deliver(schema, out, where)
  }
  const handle = record.slug
  if (handle !== undefined && handle !== null && handle !== '') out.$name = String(handle)
  return out
}

/**
 * Put a markdown body where the delivered record carries its schema's content body
 * field (`contentBodyField`) — unless the record already states that field, or the body
 * is empty. With no such field the body stays `content`, at the top.
 */
function placeBody(out, schema, body) {
  const blank = !body.markdown || !body.markdown.trim()
  const target = contentBodyField(schema)
  if (!target) {
    if (!blank) out.content = body.doc
    return
  }
  if (blank) return
  const value = target.field?.type === 'text' ? body.markdown : body.doc
  if (!target.section) {
    if (out[target.key] == null) out[target.key] = value
    return
  }
  const held = out[target.section]
  // A section that is not a record is the file's to fix — `uniweb validate` names it.
  if (held != null && (typeof held !== 'object' || Array.isArray(held))) return
  if (held?.[target.key] != null) return
  out[target.section] = { ...(held || {}), [target.key]: value }
}

/**
 * The message a record written in the retired flat form stops the build with — each
 * misplaced key (`misplacedFields`) moved under the section that declares it.
 *
 * @param {string} where - the file, for the message
 * @param {string|null} ref - the schema's ref, as the query names it
 * @param {Object} schema - the normalized schema
 * @param {Array<{ key: string, sections: string[] }>} misplaced
 * @returns {string}
 */
export function flatFormRefusal(where, ref, schema, misplaced) {
  const under = new Map()
  const either = []
  for (const { key, sections } of misplaced) {
    if (sections.length === 1) {
      if (!under.has(sections[0])) under.set(sections[0], [])
      under.get(sections[0]).push(key)
    } else {
      either.push(`"${key}" under ${sections.map((n) => `"${n}:"`).join(' or ')}`)
    }
  }
  const moves = [
    ...[...under].map(([section, keys]) => `${keys.map((k) => `"${k}"`).join(', ')} under "${section}:"`),
    ...either,
  ]
  const names = Object.keys(schema.sections || {}).map((n) => `"${n}"`).join(', ')
  return (
    `[uniweb] ${where}: ${ref || schema.name} records are written by section, each section ` +
    `under its own name (${names}) — move ${moves.join('; ')}.`
  )
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
 * Read a set of pooled record files, each by its format (markdown → content items,
 * YAML/JSON → data items, BibTeX → CSL-JSON), delivering each as `config` says. A
 * record's co-located assets are copied by their path under the records directory
 * (`recordAssetPath`).
 *
 * @returns {Promise<Array>} one result per file — a record, a list of them, or null
 */
function readPooledRecords(pooled, config, siteDir, recordsRoot, basePath) {
  return Promise.all(
    pooled.map((e) => {
      const dir = resolve(recordsRoot, ...e.dirs)
      const file = `${e.slug}${e.ext}`
      if (e.ext === '.bib') {
        return processBibtexItem(dir, file, siteDir, config.includeDrafts)
      }
      if (e.ext === '.json') {
        return processJsonItem(dir, file, siteDir, recordsRoot, basePath, config)
      }
      if (e.ext === '.yml' || e.ext === '.yaml') {
        return processDataItem(dir, file, siteDir, recordsRoot, basePath, config)
      }
      return processContentItem(dir, file, config, siteDir, basePath, recordsRoot)
    })
  )
}

/**
 * References, delivered as a host's records service delivers them — measured 2026-09-24
 * on a local backend: `{ entity, brief }`, the record a reference names reduced to its
 * brief's fields, `entity` being its id (here, the one its file carries, if any). So a
 * component reads `talk.speaker.brief.name` on a static site and a hosted one alike.
 * ⚠️ A host also sends `model`, the Model's id on that backend; nothing a static build
 * holds corresponds to it, and whether it stays is backend's to say.
 *
 * The records a reference names are read here, once per data schema, whether or not a
 * query selects them — and without their own references delivered, as a host delivers
 * one level.
 *
 * A reference names its record by handle — its file's name, or `slug:` — or by the id
 * its file carries. One that names no record of its schema is delivered as written, with
 * a warning; `uniweb validate` reports it too.
 */
function referenceHydrator({ poolBySchema, dataSchemas, siteDir, recordsRoot, basePath, includeDrafts }) {
  const targets = new Map() // schema ref → Map(name or own id → the delivered reference)
  const warned = new Set()

  const load = async (ref) => {
    const schema = dataSchemas[ref] || null
    const pooled = poolBySchema.get(ref) || []
    const byName = new Map()
    if (!schema || pooled.length === 0) return byName
    const config = { schema: ref, dataSchema: schema, includeDrafts, excerpt: { maxLength: 160 }, references: null }
    const keys = briefKeysOf(schema)
    for (const result of await readPooledRecords(pooled, config, siteDir, recordsRoot, basePath)) {
      for (const record of [result].flat()) {
        if (!record || typeof record !== 'object') continue
        const delivered = {
          ...(typeof record.$uuid === 'string' ? { entity: record.$uuid } : {}),
          brief: pickBrief(record, keys),
        }
        if (record.$name !== undefined) byName.set(String(record.$name), delivered)
        if (typeof record.$uuid === 'string') byName.set(record.$uuid, delivered)
      }
    }
    return byName
  }

  return {
    async prepare(refs) {
      for (const ref of refs || []) {
        if (!targets.has(ref)) targets.set(ref, await load(ref))
      }
    },
    deliver(schema, record, where) {
      return mapReferences(
        schema,
        record,
        (value, { path, ref }) => {
          const hit = typeof value === 'string' ? targets.get(ref)?.get(value) : undefined
          if (hit) return hit
          const key = `${where} ${path}`
          if (typeof value === 'string' && !warned.has(key)) {
            warned.add(key)
            console.warn(`[query-processor] ${where}: "${path}" names "${value}", and no record of ${ref} is called that.`)
          }
          return value
        },
        { delivered: true }
      )
    },
  }
}

// The keys of a record's brief — the fields of the section a reference hydrates to: the
// one section of a flat schema, else the brief. Null when there is none (a list at the
// root), and the whole record stands in for it, as a host answers such a Model.
function briefKeysOf(schema) {
  const layout = recordLayout(schema)
  if (!layout) return null
  if (schema.fields) return Object.keys(schema.fields)
  const def = layout.flat ? layout.sections[0][1] : layout.sections.find(([name]) => name === layout.brief)?.[1]
  return def ? [...Object.keys(def.fields || {}), ...Object.keys(def.sections || {})] : null
}

// A delivered record's brief: its brief's fields that it has, or — with no brief — every
// field but the record's own keys.
function pickBrief(record, keys) {
  const out = {}
  if (keys) {
    for (const key of keys) if (record[key] !== undefined) out[key] = record[key]
    return out
  }
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('$') && !['slug', 'path', 'excerpt', 'image', 'draft'].includes(key)) out[key] = value
  }
  return out
}

/**
 * Collect and process all of a query's records
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} config - Parsed query config, carrying its `poolEntities`
 * @param {string} recordsRoot - The site's records directory, absolute
 * @returns {Promise<Array>} Array of processed items
 */
async function collectItems(siteDir, config, recordsRoot, basePath, locale = null) {
  // ⭐ THE QUERY NAMES A SCHEMA AND THE RECORDS FOLLOW — the same resolution the
  // sync lane makes, from the same reader, so the two lanes cannot disagree
  // about which files are a query's records. They used to: this one recursed
  // into a collection directory and sync did not.
  const pooled = config.poolEntities || []
  if (pooled.length === 0) return []

  // The records this query's references name, read before its own — delivering one
  // is synchronous (`deliverRecord`).
  if (config.dataSchema && config.references) {
    await config.references.prepare(collectNestedRefs(config.dataSchema))
  }

  // Process every record file (markdown → content items, YAML/JSON → data items,
  // BibTeX → CSL-JSON bibliography items).
  let items = await readPooledRecords(pooled, config, siteDir, recordsRoot, basePath)

  // ⭐ `path` IS THE FOLDER `folder.yml` PLACED THE RECORD IN — `''` at the top —
  // and it is the whole reason folders exist: `scope: archive` is how a query asks
  // for a slice. Structure is query scope, not navigation.
  //
  // ⛔ THIS WAS HARDCODED TO `''` FOR A WHILE, AND THE COMMENT SAID "until the
  // folder producer lands". It landed, and this was not revisited — so every
  // folder slice matched NOTHING on the delivery lane, silently, which is the one
  // failure mode the whole design is built to prevent. Measured before the fix: a
  // two-record site with an `archive` folder returned `[]` for its own slice.
  //
  // ⚠️ It stays a SCALAR. `@uniweb/core`'s `withinScope` matches strings only, so
  // an array would match nothing — one placement per record is the ruling.
  items = items.map((result, i) => {
    const path = pooled[i] ? (config.placements?.get(pooled[i].id)?.path ?? '') : ''
    if (Array.isArray(result)) return result.map((item) => item && { ...item, path })
    return result && { ...result, path }
  })

  // Flatten one level: array-form YAML/JSON files and every .bib file
  // contribute their entries individually.
  items = items.flat()

  // Filter out nulls (drafts this run withholds)
  items = items.filter(Boolean)

  // ⭐ `$name` IS THE RECORD HANDLE ON EVERY SITE (ruled 2026-09-11 [Diego]) — the
  // field a `[slug]` or `[...path]` page matches, and the one the records service
  // serves. It is the record's FINAL slug — a frontmatter `slug:` (which wins over the
  // filename), a BibTeX cite key and an array-form file's own `slug` all count — exactly
  // what our sync sends as the entry's name (`uwx/entity-source.js`). `deliverRecord`
  // sets it for a markdown, YAML or JSON record, before the brief is lifted (a brief's
  // own `slug` FIELD must not become the handle); a BibTeX entry gets it here. `slug`
  // stays: foundations and templates read it.
  items = items.map((item) => (
    item && typeof item === 'object' && item.$name === undefined &&
    item.slug !== undefined && item.slug !== null && item.slug !== ''
      ? { ...item, $name: String(item.slug) }
      : item
  ))

  warnDuplicateSlugs(items, config.name)

  // ⛔ ORDER MATCHES `data-fetcher.js::applyPostProcessing` — where, then sort. Two
  // lanes evaluate the same declaration (this one materializes a query to
  // `/data/<name>.json`; that one runs a page-level `fetch:`), so a difference in
  // order is a difference in RESULT.
  //
  // ⚠️ `where` was missing here entirely until 2026-08-29: `parseQueryConfig`
  // read `filter` and never `where`, so the CANONICAL predicate was parsed, put on
  // the sync wire, stored — and never applied, while the DEPRECATED one it replaced
  // worked. An author following current guidance got silence and shipped unfiltered
  // data. Pinned by `tests/collection-query-terms.test.js`.
  // ⭐ ONLY THE `where` FIXED FOR EVERY PAGE. A clause bound to the route —
  // `where: { tag: :dir }` — cannot be applied to a file written once for every
  // page; the runtime binds it per page (`@uniweb/core/fetch-config`,
  // `resolveQuerySource`). ⛔ Until 2026-09-11 it was applied here to the literal
  // `':dir'`, and the query compiled to no records (measured).
  //
  // ⛔ `scope` is NEVER baked, fixed or routed — the runtime applies it, as the
  // records service does, so a routed `scope: :dir` binds per page.
  const fixed = withoutRouteVariables({ where: config.where })
  if (fixed.where) {
    items = applyWhere(items, fixed.where)
  }

  // The query's `sort` orders the file; the runtime applies whichever sort wins —
  // a binding's own, else this one — so the order here only spares it the work.
  // Texts collate in the site's default language; each page re-sorts in its own.
  if (config.sort) {
    items = applySort(items, config.sort, { locale })
  }

  // ⛔ `limit` IS NEVER BAKED. A query's `limit` is part of its set (ruled 2026-09-14
  // [Diego]), but the set is made per page: `scope` and the route-bound clauses the
  // runtime applies first differ from page to page, and the `limit` cuts what they
  // leave — so a file cut here would cut before them. Every record the query's fixed
  // `where` selects compiles, in its `sort`; the runtime makes each page's set and then
  // applies the fetch's `narrow` (`@uniweb/core`'s `evaluateQuery`), and a parametric
  // page is expanded over the set (`prerender.js`). ⛔ Until 2026-09-13 this sliced the
  // file — before a page's `scope` or routed clauses, which the runtime has applied
  // since 2026-09-11, could select anything from it.

  return items
}

/**
 * Compile every query over the site's records
 *
 * @param {string} siteDir - Site root directory
 * @param {Object} queriesConfig - the resolved QUERY declarations
 * @param {string} [recordsDir] - the records directory (`site.yml::paths.records`),
 *   site-root-relative or absolute; resolved from `site.yml` when absent
 * @param {string} [basePath='/']
 * @param {Object} [options]
 * @param {string|null} [options.locale] - the site's default language, which a query's `sort`
 *   collates texts in when it orders the compiled file
 * @param {boolean} [options.includeDrafts=false] - keep `draft: true` records: a preview
 *   (`pnpm dev`) or a check (`uniweb validate`). Off for anything a site DELIVERS — a
 *   draft is a record that is not delivered while the site is published.
 * @param {Object} [options.dataSchemas] - normalized data schemas by ref, to deliver the
 *   records in; resolved from the site's foundation when absent (`resolveRecordSchemas`)
 * @returns {Promise<Object>} Map of query name to items array
 *
 * @example
 * const byQuery = await processQueries('/path/to/site', {
 *   articles: { schema: '@/article', sort: 'date desc' },
 * })
 * // { articles: [...] }
 */
export async function processQueries(siteDir, queriesConfig, recordsDir, basePath = '/', options = {}) {
  const { locale = null, includeDrafts = false } = options
  if (!queriesConfig || typeof queriesConfig !== 'object') {
    return {}
  }

  // ⭐ ONE WALK FOR EVERY QUERY. Two queries over the same schema read one set of
  // files; a query reads none of another schema's.
  const pool = await readEntityPool(siteDir, recordsDir ? { dir: recordsDir } : {})
  if (pool.errors.length) {
    for (const e of pool.errors) console.warn(`[query-processor] ${e}`)
  }

  // ⭐ EVERY FILE IN `records/` IS A RECORD (ruled 2026-09-21 [Diego]), so every one
  // is compiled; `records/folder.yml` only says which folder each sits in (`path`),
  // which is what a query's `scope` reads. ⛔ Until 2026-09-21 `records.yml`, at the
  // site root, listed the records, and an unlisted file was left out of
  // `/data/<name>.json` here.
  //
  // ⛔ A MALFORMED FILE STILL STOPS THE BUILD. It read as absent here until
  // 2026-09-14 while the sync lane refused the same file (`uwx/records.js`); what an
  // author meant to organize cannot be guessed.
  const recordsCfg = await readRecordsConfig(siteDir, { dir: pool.dir })
  if (recordsCfg.error) {
    throw new Error(
      `[uniweb] ${recordsCfg.error}\n` +
        `  ${recordsCfg.file} says which folder each record sits in, and a query's \`scope:\` reads that — fix it to build.`
    )
  }
  const folder = resolveFolder(recordsCfg.entries, pool.entities, { dir: pool.dir })
  for (const e of folder.errors) console.error(`[query-processor] ${e}`)
  for (const w of folder.warnings) console.warn(`[query-processor] ${w}`)

  const poolBySchema = groupPoolBySchema(pool.entities)
  const recordsRoot = resolve(siteDir, pool.dir)

  // ⭐ THE DATA SCHEMA EACH QUERY'S RECORDS ARE DELIVERED IN (`deliverRecord`) — resolved
  // from the foundation's source once for every query. A query with none compiles its
  // records as their files hold them.
  const dataSchemas = options.dataSchemas ?? (await querySchemas(siteDir, queriesConfig))
  const references = referenceHydrator({ poolBySchema, dataSchemas, siteDir, recordsRoot, basePath, includeDrafts })

  const results = {}

  for (const [name, config] of Object.entries(queriesConfig)) {
    // ⭐ AN EXTERNAL QUERY COMPILES NOTHING — its records are its address's, fetched
    // where the page renders (`@uniweb/core/fetch-config`). A file written here would
    // be an empty `/data/<name>.json` standing in for a live source.
    if (config && typeof config === 'object' && config.url !== undefined) continue
    const parsed = parseQueryConfig(name, config)
    parsed.poolEntities = parsed.schema ? poolBySchema.get(parsed.schema) || [] : []
    parsed.placements = folder.placements
    parsed.includeDrafts = includeDrafts
    parsed.dataSchema = (parsed.schema && dataSchemas[parsed.schema]) || null
    parsed.references = references
    if (parsed.poolEntities.length === 0) {
      const dirs = parsed.schema ? poolDirsForSchema(parsed.schema) : null
      console.warn(
        `[query-processor] Query "${name}" matches no records — ` +
          (dirs
            ? `${pool.dir}/${dirs.join('/')}/ holds none for ${parsed.schema}.`
            : `it declares no schema whose records live in ${pool.dir}/.`)
      )
    }
    const items = await collectItems(siteDir, parsed, recordsRoot, basePath, locale)
    results[name] = items
    console.log(`[query-processor] Processed ${name}: ${items.length} items`)
  }

  return results
}

/**
 * The data schemas of the site's record queries, by ref (`resolveRecordSchemas`). A ref
 * that is not a schema-less query's name and still does not resolve is warned about:
 * its records are compiled as their files hold them, which is not the shape a
 * component receives from a host.
 */
async function querySchemas(siteDir, queriesConfig) {
  const refs = []
  for (const config of Object.values(queriesConfig)) {
    if (config && typeof config === 'object' && config.url !== undefined) continue
    const ref = typeof config === 'string' ? config : config?.schema
    if (typeof ref === 'string') refs.push(ref)
  }
  const { schemas, failures } = await resolveRecordSchemas(siteDir, refs)
  for (const { ref, message } of failures) {
    console.warn(
      `[query-processor] Data schema ${ref} did not resolve, so its records are compiled as ` +
        `their files hold them rather than as a component receives them: ${message}`
    )
  }
  return schemas
}

/**
 * Reconcile a deferred collection's per-record directory with the records it
 * should hold this run — delete the `<slug>.json` files that are no longer
 * backed by a record.
 *
 * Why this is not optional. `public/data/` is a persistent, normally-committed
 * directory, so anything written there survives until something removes it.
 * Without this, making a record a draft (`draft: true`, which the build honours
 * automatically) or deleting its source file drops it from the cascade
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
      //      This is what `query: <name>` declarations deliver everywhere.
      //   2. Per-record full files at /data/<name>/<slug>.json with every field.
      //      Dynamic-route singular fetches and kit's useWholeRecord read these.
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
