// ⛔ `records.yml` GOVERNS THE DELIVERY LANE TOO — it did not, and both suites
// were green while it did not.
//
// The sync lane honoured it from the start: only referenced entities are pushed,
// and placement builds the folder. The DELIVERY lane — `/data/<name>.json`, which
// is what every static host and every query materialization actually reads —
// ignored it entirely. Two consequences, both silent:
//
//   1. every record shipped with `path: ''`, so a folder slice
//      (`where: { path: { under: 'archive' } }`) matched NOTHING. Folders exist
//      only to be queried, so the feature was inert on the lane that serves it.
//   2. an entity `records.yml` did not list still shipped. An author removes a
//      record to unpublish it and it stays public on a static site.
//
// ⚠️ NEITHER WAS CAUGHT BY THE EXISTING TESTS, and the reason is worth keeping:
// `records-config.test.js` and `folder-grouping-parity.test.js` both assert
// placements — from `resolveFolder`, which was correct all along. Nothing
// crossed from there into what the build actually delivers. A unit that is right
// proves nothing about a consumer that never calls it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processQueries } from '../src/site/query-processor.js'
import { applyWhere } from '../src/site/data-fetcher.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const entity = (title) => `---\ntitle: ${title}\n---\n\nBody.\n`
const deliver = () =>
  processQueries(ROOT, { pubs: { name: 'pubs', schema: '@/publication' } }, undefined, '/')

let warn, log
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'delivery-lane-'))
  w('site.yml', 'name: T\n')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  log.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('placement reaches the records a query returns', () => {
  it('stamps each record with the folder records.yml put it in', async () => {
    w('entities/publication/2026-a.md', entity('Current'))
    w('entities/publication/2025-b.md', entity('Older'))
    w('records.yml', ['- publication/2026-a.md', '- folder: archive', '  records:', '    - publication/2025-b.md', ''].join('\n'))

    const { pubs } = await deliver()
    const byslug = Object.fromEntries(pubs.map((r) => [r.slug, r.path]))
    expect(byslug['2026-a']).toBe('')
    expect(byslug['2025-b']).toBe('archive')
  })

  // ⭐ THE ASSERTION THAT WOULD HAVE CAUGHT IT. The one above is about a field;
  // this is about the capability the field exists for.
  it('a folder slice actually selects — the point of folders', async () => {
    w('entities/publication/2026-a.md', entity('Current'))
    w('entities/publication/2025-b.md', entity('Older'))
    w('records.yml', ['- publication/2026-a.md', '- folder: archive', '  records:', '    - publication/2025-b.md', ''].join('\n'))

    const { pubs } = await deliver()
    expect(applyWhere(pubs, { path: { under: 'archive' } }).map((r) => r.slug)).toEqual(['2025-b'])
    // CONTROL — the predicate is not simply matching everything
    expect(applyWhere(pubs, { path: { under: 'nowhere' } })).toEqual([])
  })

  it('nests to any depth', async () => {
    w('entities/publication/deep.md', entity('Deep'))
    w('records.yml', ['- folder: archive', '  records:', '    - folder: 2023', '      records:', '        - publication/deep.md', ''].join('\n'))

    const { pubs } = await deliver()
    expect(pubs[0].path).toBe('archive/2023')
    expect(applyWhere(pubs, { path: { under: 'archive' } })).toHaveLength(1)
  })
})

describe('⛔ records.yml decides what is PUBLISHED here, not only what syncs', () => {
  it('an unreferenced entity is not delivered', async () => {
    w('entities/publication/published.md', entity('Published'))
    w('entities/publication/secret-draft.md', entity('Draft'))
    w('records.yml', '- publication/published.md\n')

    const { pubs } = await deliver()
    // the subject
    expect(pubs.map((r) => r.slug)).not.toContain('secret-draft')
    // ⛔ CONTROL — its referenced sibling IS delivered, so the absence above is
    // the rule working rather than the lane delivering nothing.
    expect(pubs.map((r) => r.slug)).toEqual(['published'])
  })

  // ⚖️ MISSING MEANS SOMETHING DIFFERENT HERE THAN IT DOES TO SYNC, deliberately.
  // On sync, missing is inert — leave the server's folder alone. There is no
  // server state on this lane, so a site with no `records.yml` is simply not
  // managing publication and its whole pool is delivered. Making missing mean
  // "publish nothing" would turn every site without the file silently empty.
  it('no records.yml delivers the whole pool', async () => {
    w('entities/publication/a.md', entity('A'))
    w('entities/publication/b.md', entity('B'))

    const { pubs } = await deliver()
    expect(pubs.map((r) => r.slug).sort()).toEqual(['a', 'b'])
    expect(pubs.every((r) => r.path === '')).toBe(true)
  })

  it('an EMPTY records.yml delivers nothing — it says the folder holds nothing', async () => {
    w('entities/publication/a.md', entity('A'))
    w('records.yml', '')

    const { pubs } = await deliver()
    expect(pubs).toEqual([])
  })
})

// ⚠️ The tersest thing an author can write in `queries.yml` is a bare key —
// `articles:` — which YAML parses as NULL. The resolver normalizes it away, so
// the build path never sees it; a caller reading raw config (as
// `processQueries`'s own docstring shows) crashed on it.
describe('a bare query key', () => {
  it('does not crash the processor, and says it matched nothing', async () => {
    w('entities/publication/a.md', entity('A'))
    // ⚖️ Empty is CORRECT for a RAW null: the name→schema default lives in the
    // resolver, and a second copy here is exactly the drift this codebase keeps
    // paying for. Through the real path the resolver has already filled
    // `schema: '@/publication'`, which the tests above exercise.
    const out = await processQueries(ROOT, { publication: null }, undefined, '/')
    expect(out.publication).toEqual([])
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('matches no records'))).toBe(true)
  })
})

// ⛔ A RECORD'S CO-LOCATED ASSETS BELONG TO THE RECORD, not to a query.
//
// They were copied to `public/collections/<queryName>/`, so the SAME image was
// written once per query that returned the record, under two URLs. Third
// instance of the same conflation, after the freeform locale tree and the
// translation manifest — and the only one that duplicated bytes.
describe('record assets are keyed by the record, not the query', () => {
  it('two queries over one schema copy an image ONCE, to one URL', async () => {
    w('entities/article/hello.md', '---\ntitle: Hello\n---\n\n![pic](./pic.png)\n')
    writeFileSync(join(ROOT, 'entities/article/pic.png'), 'PNGDATA')
    w('records.yml', '- article/*.md\n')

    const out = await processQueries(
      ROOT,
      { recent: { name: 'recent', schema: '@/article' }, all: { name: 'all', schema: '@/article' } },
      undefined,
      '/'
    )
    // both queries return the record
    expect(out.recent).toHaveLength(1)
    expect(out.all).toHaveLength(1)

    // ⭐ ONE home, named for the record's pool position — not two named for queries
    expect(existsSync(join(ROOT, 'public/records/article/pic.png'))).toBe(true)
    expect(existsSync(join(ROOT, 'public/collections/recent'))).toBe(false)
    expect(existsSync(join(ROOT, 'public/collections/all'))).toBe(false)
  })
})
