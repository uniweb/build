// `records/{schema}/` — the site's records, and the one thing each path declares.
// Placing a file here is what makes it a record.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readEntityPool,
  groupPoolBySchema,
  schemaForPoolDirs,
  poolPathReadings,
  resolveRecordsDir,
} from '../src/site/entity-pool.js'

let ROOT
const w = (rel, body = '---\ntitle: X\n---\n\nBody.\n') => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'pool-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('depth names the scope', () => {
  it('maps one segment to the self scope and two to an org', () => {
    expect(schemaForPoolDirs(['person'])).toBe('@/person')
    expect(schemaForPoolDirs(['std', 'person'])).toBe('@std/person')
    expect(schemaForPoolDirs(['acme', 'project'])).toBe('@acme/project')
    expect(schemaForPoolDirs([])).toBeNull()
    expect(schemaForPoolDirs(['a', 'b', 'c'])).toBeNull()
  })

  it('reads both depths out of one pool, with the FILE deciding', async () => {
    w('records/person/ada.md')
    w('records/std/person/grace.md')
    w('records/acme/project/folding.yml', 'title: Folding\n')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities.map((e) => [e.id, e.schema])).toEqual([
      ['acme/project/folding', '@acme/project'],
      ['person/ada', '@/person'],
      ['std/person/grace', '@std/person'],
    ])
  })

  // ⭐ The case the depth rule exists to make unambiguous. A directory is never
  // classified; only a file's depth is read. So `std` can be BOTH an org and a
  // schema name in one pool without either reading becoming a guess.
  it('a name is an org or a schema depending only on where the file sits', async () => {
    w('records/std/loose.md')          // a file at depth 1 → `std` is a schema
    w('records/std/person/grace.md')   // a file at depth 2 → `std` is an org
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities.find((e) => e.id === 'std/loose').schema).toBe('@/std')
    expect(entities.find((e) => e.id === 'std/person/grace').schema).toBe('@std/person')
  })
})

describe('shape errors — reported, never silent', () => {
  it('refuses a file directly in records/, which names no model', async () => {
    w('records/orphan.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(entities).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('names no model')
  })

  // ⚠️ A FILE AT DEPTH 2 ALWAYS READS AS `@<org>/<name>` — including the case an
  // author meant as "records organised by year inside a schema". The rule is
  // total, so this is not an error HERE; it is a schema `@person/2024` that will
  // not resolve, and the lane holding the foundation's schema map raises it with
  // both readings named. Pinned so the split is a decision, not an oversight.
  it('a file at depth 2 reads as an org schema even when that was not the intent', async () => {
    w('records/person/2024/ada.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities.map((e) => e.schema)).toEqual(['@person/2024'])
  })

  it('names both readings for a depth-2 path, so the error can say them', async () => {
    expect(poolPathReadings(['person', '2024'])).toEqual({
      read: '@person/2024',
      alternative: '@/person',
    })
    expect(poolPathReadings(['person'])).toEqual({ read: '@/person', alternative: null })
  })

  it('refuses nesting BELOW a schema folder, and says how the path was read', async () => {
    w('records/person/2024/spring/ada.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(entities).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('@person/2024')
    expect(errors[0]).toContain('records/folder.yml')
  })

  // ⛔ CONTROL. Every assertion above is about something being REFUSED; without
  // this one, a reader that returned nothing at all would pass all of them.
  it('CONTROL — a well-shaped pool produces entities and no errors', async () => {
    w('records/person/ada.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities).toHaveLength(1)
  })
})

describe('reading the pool', () => {
  it('is absent, not empty, when the site has no records/', async () => {
    w('site.yml', 'name: X\n')
    const pool = await readEntityPool(ROOT)
    expect(pool.exists).toBe(false)
    expect(pool.entities).toEqual([])
  })

  it('skips hidden and underscore-prefixed names', async () => {
    w('records/person/ada.md')
    w('records/person/_draft.md')
    w('records/_scratch/x.md')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.id)).toEqual(['person/ada'])
  })

  it('ignores files that are not entity sources', async () => {
    w('records/person/ada.md')
    w('records/person/notes.txt', 'not a record')
    w('records/person/photo.png', 'x')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.id)).toEqual(['person/ada'])
  })

  it('accepts every source extension the sync lane reads', async () => {
    w('records/person/a.md')
    w('records/person/b.yml', 'title: B\n')
    w('records/person/c.yaml', 'title: C\n')
    w('records/person/d.json', '{"title":"D"}')
    w('records/person/e.bib', '@article{e, title={E}}')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.slug)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('orders the pool stably — the package digest depends on it', async () => {
    for (const n of ['zeta', 'alpha', 'Mid', 'beta']) w(`records/person/${n}.md`)
    const a = await readEntityPool(ROOT)
    const b = await readEntityPool(ROOT)
    expect(a.entities.map((e) => e.id)).toEqual(b.entities.map((e) => e.id))
    expect(a.entities.map((e) => e.slug)).toEqual(['Mid', 'alpha', 'beta', 'zeta'])
  })

  it('groups by the schema each path declares', async () => {
    w('records/person/ada.md')
    w('records/person/grace.md')
    w('records/std/person/alan.md')
    const { entities } = await readEntityPool(ROOT)
    const bySchema = groupPoolBySchema(entities)
    expect([...bySchema.keys()].sort()).toEqual(['@/person', '@std/person'])
    expect(bySchema.get('@/person').map((e) => e.slug)).toEqual(['ada', 'grace'])
    expect(bySchema.get('@std/person').map((e) => e.slug)).toEqual(['alan'])
  })
})

// ⭐ ONE RESOLVER FOR WHERE RECORDS LIVE — the build, the push and the pull all ask
// it. ⛔ Until 2026-09-21 only the build honoured the override (then
// `paths.entities`), so a site that moved its records built and then failed to push.
describe('where the records live — `site.yml::paths.records`', () => {
  it('defaults to records/', () => {
    expect(resolveRecordsDir(ROOT)).toEqual({ rel: 'records', abs: join(ROOT, 'records') })
  })

  it('honours paths.records, read from site.yml by every reader', async () => {
    w('site.yml', 'name: X\npaths:\n  records: content/data\n')
    w('content/data/person/ada.md')
    expect(resolveRecordsDir(ROOT).rel).toBe('content/data')
    const pool = await readEntityPool(ROOT)
    expect(pool.dir).toBe('content/data')
    expect(pool.entities.map((e) => e.id)).toEqual(['person/ada'])
  })

  it('honours an ABSOLUTE paths.records', async () => {
    // ⛔ `join(siteRoot, '/abs')` names a path under the site root; this read one
    // that did not exist until the reader resolved instead of joining.
    const elsewhere = mkdtempSync(join(tmpdir(), 'pool-abs-'))
    try {
      mkdirSync(join(elsewhere, 'person'), { recursive: true })
      writeFileSync(join(elsewhere, 'person', 'ada.md'), '---\ntitle: A\n---\n')
      w('site.yml', `name: X\npaths:\n  records: ${elsewhere}\n`)
      const pool = await readEntityPool(ROOT)
      expect(pool.exists).toBe(true)
      expect(pool.entities.map((e) => e.id)).toEqual(['person/ada'])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('⛔ refuses paths.entities by name — it is paths.records now', async () => {
    w('site.yml', 'name: X\npaths:\n  entities: data\n')
    expect(() => resolveRecordsDir(ROOT)).toThrow(/`paths\.entities` is now `paths\.records`/)
    await expect(readEntityPool(ROOT)).rejects.toThrow(/paths\.records/)
  })

  it('⛔ refuses a leftover entities/ directory, naming the move', async () => {
    // A renamed directory fails silently otherwise: its files are simply not read,
    // and a site with no records looks exactly like one whose records moved.
    w('entities/person/ada.md')
    await expect(readEntityPool(ROOT)).rejects.toThrow(/entities\/ is not read.*git mv entities records/)
  })

  // ⛔ CONTROL for the two refusals: a site that CHOSE the old name keeps it.
  it('CONTROL — paths.records: entities keeps the old directory, and is not refused', async () => {
    w('site.yml', 'name: X\npaths:\n  records: entities\n')
    w('entities/person/ada.md')
    const pool = await readEntityPool(ROOT)
    expect(pool.entities.map((e) => e.id)).toEqual(['person/ada'])
  })
})
