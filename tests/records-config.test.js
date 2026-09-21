// `records/folder.yml` — how the site's records folder is ORGANIZED. Every file in
// `records/` is a record already (placing it there is what makes one); this file
// only sorts records into sub-folders, and a flat site has none. It lives IN the
// records directory — the one file there that is not a record — and was
// `records.yml` at the site root until 2026-09-21.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntityPool } from '../src/site/entity-pool.js'
import {
  readRecordsConfig,
  resolveFolder,
  matchEntityPattern,
  slugForEntity,
} from '../src/site/records-config.js'

let ROOT
const w = (rel, body = '---\ntitle: X\n---\n\nB\n') => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const pool = async () => (await readEntityPool(ROOT)).entities
const folder = async (yml) => {
  if (yml !== null) w('records/folder.yml', yml)
  const cfg = await readRecordsConfig(ROOT)
  return { cfg, ...resolveFolder(cfg.entries, await pool()) }
}
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'records-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('folder.yml — missing and empty mean the same: no sub-folders', () => {
  it('missing is no organization', async () => {
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg).toEqual({ exists: false, entries: [], error: null, file: 'records/folder.yml' })
  })

  it('empty is no organization too — it cannot remove anything', async () => {
    // ⛔ Until 2026-09-21 an empty file was the DESTRUCTIVE state (the folder holds
    // nothing), because this file listed the records. The directory lists them now.
    w('records/folder.yml', '')
    expect(await readRecordsConfig(ROOT)).toEqual({ exists: true, entries: [], error: null, file: 'records/folder.yml' })
    w('records/folder.yml', '[]\n')
    expect(await readRecordsConfig(ROOT)).toEqual({ exists: true, entries: [], error: null, file: 'records/folder.yml' })
  })

  it('a list is carried as written', async () => {
    w('records/folder.yml', '- folder: archive\n  records:\n    - person/ada.md\n')
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.error).toBeNull()
    expect(cfg.entries).toEqual([{ folder: 'archive', records: ['person/ada.md'] }])
  })

  it('refuses a mapping, and shows the shape it wants', async () => {
    w('records/folder.yml', 'person:\n  - ada.md\n')
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.error).toContain('must be a LIST of folders')
    expect(cfg.error).toContain('- folder: archive')
  })
})

describe('⭐ folder.yml lives IN the records directory — the one file there that is not a record', () => {
  it('is read from records/, and is not itself read as a record', async () => {
    w('records/person/ada.md')
    w('records/folder.yml', '- folder: team\n  records:\n    - person/ada.md\n')
    const found = await readEntityPool(ROOT)
    expect(found.entities.map((e) => e.id)).toEqual(['person/ada'])
    expect(found.errors).toEqual([])
    const cfg = await readRecordsConfig(ROOT, { dir: found.dir })
    expect(cfg.file).toBe('records/folder.yml')
    expect(cfg.entries).toEqual([{ folder: 'team', records: ['person/ada.md'] }])
  })

  it('CONTROL — any other file at the top of records/ still names no model', async () => {
    w('records/person/ada.md')
    w('records/other.yml', 'title: X\n')
    const found = await readEntityPool(ROOT)
    expect(found.errors).toHaveLength(1)
    expect(found.errors[0]).toContain('records/other.yml sits directly in `records/`, which names no model')
    expect(found.errors[0]).toContain('The one file that belongs at the top is `folder.yml`')
  })

  it('moves with paths.records — the organization travels with the directory', async () => {
    w('site.yml', 'name: X\npaths:\n  records: content/records\n')
    w('content/records/person/ada.md')
    w('content/records/folder.yml', '- folder: team\n  records:\n    - person/ada.md\n')
    const cfg = await readRecordsConfig(ROOT)
    expect(cfg.file).toBe('content/records/folder.yml')
    expect(cfg.entries).toEqual([{ folder: 'team', records: ['person/ada.md'] }])
  })

  it('⛔ the retired records.yml at the site root is refused by name, naming the move', async () => {
    // Left in place it would be read by nothing: every record at the top of the
    // folder, and a push replacing the backend folder's sub-folders with that.
    w('records/person/ada.md')
    w('records.yml', '- folder: team\n  records:\n    - person/ada.md\n')
    await expect(readEntityPool(ROOT)).rejects.toThrow('git mv records.yml records/folder.yml')
    await expect(readEntityPool(ROOT, { dir: 'records' })).rejects.toThrow('records.yml is not read')
    await expect(readRecordsConfig(ROOT)).rejects.toThrow('git mv records.yml records/folder.yml')
  })

  it('⛔ … and names the moved directory when paths.records is set', async () => {
    w('site.yml', 'name: X\npaths:\n  records: content/records\n')
    w('content/records/person/ada.md')
    w('records.yml', '- folder: team\n')
    await expect(readEntityPool(ROOT)).rejects.toThrow('git mv records.yml content/records/folder.yml')
  })
})

describe('every record in the directory is placed — no folder.yml needed', () => {
  it('a flat site: every record at the top of the folder, with the empty path', async () => {
    w('records/person/ada.md')
    w('records/person/grace.md')
    w('records/project/folding.md')
    const { nodes, placements, errors, warnings } = await folder(null)
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(nodes.map((n) => [n.kind, n.name])).toEqual([
      ['ref', 'ada'],
      ['ref', 'grace'],
      ['ref', 'folding'],
    ])
    expect(placements.size).toBe(3)
    expect([...placements.values()].every((p) => p.path === '')).toBe(true)
  })

  it('a file whose name starts with `_` is not a record, so it is not placed', async () => {
    w('records/person/ada.md')
    w('records/person/_draft.md')
    const { nodes } = await folder(null)
    expect(nodes.map((n) => n.name)).toEqual(['ada'])
  })

  it('orders numerically but NEVER strips the number from the slug', async () => {
    // ⛔ A leading number is a DATE at least as often as it is an order, and
    // nothing in the filename tells them apart — so it is read to SORT by and
    // never to rename. Ordering: 1, 2, 10, not the string order 1, 10, 2.
    w('records/post/10-tenth.md')
    w('records/post/2-second.md')
    w('records/post/1-first.md')
    const { nodes, errors } = await folder(null)
    expect(errors).toEqual([])
    expect(nodes.map((n) => n.name)).toEqual(['1-first', '2-second', '10-tenth'])
  })

  // ⭐ The case that settled it, straight out of the records model's own example
  // pool: `post/01-lab-opens.md` and `publication/2026-03-nature-folding.md` sit
  // side by side, and no rule can strip the first without mangling the second.
  it('a date-named record keeps its whole name and sorts chronologically', async () => {
    w('records/publication/2026-03-nature-folding.md')
    w('records/publication/2025-11-jmlr-priors.md')
    const { nodes, errors } = await folder(null)
    expect(errors).toEqual([])
    expect(nodes.map((n) => n.name)).toEqual(['2025-11-jmlr-priors', '2026-03-nature-folding'])
  })
})

describe('⛔ a path at the top level is refused — it used to LIST records', () => {
  it('names the reason, and the records are placed at the top regardless', async () => {
    w('records/person/ada.md')
    w('records/person/grace.md')
    const { nodes, errors } = await folder('- person/*.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('lists records at the top level')
    expect(errors[0]).toContain('Every file in records/ is a record already')
    expect(nodes.map((n) => n.name)).toEqual(['ada', 'grace'])
  })

  it('names the directory the site actually uses', async () => {
    w('records/person/ada.md')
    w('records/folder.yml', '- person/*.md\n')
    const cfg = await readRecordsConfig(ROOT)
    const { errors } = resolveFolder(cfg.entries, await pool(), { dir: 'content/records' })
    expect(errors[0]).toContain('Every file in content/records/ is a record already')
  })
})

describe('structure is QUERY SCOPE — a folder is an addressable dimension', () => {
  it('nests, recursively, and stamps each record with the path a query slices on', async () => {
    w('records/publication/2026-a.md')
    w('records/publication/2025-b.md')
    w('records/publication/2023-c.md')
    const { nodes, placements, errors } = await folder(
      [
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

    // The declared folders first, then every record no folder names.
    expect(nodes.map((n) => [n.kind, n.name])).toEqual([['branch', 'archive'], ['ref', '2026-a']])
    const archive = nodes[0]
    expect(archive.label).toBe('Publication Archive')
    expect(archive.$children.map((c) => c.kind)).toEqual(['ref', 'branch'])
  })

  it('warns about a folder holding nothing — a folder exists to be queried', async () => {
    w('records/person/ada.md')
    const { warnings } = await folder('- folder: empty\n  records: []\n')
    expect(warnings.some((x) => x.includes('holds no records'))).toBe(true)
  })
})

describe('⛔ error rules — every one of these used to fail silently', () => {
  it('a path naming a missing file is a hard error', async () => {
    w('records/person/ada.md')
    const { errors } = await folder('- folder: team\n  records:\n    - person/nobody.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not in records/')
  })

  it('a pattern matching ZERO files is an error, not an empty branch', async () => {
    // The measured behaviour once was `{name: "artcles", $children: []}` — a real,
    // reachable, empty path, with no warning.
    w('records/article/a.md')
    const { errors } = await folder('- folder: news\n  records:\n    - artcle/*.md\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('matches no record')
  })

  it('⛔ the same record placed twice is an error, and it names BOTH entries', async () => {
    // One placement per record. A record's `path` is one string, and `withinScope`
    // matches nothing that is not — a record with two paths would fall outside
    // every `scope:`, silently.
    w('records/publication/2026-a.md')
    const { errors } = await folder(
      '- folder: new\n  records:\n    - publication/2026-*.md\n' +
        '- folder: all\n  records:\n    - publication/*.md\n'
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('placed twice')
    expect(errors[0]).toContain('[0]')
    expect(errors[0]).toContain('[1]')
  })

  it('catches a duplicate across a nested folder boundary too', async () => {
    w('records/publication/2025-b.md')
    const { errors } = await folder(
      '- folder: archive\n  records:\n    - publication/*.md\n    - folder: old\n      records:\n        - publication/2025-*.md\n'
    )
    expect(errors.some((e) => e.includes('placed twice'))).toBe(true)
  })

  it('⛔ rejects url:/asset: loudly rather than dropping them', async () => {
    w('records/person/ada.md')
    const { errors } = await folder('- asset: media/report.pdf\n- url: https://example.org/x\n')
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('asset')
    expect(errors[1]).toContain('url')
    for (const e of errors) expect(e).toContain('refused rather than dropped')
  })

  it('refuses an entry with no recognized kind', async () => {
    const { errors } = await folder('- query: recent\n')
    expect(errors[0]).toContain('no recognized kind')
  })

  // ⛔ A query's `scope:` names a folder by its path, so two sibling folders with one
  // name would be one scope — and a backend refuses a folder holding the pair.
  it('⛔ two folders with one name at one level are an error, naming BOTH entries', async () => {
    w('records/publication/2026-a.md')
    w('records/publication/2025-b.md')
    const { errors } = await folder(
      '- folder: archive\n  records:\n    - publication/2026-a.md\n' +
        '- folder: archive\n  records:\n    - publication/2025-b.md\n'
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('folder "archive" is declared twice at one level')
    expect(errors[0]).toContain('[0]')
    expect(errors[0]).toContain('[1]')
  })

  // CONTROL — one name at two LEVELS is two paths, and records may share a name.
  it('CONTROL — one folder name at two levels is fine, and so are same-named records', async () => {
    w('records/publication/2026-a.md')
    w('records/publication/2025-b.md')
    w('records/note/2025-b.md')
    const { errors } = await folder(
      '- folder: archive\n  records:\n    - publication/2026-a.md\n' +
        '    - folder: archive\n      records:\n        - publication/2025-b.md\n'
    )
    expect(errors).toEqual([])
  })

  // ⛔ CONTROL. Every case above asserts a REFUSAL; without this one, a resolver
  // that placed nothing at all would pass all of them.
  it('CONTROL — a well-formed file places its records and reports nothing', async () => {
    w('records/person/ada.md')
    w('records/person/grace.md')
    const { nodes, placements, errors, warnings } = await folder(
      '- folder: team\n  records:\n    - person/ada.md\n'
    )
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(nodes.map((n) => [n.kind, n.name])).toEqual([['branch', 'team'], ['ref', 'grace']])
    expect(placements.get('person/ada').path).toBe('team')
    expect(placements.get('person/grace').path).toBe('')
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
})

// ⚠️ YAML TYPES A BARE `2024` AS A NUMBER, and a folder named for a year is the
// single most likely one anybody writes — the docs' own nested example uses one.
// Both the segment and the label reach the wire as strings, so a number passed
// through would surface as a type error on the far side, far from the file that
// caused it.
describe('a year-named folder', () => {
  it('coerces a numeric folder name and label to strings', async () => {
    w('records/news/spring.md')
    const { nodes, errors } = await folder(
      '- folder: 2024\n  label: 2024\n  records:\n    - news/*.md\n'
    )
    expect(errors).toEqual([])
    expect(nodes[0].name).toBe('2024')
    expect(nodes[0].label).toBe('2024')
    expect(typeof nodes[0].name).toBe('string')
    expect(typeof nodes[0].label).toBe('string')
  })

  it('still refuses a folder with no name — and `0` is a legal name', async () => {
    w('records/news/spring.md')
    const empty = await folder('- folder: ""\n  records:\n    - news/*.md\n')
    expect(empty.errors[0]).toContain('no name')
    const zero = await folder('- folder: 0\n  records:\n    - news/*.md\n')
    expect(zero.errors).toEqual([])
    expect(zero.nodes[0].name).toBe('0')
  })
})
