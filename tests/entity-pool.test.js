// `entities/{schema}/` — the pool, and the one thing its path declares.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readEntityPool,
  groupPoolBySchema,
  schemaForPoolDirs,
  poolPathReadings,
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
    w('entities/person/ada.md')
    w('entities/std/person/grace.md')
    w('entities/acme/project/folding.yml', 'title: Folding\n')
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
    w('entities/std/loose.md')          // a file at depth 1 → `std` is a schema
    w('entities/std/person/grace.md')   // a file at depth 2 → `std` is an org
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities.find((e) => e.id === 'std/loose').schema).toBe('@/std')
    expect(entities.find((e) => e.id === 'std/person/grace').schema).toBe('@std/person')
  })
})

describe('shape errors — reported, never silent', () => {
  it('refuses a file directly in entities/, which names no model', async () => {
    w('entities/orphan.md')
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
    w('entities/person/2024/ada.md')
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
    w('entities/person/2024/spring/ada.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(entities).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('@person/2024')
    expect(errors[0]).toContain('records.yml')
  })

  // ⛔ CONTROL. Every assertion above is about something being REFUSED; without
  // this one, a reader that returned nothing at all would pass all of them.
  it('CONTROL — a well-shaped pool produces entities and no errors', async () => {
    w('entities/person/ada.md')
    const { entities, errors } = await readEntityPool(ROOT)
    expect(errors).toEqual([])
    expect(entities).toHaveLength(1)
  })
})

describe('reading the pool', () => {
  it('is absent, not empty, when the site has no entities/', async () => {
    w('site.yml', 'name: X\n')
    const pool = await readEntityPool(ROOT)
    expect(pool.exists).toBe(false)
    expect(pool.entities).toEqual([])
  })

  it('skips hidden and underscore-prefixed names', async () => {
    w('entities/person/ada.md')
    w('entities/person/_draft.md')
    w('entities/_scratch/x.md')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.id)).toEqual(['person/ada'])
  })

  it('ignores files that are not entity sources', async () => {
    w('entities/person/ada.md')
    w('entities/person/notes.txt', 'not a record')
    w('entities/person/photo.png', 'x')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.id)).toEqual(['person/ada'])
  })

  it('accepts every source extension the sync lane reads', async () => {
    w('entities/person/a.md')
    w('entities/person/b.yml', 'title: B\n')
    w('entities/person/c.yaml', 'title: C\n')
    w('entities/person/d.json', '{"title":"D"}')
    w('entities/person/e.bib', '@article{e, title={E}}')
    const { entities } = await readEntityPool(ROOT)
    expect(entities.map((e) => e.slug)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('orders the pool stably — the package digest depends on it', async () => {
    for (const n of ['zeta', 'alpha', 'Mid', 'beta']) w(`entities/person/${n}.md`)
    const a = await readEntityPool(ROOT)
    const b = await readEntityPool(ROOT)
    expect(a.entities.map((e) => e.id)).toEqual(b.entities.map((e) => e.id))
    expect(a.entities.map((e) => e.slug)).toEqual(['Mid', 'alpha', 'beta', 'zeta'])
  })

  it('groups by the schema each path declares', async () => {
    w('entities/person/ada.md')
    w('entities/person/grace.md')
    w('entities/std/person/alan.md')
    const { entities } = await readEntityPool(ROOT)
    const bySchema = groupPoolBySchema(entities)
    expect([...bySchema.keys()].sort()).toEqual(['@/person', '@std/person'])
    expect(bySchema.get('@/person').map((e) => e.slug)).toEqual(['ada', 'grace'])
    expect(bySchema.get('@std/person').map((e) => e.slug)).toEqual(['alan'])
  })
})
