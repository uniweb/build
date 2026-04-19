#!/usr/bin/env node
/**
 * Dev backend for testing Uniweb sites with `supports: [where, limit, sort]`.
 *
 * Reads a directory of YAML collections (each subfolder is a collection,
 * each .yml file inside is a record) and exposes them via HTTP. Evaluates
 * where-objects on the server side using @uniweb/core's matchWhere — the
 * exact same evaluator the runtime uses as a fallback. This lets you
 * develop a site against a "real" backend without standing up a database.
 *
 * Wire format matches the framework default fetcher's pushdown conventions
 * (see framework/runtime/src/default-fetcher.js):
 *
 *   GET  /api/{collection}                        — full collection
 *   GET  /api/{collection}?_where=<JSON>          — filtered by where-object
 *   GET  /api/{collection}?_limit=N               — first N records
 *   GET  /api/{collection}?_sort=field:dir        — sorted
 *   POST /api/{collection}  body: { where, ... } — operators in body
 *   GET  /api/{collection}/{slug}                 — single record
 *
 * Usage:
 *   node scripts/framework/dev-backend.js --collections <path> [--port N]
 *
 * Example (academic-metrics):
 *   node scripts/framework/dev-backend.js \
 *     --collections framework/templates/academic-metrics/site/collections \
 *     --port 8080
 *
 * Then in the site's site.yml:
 *   fetcher:
 *     baseUrl: http://localhost:8080
 *     supports: [where, limit, sort]
 *
 * And rewrite collection refs to URLs, e.g.:
 *   fetch: { url: /api/members, schema: members }
 */

import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, basename, extname } from 'node:path'
import { parseArgs } from 'node:util'
import yaml from 'js-yaml'
import { matchWhere } from '@uniweb/core'

const { values } = parseArgs({
  options: {
    collections: { type: 'string', short: 'c' },
    port: { type: 'string', short: 'p', default: '8080' },
  },
})

if (!values.collections) {
  console.error('Usage: dev-backend.js --collections <path> [--port N]')
  process.exit(1)
}

const COLLECTIONS_DIR = resolve(values.collections)
const PORT = Number(values.port)

if (!existsSync(COLLECTIONS_DIR)) {
  console.error(`Collections directory not found: ${COLLECTIONS_DIR}`)
  process.exit(1)
}

// ─── Load collections from disk ─────────────────────────────────────────────

async function loadCollection(dir) {
  const files = await readdir(dir)
  const items = []
  for (const file of files) {
    const ext = extname(file).toLowerCase()
    if (!['.yml', '.yaml', '.json'].includes(ext)) continue
    const filepath = join(dir, file)
    const content = await readFile(filepath, 'utf8')
    let data
    try {
      data = ext === '.json' ? JSON.parse(content) : yaml.load(content)
    } catch (err) {
      console.warn(`[dev-backend] Failed to parse ${filepath}: ${err.message}`)
      continue
    }
    if (data == null) continue
    const slug = basename(file, ext)
    if (Array.isArray(data)) {
      // Array-form file: each element is a record.
      for (const record of data) {
        if (record && typeof record === 'object') items.push(record)
      }
    } else if (typeof data === 'object') {
      items.push({ slug, ...data })
    }
  }
  return items
}

async function loadAllCollections() {
  const entries = await readdir(COLLECTIONS_DIR)
  const collections = {}
  for (const name of entries) {
    const fullPath = join(COLLECTIONS_DIR, name)
    const s = await stat(fullPath)
    if (!s.isDirectory()) continue
    collections[name] = await loadCollection(fullPath)
    console.log(`[dev-backend] Loaded ${collections[name].length} items from "${name}"`)
  }
  return collections
}

// ─── Operator handling (mirrors default-fetcher pushdown wire format) ───────

function applyOperators(items, operators) {
  let result = items
  if (operators.where) {
    result = matchWhere(operators.where, result)
  }
  if (operators.sort) {
    result = applySort(result, operators.sort)
  }
  if (typeof operators.limit === 'number' && operators.limit > 0) {
    result = result.slice(0, operators.limit)
  }
  return result
}

function applySort(items, sortExpr) {
  const sorts = String(sortExpr).split(',').map((s) => {
    const [field, dir = 'asc'] = s.trim().split(/\s+/)
    return { field, desc: dir.toLowerCase() === 'desc' }
  })
  return [...items].sort((a, b) => {
    for (const { field, desc } of sorts) {
      const av = a?.[field] ?? ''
      const bv = b?.[field] ?? ''
      if (av < bv) return desc ? 1 : -1
      if (av > bv) return desc ? -1 : 1
    }
    return 0
  })
}

function parseOperatorsFromQuery(searchParams) {
  const out = {}
  if (searchParams.has('_where')) {
    try {
      out.where = JSON.parse(searchParams.get('_where'))
    } catch (err) {
      throw new Error(`Invalid _where JSON: ${err.message}`)
    }
  }
  if (searchParams.has('_limit')) {
    out.limit = Number(searchParams.get('_limit'))
  }
  if (searchParams.has('_sort')) {
    out.sort = searchParams.get('_sort')
  }
  return out
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) }
      catch (err) { reject(new Error(`Invalid JSON body: ${err.message}`)) }
    })
    req.on('error', reject)
  })
}

// ─── HTTP server ────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function handleRequest(req, res, collections) {
  if (req.method === 'OPTIONS') return send(res, 204, '')

  const url = new URL(req.url, `http://${req.headers.host}`)
  const match = url.pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/)
  if (!match) return send(res, 404, { error: 'Not found' })

  const [, collectionName, slug] = match
  const items = collections[collectionName]
  if (!items) return send(res, 404, { error: `Unknown collection: ${collectionName}` })

  // Single record by slug.
  if (slug) {
    const item = items.find((r) => r?.slug === slug)
    if (!item) return send(res, 404, { error: `No record with slug "${slug}"` })
    return send(res, 200, item)
  }

  // Collection — apply operators from query string (GET) or body (POST).
  let operators
  try {
    operators = req.method === 'POST'
      ? await readJsonBody(req)
      : parseOperatorsFromQuery(url.searchParams)
  } catch (err) {
    return send(res, 400, { error: err.message })
  }

  let result
  try {
    result = applyOperators(items, operators)
  } catch (err) {
    return send(res, 400, { error: `Operator evaluation failed: ${err.message}` })
  }
  return send(res, 200, result)
}

// ─── Boot ───────────────────────────────────────────────────────────────────

const collections = await loadAllCollections()
const knownCollections = Object.keys(collections)
if (knownCollections.length === 0) {
  console.warn('[dev-backend] No collections found.')
}

const server = createServer((req, res) => {
  handleRequest(req, res, collections).catch((err) => {
    console.error('[dev-backend] Request handler threw:', err)
    send(res, 500, { error: 'Internal server error' })
  })
})

server.listen(PORT, () => {
  console.log(`[dev-backend] Listening on http://localhost:${PORT}`)
  console.log(`[dev-backend] Collections: ${knownCollections.join(', ') || '(none)'}`)
  console.log('[dev-backend] Endpoints:')
  for (const name of knownCollections) {
    console.log(`  GET  /api/${name}                  — full collection`)
    console.log(`  GET  /api/${name}?_where=<JSON>    — filtered`)
    console.log(`  GET  /api/${name}/{slug}            — single record`)
    console.log(`  POST /api/${name}  body: { where } — operators in body`)
  }
})
