// ⭐ THE DONE-CRITERION FOR THE FOLDER PRODUCER: an authored `records.yml` that
// says what the old rule DERIVED must produce the same folder.
//
// The old producer grouped record entities by their collection and emitted one
// branch per collection, records as leaves. That was a shadow of a directory
// layout — `collections/<name>/` supplied the grouping — and it is exactly what
// `records.yml` now states instead. So the parity worth pinning is: writing down
// what used to be inferred reproduces it, byte for byte.
//
// ⚠️ THE EXPECTED TREE BELOW IS THE OLD PRODUCER'S OUTPUT, held as a literal.
// It is not a re-derivation from the new code — that would assert only that the
// new code agrees with itself.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntityPool } from '../src/site/entity-pool.js'
import { readRecordsConfig, resolveFolder } from '../src/site/records-config.js'
import { buildFolderEntity } from '../src/uwx/folder.js'

// What `defaultContents` produced for a two-collection site: one branch per
// collection, in declaration order, records as `$ref` leaves.
const OLD_PRODUCER_OUTPUT = [
  {
    kind: 'branch',
    path_segment: 'articles',
    $children: [
      { kind: 'ref', path_segment: 'hello', $ref: 'article/hello' },
      { kind: 'ref', path_segment: 'world', $ref: 'article/world' },
    ],
  },
  {
    kind: 'branch',
    path_segment: 'team',
    $children: [{ kind: 'ref', path_segment: 'ada', $ref: 'person/ada' }],
  },
]

let ROOT
const w = (rel, body = '---\ntitle: X\n---\n\nB\n') => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'folder-parity-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const build = async () => {
  const pool = await readEntityPool(ROOT)
  const cfg = await readRecordsConfig(ROOT)
  const folder = resolveFolder(cfg.entries, pool.entities)
  const entities = pool.entities.map((e) => ({
    id: e.id,
    slug: e.slug,
    uuid: null,
    model: e.schema,
  }))
  return { folder, entity: buildFolderEntity({ recordEntities: entities, folderNodes: folder.nodes }) }
}

describe('records.yml reproduces the grouping the old producer derived', () => {
  beforeEach(() => {
    w('entities/article/hello.md')
    w('entities/article/world.md')
    w('entities/person/ada.md')
  })

  it('an authored two-branch folder equals the old default, node for node', async () => {
    w(
      'records.yml',
      [
        '- folder: articles',
        '  records:',
        '    - article/*.md',
        '- folder: team',
        '  records:',
        '    - person/*.md',
        '',
      ].join('\n')
    )
    const { folder, entity } = await build()
    expect(folder.errors).toEqual([])
    expect(entity.document.contents).toEqual(OLD_PRODUCER_OUTPUT)
    expect(entity.document.$model).toBe('@uniweb/folder')
    expect(entity.document).not.toHaveProperty('$uuid')
  })

  // ⭐ AND THE DIFFERENCE THAT IS THE POINT. The old rule could only ever produce
  // the tree above — one branch per collection, whether or not the author wanted
  // structure. The model's common case is a FLAT pool with queries doing the
  // organizing, and that shape was previously unreachable.
  it('a flat folder is now expressible, and it was not before', async () => {
    w('records.yml', '- article/*.md\n- person/*.md\n')
    const { folder, entity } = await build()
    expect(folder.errors).toEqual([])
    expect(entity.document.contents).toEqual([
      { kind: 'ref', path_segment: 'hello', $ref: 'article/hello' },
      { kind: 'ref', path_segment: 'world', $ref: 'article/world' },
      { kind: 'ref', path_segment: 'ada', $ref: 'person/ada' },
    ])
    // every record at the root — the path a query slices on is the empty string
    expect([...folder.placements.values()].map((p) => p.path)).toEqual(['', '', ''])
  })

  // ⛔ CONTROL. Both cases above assert a SHAPE; without this, a producer that
  // ignored `records.yml` and always emitted one branch per schema would pass the
  // first and could be mistaken for correct.
  it('CONTROL — the tree follows the file, not the pool layout', async () => {
    w(
      'records.yml',
      ['- folder: everything', '  records:', '    - article/*.md', '    - person/*.md', ''].join('\n')
    )
    const { entity } = await build()
    expect(entity.document.contents).toHaveLength(1)
    expect(entity.document.contents[0].path_segment).toBe('everything')
    // two schemas, one branch — impossible under the derived rule
    expect(entity.document.contents[0].$children.map((c) => c.$ref)).toEqual([
      'article/hello',
      'article/world',
      'person/ada',
    ])
  })
})
