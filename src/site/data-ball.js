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
import { isLocalAssetPath } from './assets.js'

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

// --- local media in the ball -------------------------------------------------
// Schema-less collection data rides in the ball, so a local image in a schema-less
// record (e.g. a note's `image: /images/x.png`) needs the same upload + serve-URL
// rewrite the entity content gets (emitSyncPackages' `assetRewrite`) — otherwise the
// served `/data/<name>.json` keeps a dangling local path. The deploy collects the
// ball's refs, uploads them on the SAME asset lane, then rewrites the ball before
// uploading it. The backend serves a `serve_url` in the ball identically to one in an
// entity (it unwraps the ball verbatim), so this is purely producer-side.

/**
 * Site-root local asset refs anywhere in the ball (`/images/x.png`, `/collections/...`).
 * Built `dist/data` refs are already site-root (the collection processor copied
 * co-located assets to `public/collections/**`), so only `/`-prefixed refs are collected.
 * @param {{data:object,search:object}|null} ball
 * @returns {string[]} deduped refs to upload
 */
export function collectBallAssets(ball) {
  const refs = new Set()
  const walk = (n) => {
    if (typeof n === 'string') {
      if (isLocalAssetPath(n) && n.startsWith('/')) refs.add(n)
      return
    }
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    if (n && typeof n === 'object') for (const v of Object.values(n)) walk(v)
  }
  walk(ball)
  return [...refs]
}

/**
 * Rewrite the ball: replace every local ref the map covers with its serve URL. Pure —
 * returns a NEW ball (the input is reused elsewhere). A ref the map omits (upload
 * failed/skipped) is left untouched — never a broken URL.
 * @param {{data:object,search:object}|null} ball
 * @param {Record<string,string>} map - ref → serve URL
 * @returns {{data:object,search:object}|null} a new ball, or the input when there's nothing to do
 */
export function rewriteBallAssets(ball, map) {
  if (!ball || !map || Object.keys(map).length === 0) return ball
  const walk = (n) => {
    if (typeof n === 'string') return map[n] || n
    if (Array.isArray(n)) return n.map(walk)
    if (n && typeof n === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(n)) out[k] = walk(v)
      return out
    }
    return n
  }
  return walk(ball)
}
