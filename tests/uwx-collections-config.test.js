import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCollectionsConfig } from '../src/uwx/collections-config.js'

// queries.yml resolution: the bare map of named queries at the site root, layered
// over `site.yml::queries` and the query-name schema convention.
//
// Reached through the `uwx/` re-export on purpose — that shim is an explicit
// allowlist, and a rename that misses it makes the symbol silently absent rather
// than failing at the definition. See the framework CLAUDE.md trap list.

let ROOT
function w(rel, body) {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-colcfg-'))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('resolveCollectionsConfig', () => {
  it('zero-config: no queries.yml, no site.yml::queries → empty', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.hasQueriesYml).toBe(false)
    expect(cfg.declarations).toEqual({})
    expect(cfg.folders).toBeNull()
    expect(cfg.folderSync).toBe(true)
  })

  it('site.yml::queries resolves; schema defaults to the query name', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\nqueries:\n  articles:\n    sort: date desc\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    const a = cfg.declarations.articles
    expect(a.path).toBeUndefined() // a file-based query names a schema, not a directory
    expect(a.sort).toBe('date desc')
    expect(a.schema).toBe('@/articles') // query-name convention default — identity, not singular
    expect(a.schemaExplicit).toBe(false) // convention → soft-skip if unresolved
  })

  it('an explicit model: becomes schema (explicit) — a synonym during migration', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\nqueries:\n  articles:\n    model: "@acme/article"\n')
    const a = (await resolveCollectionsConfig(ROOT)).declarations.articles
    expect(a.schema).toBe('@acme/article')
    expect(a.schemaExplicit).toBe(true)
  })

  it('queries.yml is a BARE MAP, and a string entry names the schema', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    w('queries.yml', 'team:\n  schema: "@/person"\nposts: "@/article"\nnotes: {}\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.hasQueriesYml).toBe(true)
    // the framework holds no folder uuid — the backend owns the site's folder
    expect(cfg).not.toHaveProperty('folderUuid')
    expect(cfg.declarations.team.schema).toBe('@/person')
    expect(cfg.declarations.team.schemaExplicit).toBe(true)
    expect(cfg.declarations.posts.schema).toBe('@/article') // the string shorthand
    expect(cfg.declarations.notes.schema).toBe('@/notes') // convention default — identity
    // No query names a directory: `entities/{schema}/` is the pool.
    for (const d of Object.values(cfg.declarations)) expect(d.path).toBeUndefined()
  })

  it('queries.yml wins per-key over site.yml::queries', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\nqueries:\n  articles:\n    sort: date desc\n    schema: "@acme/article"\n')
    w('queries.yml', 'articles:\n  sort: title asc\n')
    const a = (await resolveCollectionsConfig(ROOT)).declarations.articles
    expect(a.sort).toBe('title asc') // queries.yml overrode
    expect(a.schema).toBe('@acme/article') // site.yml key survived (not overridden)
  })

  // ⛔ `sync:` and `folders:` were `collections.yml` keys and are GONE — the model
  // deletes the first (referencing nothing in `records.yml` is the control) and
  // moves the second into `records.yml`. A file still carrying them declares two
  // queries with those names; nothing is silently honoured.
  it('a stray `sync:`/`folders:` is just a query name now, never a control', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    w('queries.yml', 'sync: false\nfolders:\n  - segment: blog\narticles:\n  schema: "@/article"\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.folderSync).toBe(true)
    expect(cfg.folders).toBeNull()
    expect(cfg.declarations.articles.schema).toBe('@/article')
  })
})
