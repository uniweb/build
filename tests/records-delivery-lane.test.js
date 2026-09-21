// ⛔ `records.yml`'s PLACEMENT REACHES THE DELIVERY LANE — it did not, and both
// suites were green while it did not.
//
// The DELIVERY lane — `/data/<name>.json`, which is what every static host and every
// query materialization actually reads — ignored `records.yml` entirely at first:
// every record shipped with `path: ''`, so a folder slice matched NOTHING. Folders
// exist only to be queried, so the feature was inert on the lane that serves it.
//
// ⭐ AND EVERY RECORD IS DELIVERED (ruled 2026-09-21 [Diego]). Placing a file in
// `records/` is what makes it a record; `records.yml` only sorts records into
// folders. ⛔ Until 2026-09-21 `records.yml` listed the records, and a file it did
// not list was left out of the compiled file here.
//
// ⚠️ THE PLACEMENT DEFECT WAS NOT CAUGHT BY THE EXISTING TESTS, and the reason is
// worth keeping: `records-config.test.js` and `folder-grouping-parity.test.js` both
// assert placements — from `resolveFolder`, which was correct all along. Nothing
// crossed from there into what the build actually delivers. A unit that is right
// proves nothing about a consumer that never calls it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processQueries } from '../src/site/query-processor.js'
import { buildRecordEntities } from '../src/uwx/records.js'
import { applyScope } from '@uniweb/core'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const entity = (title) => `---\ntitle: ${title}\n---\n\nBody.\n`
const deliver = () =>
  processQueries(ROOT, { pubs: { name: 'pubs', schema: '@/publication' } }, undefined, '/')

let warn, log, err
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'delivery-lane-'))
  w('site.yml', 'name: T\n')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  err = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  log.mockRestore()
  err.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('placement reaches the records a query returns', () => {
  const ARCHIVE = ['- folder: archive', '  records:', '    - publication/2025-b.md', ''].join('\n')

  it('stamps each record with the folder records.yml put it in — the top for the rest', async () => {
    w('records/publication/2026-a.md', entity('Current'))
    w('records/publication/2025-b.md', entity('Older'))
    w('records.yml', ARCHIVE)

    const { pubs } = await deliver()
    const byslug = Object.fromEntries(pubs.map((r) => [r.slug, r.path]))
    expect(byslug['2026-a']).toBe('')
    expect(byslug['2025-b']).toBe('archive')
  })

  // ⭐ THE ASSERTION THAT WOULD HAVE CAUGHT IT. The one above is about a field;
  // this is about the capability the field exists for.
  it('a folder slice actually selects — the point of folders', async () => {
    w('records/publication/2026-a.md', entity('Current'))
    w('records/publication/2025-b.md', entity('Older'))
    w('records.yml', ARCHIVE)

    const { pubs } = await deliver()
    // a folder branch is `scope:` (ruled 2026-09-11; `where: { path: { under } }` is retired)
    expect(applyScope(pubs, 'archive').map((r) => r.slug)).toEqual(['2025-b'])
    // CONTROL — the scope is not simply matching everything
    expect(applyScope(pubs, 'nowhere')).toEqual([])
  })

  it('nests to any depth', async () => {
    w('records/publication/deep.md', entity('Deep'))
    w('records.yml', ['- folder: archive', '  records:', '    - folder: 2023', '      records:', '        - publication/deep.md', ''].join('\n'))

    const { pubs } = await deliver()
    expect(pubs[0].path).toBe('archive/2023')
    expect(applyScope(pubs, 'archive')).toHaveLength(1)
  })
})

describe('⭐ every record in the directory is delivered — records.yml only organizes', () => {
  it('no records.yml delivers every record, at the top', async () => {
    w('records/publication/a.md', entity('A'))
    w('records/publication/b.md', entity('B'))

    const { pubs } = await deliver()
    expect(pubs.map((r) => r.slug).sort()).toEqual(['a', 'b'])
    expect(pubs.every((r) => r.path === '')).toBe(true)
  })

  it('an EMPTY records.yml delivers every record too — it removes nothing', async () => {
    // ⛔ Until 2026-09-21 it delivered NOTHING: it said the folder held nothing.
    w('records/publication/a.md', entity('A'))
    w('records.yml', '')

    const { pubs } = await deliver()
    expect(pubs.map((r) => r.slug)).toEqual(['a'])
  })

  it('a file whose name starts with `_` is not a record, so it is not delivered', async () => {
    w('records/publication/published.md', entity('Published'))
    w('records/publication/_secret-draft.md', entity('Draft'))

    const { pubs } = await deliver()
    // the subject, and ⛔ CONTROL — its sibling IS delivered, so the absence is the
    // rule working rather than the lane delivering nothing.
    expect(pubs.map((r) => r.slug)).toEqual(['published'])
  })

  it('⛔ a path at the top of records.yml is refused loudly — and every record is still delivered', async () => {
    w('records/publication/a.md', entity('A'))
    w('records/publication/b.md', entity('B'))
    w('records.yml', '- publication/a.md\n')

    const { pubs } = await deliver()
    expect(pubs.map((r) => r.slug).sort()).toEqual(['a', 'b'])
    expect(err.mock.calls.map((c) => String(c[0])).some((m) => m.includes('lists records at the top level'))).toBe(true)
  })

  // ⛔ A MALFORMED records.yml ONCE PUBLISHED EVERYTHING WITH ONE WARNING while the sync
  // lane refused the same file. It stops the build: what it meant to organize cannot be
  // guessed, and a query's `scope:` reads the organization.
  describe('a malformed records.yml stops the build, as it stops a sync', () => {
    beforeEach(() => {
      w('records/publication/published.md', entity('Published'))
    })

    it('invalid YAML — naming the file and the problem', async () => {
      w('records.yml', '- folder: a\n  bad: [unclosed\n')
      await expect(deliver()).rejects.toThrow(/\[uniweb\] records\.yml: .*\n[\s\S]*fix it to build/)
      await expect(buildRecordEntities(ROOT)).rejects.toThrow(/records\.yml/)
    })

    it('a mapping instead of a list', async () => {
      w('records.yml', 'archive:\n  - publication/published.md\n')
      await expect(deliver()).rejects.toThrow(/\[uniweb\] records\.yml must be a LIST of folders, not a mapping/)
      await expect(buildRecordEntities(ROOT)).rejects.toThrow(/records\.yml must be a LIST/)
    })

    it('a single value instead of a list, said as such', async () => {
      w('records.yml', 'publication/published.md\n')
      await expect(deliver()).rejects.toThrow(/records\.yml must be a LIST of folders, not a single value/)
    })

    it('CONTROL — the same record placed through a list builds, in its folder', async () => {
      w('records.yml', '- folder: archive\n  records:\n    - publication/published.md\n')
      const { pubs } = await deliver()
      expect(pubs.map((r) => [r.slug, r.path])).toEqual([['published', 'archive']])
    })
  })
})

// ⚠️ The tersest thing an author can write in `queries.yml` is a bare key —
// `articles:` — which YAML parses as NULL. The resolver normalizes it away, so
// the build path never sees it; a caller reading raw config (as
// `processQueries`'s own docstring shows) crashed on it.
describe('a bare query key', () => {
  it('does not crash the processor, and says it matched nothing', async () => {
    w('records/publication/a.md', entity('A'))
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
    w('records/article/hello.md', '---\ntitle: Hello\n---\n\n![pic](./pic.png)\n')
    writeFileSync(join(ROOT, 'records/article/pic.png'), 'PNGDATA')

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

// ⭐ A MARKDOWN RECORD'S FRONTMATTER IS DATA, like a YAML or JSON record's fields —
// so a co-located path in it is copied and rewritten the same way. It was neither:
// `image: ./cover.jpg` reached the compiled record as `./cover.jpg`, a path relative to
// a file no visitor can see, while the same line in a `.yml` record was published.
describe('a markdown record\'s frontmatter paths are treated as a YAML record\'s fields', () => {
  it('copies and rewrites a co-located frontmatter path, nested ones included', async () => {
    w('records/article/hello.md', '---\ntitle: Hello\nimage: ./cover.jpg\ngallery:\n  - ./img/one.png\n---\n\nBody.\n')
    writeFileSync(join(ROOT, 'records/article/cover.jpg'), 'JPG')
    w('records/article/img/one.png', 'PNG')

    const { articles } = await processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/docs/')
    expect(articles[0].image).toBe('/docs/records/article/cover.jpg')
    expect(articles[0].gallery).toEqual(['/docs/records/article/img/one.png'])
    expect(existsSync(join(ROOT, 'public/records/article/cover.jpg'))).toBe(true)
    expect(existsSync(join(ROOT, 'public/records/article/img/one.png'))).toBe(true)
  })

  it('CONTROL — a `.yml` record\'s field gets the same URL for the same layout', async () => {
    w('records/article/hello.yml', 'title: Hello\nimage: ./cover.jpg\n')
    writeFileSync(join(ROOT, 'records/article/cover.jpg'), 'JPG')
    const { articles } = await processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/docs/')
    expect(articles[0].image).toBe('/docs/records/article/cover.jpg')
  })

  it('the body\'s first image still stands in when the frontmatter names none', async () => {
    w('records/article/hello.md', '---\ntitle: Hello\n---\n\n![pic](./pic.png)\n')
    writeFileSync(join(ROOT, 'records/article/pic.png'), 'PNG')
    const { articles } = await processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/')
    expect(articles[0].image).toBe('/records/article/pic.png')
  })
})

// ⛔ TWO ASSETS WITH ONE FILENAME OVERWROTE EACH OTHER. A co-located asset was copied to
// `public/records/<schema dirs>/<basename>`, keyed by its basename alone, so `./a/pic.png`
// and `./b/pic.png` under one schema folder became one file — the last one copied — at
// one URL, and a record showed another record's picture.
describe('a record asset keeps its path under the records directory', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

  it('two files named alike, in two folders, stay two files at two URLs', async () => {
    w('records/article/a.md', '---\ntitle: A\n---\n\n![a](./a/pic.png)\n')
    w('records/article/b.md', '---\ntitle: B\n---\n\n![b](./b/pic.png)\n')
    w('records/article/a/pic.png', 'PIC-A')
    w('records/article/b/pic.png', 'PIC-B')

    const { articles } = await processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/')
    const bySlug = Object.fromEntries(articles.map((r) => [r.slug, r.image]))
    expect(bySlug).toEqual({ a: '/records/article/a/pic.png', b: '/records/article/b/pic.png' })
    expect(read('public/records/article/a/pic.png')).toBe('PIC-A')
    expect(read('public/records/article/b/pic.png')).toBe('PIC-B')
  })

  it('a file beside its record keeps today\'s URL; one outside the schema folder, inside records/, keeps its path', async () => {
    w('records/article/a.md', '---\ntitle: A\nlogo: ../shared/logo.svg\n---\n\n![pic](./pic.png)\n')
    w('records/article/pic.png', 'PIC')
    w('records/shared/logo.svg', '<svg/>')

    const { articles } = await processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/')
    expect(articles[0].image).toBe('/records/article/pic.png')
    expect(articles[0].logo).toBe('/records/shared/logo.svg')
    expect(read('public/records/shared/logo.svg')).toBe('<svg/>')
  })

  it('in a YAML record\'s fields, by the same rule', async () => {
    w('records/person/team.yml', '- slug: ada\n  photo: ./img/ada.png\n- slug: lin\n  photo: ./other/ada.png\n')
    w('records/person/img/ada.png', 'ADA')
    w('records/person/other/ada.png', 'LIN')
    const { people } = await processQueries(ROOT, { people: { name: 'people', schema: '@/person' } }, undefined, '/')
    expect(people.map((p) => p.photo)).toEqual(['/records/person/img/ada.png', '/records/person/other/ada.png'])
    expect(read('public/records/person/other/ada.png')).toBe('LIN')
  })

  it('a file outside the records directory gets a stable name of its own, distinct per file', async () => {
    w('records/article/a.md', '---\ntitle: A\nlogo: ../../assets/logo.svg\nother: ../../brand/logo.svg\n---\n')
    w('assets/logo.svg', 'ASSETS')
    w('brand/logo.svg', 'BRAND')
    const compile = () => processQueries(ROOT, { articles: { name: 'articles', schema: '@/article' } }, undefined, '/')

    const [first] = (await compile()).articles
    expect(first.logo).toMatch(/^\/records\/_external\/[0-9a-f]{8}-logo\.svg$/)
    expect(first.other).toMatch(/^\/records\/_external\/[0-9a-f]{8}-logo\.svg$/)
    expect(first.logo).not.toBe(first.other)
    expect(read(`public${first.logo}`)).toBe('ASSETS')
    expect(read(`public${first.other}`)).toBe('BRAND')
    // deterministic — the same file gets the same URL on the next build
    const [second] = (await compile()).articles
    expect(second.logo).toBe(first.logo)
  })
})
