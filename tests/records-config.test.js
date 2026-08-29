// `records.yml` — the folder. Listing an entity is what makes it a record.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntityPool } from '../src/site/entity-pool.js'
import {
  readRecordsConfig,
  resolveFolder,
  matchEntityPattern,
  slugForEntity,
  FOLDER_MISSING,
  FOLDER_EMPTY,
  FOLDER_DECLARED,
} from '../src/site/records-config.js'

let ROOT
const w = (rel, body = '---\ntitle: X\n---\n\nB\n') => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const pool = async () => (await readEntityPool(ROOT)).entities
const folder = async (yml) => {
  if (yml !== null) w('records.yml', yml)
  const cfg = await readRecordsConfig(ROOT)
  return { cfg, ...resolveFolder(cfg.entries, await pool()) }
}
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'records-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the three states — missing, empty and declared are NOT two things', () => {
  it('missing is inert', async () => {
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.state).toBe(FOLDER_MISSING)
    expect(cfg.entries).toEqual([])
  })

  it('empty is a declared, empty folder — the destructive one', async () => {
    // ⭐ The asymmetry is deliberate: the safe state is the ABSENCE of a file, so
    // a live folder cannot be wiped by deleting one. Collapsing these into one
    // behaviour would delete a capability.
    w('records.yml', '')
    expect((await readRecordsConfig(ROOT)).state).toBe(FOLDER_EMPTY)
    w('records.yml', '[]\n')
    expect((await readRecordsConfig(ROOT)).state).toBe(FOLDER_EMPTY)
  })

  it('declared carries the list', async () => {
    w('records.yml', '- person/ada.md\n')
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.state).toBe(FOLDER_DECLARED)
    expect(cfg.entries).toEqual(['person/ada.md'])
  })

  it('refuses a mapping, and shows the shape it wants', async () => {
    w('records.yml', 'person:\n  - ada.md\n')
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.error).toContain('must be a LIST')
    expect(cfg.error).toContain('- person/*.md')
  })
})

describe('the common case is three lines', () => {
  it('places a flat pool at the root, every record with the empty path', async () => {
    w('entities/person/ada.md')
    w('entities/person/grace.md')
    w('entities/project/folding.md')
    const { nodes, placements, errors, warnings } = await folder('- person/*.md\n- project/*.md\n')
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(nodes.map((n) => [n.kind, n.path_segment])).toEqual([
      ['ref', 'ada'],
      ['ref', 'grace'],
      ['ref', 'folding'],
    ])
    expect([...placements.values()].every((p) => p.path === '')).toBe(true)
  })

  it('names one file exactly, extension included', async () => {
    w('entities/person/ada.md')
    const { nodes, errors } = await folder('- person/ada.md\n')
    expect(errors).toEqual([])
    expect(nodes).toHaveLength(1)
  })

  it('orders numerically but NEVER strips the number from the slug', async () => {
    // ⛔ A leading number is a DATE at least as often as it is an order, and
    // nothing in the filename tells them apart — so it is read to SORT by and
    // never to rename. Ordering: 1, 2, 10, not the string order 1, 10, 2.
    w('entities/post/10-tenth.md')
    w('entities/post/2-second.md')
    w('entities/post/1-first.md')
    const { nodes, errors } = await folder('- post/*.md\n')
    expect(errors).toEqual([])
    expect(nodes.map((n) => n.path_segment)).toEqual(['1-first', '2-second', '10-tenth'])
  })
})

describe('structure is QUERY SCOPE — a folder is an addressable dimension', () => {
  it('nests, recursively, and stamps each record with the path a query slices on', async () => {
    w('entities/publication/2026-a.md')
    w('entities/publication/2025-b.md')
    w('entities/publication/2023-c.md')
    const { nodes, placements, errors } = await folder(
      [
        '- publication/2026-*.md',
        '- folder: archive',
        '  label: Publication Archive',
        '  records:',
        '    - publication/2025-*.md',
        '    - folder: pre-2024',
        '      records:',
        '        - publication/2023-*.md',
        '',
      ].join('\n')
    )
    expect(errors).toEqual([])
    const byId = (id) => placements.get(id).path
    expect(byId('publication/2026-a')).toBe('')
    expect(byId('publication/2025-b')).toBe('archive')
    expect(byId('publication/2023-c')).toBe('archive/pre-2024')

    const archive = nodes.find((n) => n.kind === 'branch')
    expect(archive.name).toBe('Publication Archive')
    expect(archive.$children.map((c) => c.kind)).toEqual(['ref', 'branch'])
  })

  it('warns about a folder holding nothing — a folder exists to be queried', async () => {
    w('entities/person/ada.md')
    const { warnings } = await folder('- person/*.md\n- folder: empty\n  records: []\n')
    expect(warnings.some((x) => x.includes('holds no records'))).toBe(true)
  })
})

describe('⛔ error rules — every one of these used to fail silently', () => {
  it('a path naming a missing file is a hard error', async () => {
    w('entities/person/ada.md')
    const { errors } = await folder('- person/nobody.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not in entities/')
  })

  it('a pattern matching ZERO files is an error, not an empty branch', async () => {
    // Today's measured behaviour was `{path_segment: "artcles", $children: []}` —
    // a real, reachable, empty path, with no warning.
    w('entities/article/a.md')
    const { errors } = await folder('- artcle/*.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('matches no entity')
  })

  it('⛔ the same entity placed twice is an error, and it names BOTH entries', async () => {
    // One placement per entity. `where.js::matchUnder` is string-only, so a
    // record with two paths would match nothing under `under:` — silently.
    w('entities/publication/2026-a.md')
    const { errors } = await folder('- publication/2026-*.md\n- publication/*.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('placed twice')
    expect(errors[0]).toContain('[0]')
    expect(errors[0]).toContain('[1]')
  })

  it('catches a duplicate across a folder boundary too', async () => {
    w('entities/publication/2025-b.md')
    const { errors } = await folder(
      '- publication/*.md\n- folder: archive\n  records:\n    - publication/2025-*.md\n'
    )
    expect(errors.some((e) => e.includes('placed twice'))).toBe(true)
  })

  it('⛔ rejects url:/asset: loudly rather than dropping them', async () => {
    w('entities/person/ada.md')
    const { errors } = await folder(
      '- person/*.md\n- asset: media/report.pdf\n- url: https://example.org/x\n'
    )
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('asset')
    expect(errors[1]).toContain('url')
    for (const e of errors) expect(e).toContain('refused rather than dropped')
  })

  it('reports an entity nothing references — a draft, not an error', async () => {
    w('entities/person/ada.md')
    w('entities/person/draft-only.md')
    const { errors, warnings } = await folder('- person/ada.md\n')
    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('draft-only')
    expect(warnings[0]).toContain('no query can reach it')
  })

  it('refuses an entry with no recognized kind', async () => {
    const { errors } = await folder('- query: recent\n')
    expect(errors[0]).toContain('no recognized kind')
  })

  // ⛔ CONTROL. Every case above asserts a REFUSAL; without this one, a resolver
  // that placed nothing at all would pass all of them.
  it('CONTROL — a well-formed file places its records and reports nothing', async () => {
    w('entities/person/ada.md')
    const { nodes, errors, warnings } = await folder('- person/*.md\n')
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(nodes).toHaveLength(1)
  })
})

describe('pattern matching', () => {
  it('does NOT let * cross a slash', () => {
    // ⚠️ Deliberately unlike `@uniweb/core`'s globMatch, which backs the `like`
    // predicate over an opaque value. Same syntax, different question.
    expect(matchEntityPattern('person/*.md', 'person/ada.md')).toBe(true)
    expect(matchEntityPattern('person/*.md', 'std/person/ada.md')).toBe(false)
    expect(matchEntityPattern('*/*.md', 'person/ada.md')).toBe(true)
    expect(matchEntityPattern('*/*.md', 'std/person/ada.md')).toBe(false)
  })

  it('reaches an org-scoped schema folder', () => {
    expect(matchEntityPattern('std/person/*.md', 'std/person/ada.md')).toBe(true)
  })

  it('treats a dot literally', () => {
    expect(matchEntityPattern('person/a.md', 'person/axmd')).toBe(false)
  })

  it('the slug is the filename stem, whole', () => {
    expect(slugForEntity({ slug: '01-lab-opens' })).toBe('01-lab-opens')
    expect(slugForEntity({ slug: 'ada' })).toBe('ada')
  })

  // ⭐ The case that settled it, straight out of the records model's own example
  // pool: `post/01-lab-opens.md` and `publication/2026-03-nature-folding.md` sit
  // side by side, and no rule can strip the first without mangling the second.
  it('a date-named record keeps its whole name and sorts chronologically', async () => {
    w('entities/publication/2026-03-nature-folding.md')
    w('entities/publication/2025-11-jmlr-priors.md')
    const { nodes, errors } = await folder('- publication/*.md\n')
    expect(errors).toEqual([])
    expect(nodes.map((n) => n.path_segment)).toEqual([
      '2025-11-jmlr-priors',
      '2026-03-nature-folding',
    ])
  })
})
