import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCollectionsConfig } from '../src/uwx/collections-config.js'

// collections.yml resolution: the co-located, local-first collections document
// layered over site.yml::collections and the subfolder-name schema convention.

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
  it('zero-config: no collections.yml, no site.yml::collections → empty', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.hasCollectionsYml).toBe(false)
    expect(cfg.declarations).toEqual({})
    expect(cfg.folders).toBeNull()
    expect(cfg.folderSync).toBe(true)
  })

  it('legacy site.yml::collections still resolves; schema defaults to the singular', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\ncollections:\n  articles:\n    path: collections/articles\n    sort: date desc\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    const a = cfg.declarations.articles
    expect(a.path).toBe('collections/articles')
    expect(a.sort).toBe('date desc')
    expect(a.schema).toBe('@/article') // subfolder-name convention default
    expect(a.schemaExplicit).toBe(false) // convention → soft-skip if unresolved
  })

  it('an explicit model: becomes schema (explicit) — a synonym during migration', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\ncollections:\n  articles:\n    path: collections/articles\n    model: "@acme/article"\n')
    const a = (await resolveCollectionsConfig(ROOT)).declarations.articles
    expect(a.schema).toBe('@acme/article')
    expect(a.schemaExplicit).toBe(true)
  })

  it('collections.yml is the home for file-based decls; path is relative to collections/', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    w('collections/collections.yml', '$uuid: folder-9\ncollections:\n  team:\n    schema: "@/person"\n  posts:\n    path: blog\n')
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.hasCollectionsYml).toBe(true)
    // a stray `$uuid` in collections.yml is ignored — the framework holds no folder uuid
    expect(cfg).not.toHaveProperty('folderUuid')
    expect(cfg.declarations.team.schema).toBe('@/person')
    expect(cfg.declarations.team.schemaExplicit).toBe(true)
    // path default = the collection name, lifted to a site-root-relative path
    expect(cfg.declarations.team.path).toBe('collections/team')
    // an explicit collections.yml path is relative to collections/
    expect(cfg.declarations.posts.path).toBe('collections/blog')
    expect(cfg.declarations.posts.schema).toBe('@/post') // convention default
  })

  it('collections.yml wins per-key over site.yml::collections', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\ncollections:\n  articles:\n    path: collections/articles\n    sort: date desc\n    schema: "@acme/article"\n')
    w('collections/collections.yml', 'collections:\n  articles:\n    sort: title asc\n')
    const a = (await resolveCollectionsConfig(ROOT)).declarations.articles
    expect(a.sort).toBe('title asc') // collections.yml overrode
    expect(a.schema).toBe('@acme/article') // site.yml key survived (not overridden)
  })

  it('whole-folder sync opt-out and the virtual folders org are surfaced', async () => {
    w('site.yml', 'name: X\nfoundation: "@a/b@1"\n')
    w(
      'collections/collections.yml',
      'sync: false\ncollections:\n  articles:\n    schema: "@/article"\n    sync: false\nfolders:\n  - segment: blog\n    entries: [articles]\n'
    )
    const cfg = await resolveCollectionsConfig(ROOT)
    expect(cfg.folderSync).toBe(false)
    expect(cfg.declarations.articles.sync).toBe(false)
    expect(cfg.folders).toEqual([{ segment: 'blog', entries: ['articles'] }])
  })
})
