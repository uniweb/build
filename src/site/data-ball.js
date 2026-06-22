/**
 * Data ball — the static-delivery half of a composite `uniweb deploy`. A site's
 * collections partition by schema presence: a collection that resolves a data schema
 * syncs as folder entities; a SCHEMA-LESS collection has no entity model, so its built
 * `dist/data/<name>.json` (cascade + any `deferred:` per-record files) is delivered
 * statically. This bundles that schema-less subset of `dist/data/**` plus the whole
 * `dist/_search/**` index into one JSON doc the deploy uploads as a single
 * content-addressed asset; the backend unwraps it into the `/data/*` + `/_search/*`
 * bytes the gateway serves.
 *
 *   { data:   { "<relpath-under-data>":    <json> },   // schema-less collections only
 *     search: { "<relpath-under-_search>": <json> } }  // the whole (baked) index
 *
 * Search is NOT filtered: the index is baked over all content (the live/baked seam —
 * schema-backed lists are served live from entities, but their search entries are baked
 * here until the next deploy).
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

// Walk a dist subdir for *.json → { "<posix-relpath>": <parsedJson> }. Unparseable
// files are skipped (build-emitted data is always valid JSON; this just stays safe).
async function readJsonTree(dir) {
  if (!existsSync(dir)) return {}
  const out = {}
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const full = join(entry.parentPath || entry.path, entry.name)
    const rel = relative(dir, full).split(sep).join('/')
    try {
      out[rel] = JSON.parse(await readFile(full, 'utf8'))
    } catch {
      // not valid JSON — skip
    }
  }
  return out
}

// The collection a `dist/data` relpath belongs to: the first path segment, minus a
// trailing `.json`. `articles.json` → `articles`; `articles/hello.json` → `articles`.
function collectionOf(relPath) {
  const first = relPath.split('/')[0]
  return first.endsWith('.json') ? first.slice(0, -5) : first
}

/**
 * Assemble the static-data ball from a built site's dist/.
 *
 * @param {string} distDir - the site's built dist/ directory
 * @param {string[]} [schemalessNames] - collection names with no data schema (from
 *        `emitSyncPackages(...).schemaless`); only these contribute `data`.
 * @returns {Promise<{ data: Object, search: Object }|null>} null when there is nothing
 *          to deliver (no schema-less data AND no search index).
 */
export async function assembleDataBall(distDir, schemalessNames = []) {
  const schemaless = new Set(schemalessNames)
  const allData = await readJsonTree(join(distDir, 'data'))
  const data = {}
  for (const [relPath, value] of Object.entries(allData)) {
    if (schemaless.has(collectionOf(relPath))) data[relPath] = value
  }
  const search = await readJsonTree(join(distDir, '_search'))
  if (Object.keys(data).length === 0 && Object.keys(search).length === 0) return null
  return { data, search }
}
