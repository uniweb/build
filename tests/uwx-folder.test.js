import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFolderEntity, writeFolderUuid } from '../src/uwx/folder.js'

// The @uniweb/folder entity: one per site sync, a tree of REFERENCES to the
// collection-record entities. A brand-new record is pointed at by `$ref` (its
// payload-local `<collection>/<slug>` handle); an already-minted one by `entry: uuid`.

// Minimal record-entity descriptors (the shape buildCollectionEntities emits).
function rec(collection, slug, uuid = null) {
  return { id: `${collection}/${slug}`, slug, uuid, collection, model: '@acme/x' }
}

describe('buildFolderEntity', () => {
  it('returns null when there are no records', () => {
    expect(buildFolderEntity({ recordEntities: [] })).toBeNull()
    expect(buildFolderEntity({ recordEntities: null })).toBeNull()
  })

  it('default org: one branch per collection, records as leaves ($ref when new)', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello'), rec('articles', 'world'), rec('team', 'ada')],
    })
    expect(folder.model).toBe('@uniweb/folder')
    expect(folder.document.$id).toBe('@folder')
    expect(folder.document).not.toHaveProperty('$uuid') // first sync
    const branches = folder.document.entries
    expect(branches.map((b) => b.path_segment)).toEqual(['articles', 'team'])
    const articles = branches[0]
    expect(articles.kind).toBe('branch')
    expect(articles.entries).toEqual([
      { kind: 'ref', path_segment: 'hello', $ref: 'articles/hello' },
      { kind: 'ref', path_segment: 'world', $ref: 'articles/world' },
    ])
  })

  it('uses entry: uuid for an already-minted record, $ref for a new one', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello', 'uuid-1'), rec('articles', 'world')],
    })
    const leaves = folder.document.entries[0].entries
    expect(leaves[0]).toEqual({ kind: 'ref', path_segment: 'hello', entry: 'uuid-1' })
    expect(leaves[1]).toEqual({ kind: 'ref', path_segment: 'world', $ref: 'articles/world' })
  })

  it('carries the folder $uuid when known (collections.yml)', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello')],
      folderUuid: 'folder-uuid-9',
    })
    expect(folder.uuid).toBe('folder-uuid-9')
    expect(folder.document.$uuid).toBe('folder-uuid-9')
    expect(Object.keys(folder.document).slice(0, 3)).toEqual(['$uuid', '$id', '$model'])
  })

  it('virtual org: collections.yml folders build a branch tree, decoupled from layout', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello'), rec('team', 'ada')],
      folders: [
        { segment: 'blog', label: 'Blog', entries: ['articles'] },
        { segment: 'about', entries: [{ segment: 'people', entries: ['team'] }] },
      ],
    })
    const [blog, about] = folder.document.entries
    expect(blog.path_segment).toBe('blog')
    expect(blog.label).toBe('Blog')
    // a bare collection name inside `entries` expands to its leaves IN this branch
    expect(blog.entries).toEqual([{ kind: 'ref', path_segment: 'hello', $ref: 'articles/hello' }])
    // a nested { segment, entries } makes a sub-branch
    expect(about.entries[0].kind).toBe('branch')
    expect(about.entries[0].path_segment).toBe('people')
    expect(about.entries[0].entries[0]).toEqual({
      kind: 'ref',
      path_segment: 'ada',
      $ref: 'team/ada',
    })
  })
})

describe('writeFolderUuid', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uwx-folder-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates collections.yml with the folder $uuid when none exists', () => {
    const changed = writeFolderUuid(dir, 'folder-uuid-1')
    expect(changed).toBe(true)
    const path = join(dir, 'collections', 'collections.yml')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toMatch(/^\$uuid: folder-uuid-1$/m)
  })

  it('updates the $uuid in place, preserving the rest of collections.yml', () => {
    mkdirSync(join(dir, 'collections'), { recursive: true })
    writeFileSync(
      join(dir, 'collections', 'collections.yml'),
      'sync: true\ncollections:\n  articles:\n    schema: "@/article"\n'
    )
    writeFolderUuid(dir, 'folder-uuid-2')
    const text = readFileSync(join(dir, 'collections', 'collections.yml'), 'utf8')
    expect(text).toMatch(/^\$uuid: folder-uuid-2$/m)
    expect(text).toContain('sync: true')
    expect(text).toContain('schema: "@/article"')
    expect(text.match(/\$uuid:/g)).toHaveLength(1)
  })
})
