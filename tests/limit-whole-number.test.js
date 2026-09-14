/**
 * `limit:` is a whole number of records, 0 or more — on a query and on a fetch.
 *
 * ⛔ Anything else stops the build and the sync push. Every lane cuts a set only by a
 * number above 0 (`@uniweb/core`), so `limit: "5"`, `limit: -1` and `limit: 2.5` meant
 * "no limit" — or, for a fraction, a count nobody wrote — with nothing said. `0` stays
 * valid and means no limit; a `limit:` with no value is no limit too, as though it were
 * not written.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
import { refuseQueryDeclaration, resolveQueriesConfig } from '../src/site/queries-config.js'
import { processQueries } from '../src/site/query-processor.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quiet = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    [console.log, console.warn] = saved
  }
}
const WHOLE = /`limit:` is a whole number of records, 0 or more, and `0` means no limit/

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'limit-'))
  w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\n')
  w('pages/about/about.md', '---\ntype: About\n---\n# About\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('on a fetch', () => {
  it('refuses a string, a negative number and a fraction — naming what to write', () => {
    expect(() => parseFetchConfig({ query: 'team', limit: '5' }, 'x.md')).toThrow(/x\.md: `limit: "5"` — `limit:` is a whole number .*Write `limit: 5`, unquoted\./)
    expect(() => parseFetchConfig({ query: 'team', limit: -1 }, 'x.md')).toThrow(/`limit: -1` — .*For no limit, write `limit: 0` or leave it out\./)
    expect(() => parseFetchConfig({ query: 'team', limit: 2.5 }, 'x.md')).toThrow(WHOLE)
    expect(() => parseFetchConfig(['team', { query: 'news', limit: 'all' }], 'x.md')).toThrow(/`limit: "all"`/)
  })

  it('CONTROL — a count, `0` and no value parse', () => {
    expect(parseFetchConfig({ query: 'team', limit: 5 }).limit).toBe(5)
    expect(parseFetchConfig({ query: 'team', limit: 0 }).limit).toBe(0)
    expect(parseFetchConfig({ query: 'team', limit: null }).limit).toBeNull()
  })

  it('stops the build on a section, and the sync push on a page.yml', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nfetch:\n  query: team\n  limit: "3"\n---\n# Team\n')
    await expect(quiet(() => collectSiteContent(ROOT, { strict: true }))).rejects.toThrow(/pages\/team\/1-grid\.md: `limit: "3"`/)
    rmSync(join(ROOT, 'pages/team'), { recursive: true, force: true })
    w('pages/team/page.yml', 'title: Team\nfetch:\n  query: team\n  limit: -1\n')
    await expect(quiet(() => siteProjectToDocument(ROOT))).rejects.toThrow(/pages\/team\/page\.yml: `limit: -1`/)
  })
})

describe('on a query', () => {
  const refuse = (decl) => () => refuseQueryDeclaration({ name: 'posts', schema: '@/post', ...decl })

  it('refuses a string, a negative number and a fraction, on either kind of query', () => {
    expect(refuse({ limit: '10' })).toThrow(/query "posts": `limit: "10"` — `limit:` is a whole number .*Write `limit: 10`, unquoted\./)
    expect(refuse({ limit: -5 })).toThrow(WHOLE)
    expect(refuse({ limit: 1.5 })).toThrow(WHOLE)
    expect(() => refuseQueryDeclaration({ name: 'items', url: 'https://api.test/items', limit: 'ten' })).toThrow(/query "items": `limit: "ten"`/)
  })

  it('CONTROL — a count, `0` and no value are accepted', () => {
    expect(refuse({ limit: 100 })).not.toThrow()
    expect(refuse({ limit: 0 })).not.toThrow()
    expect(refuse({ limit: null })).not.toThrow()
  })

  it('in queries.yml and in site.yml::queries — the build and the sync push both refuse', async () => {
    w('queries.yml', "posts:\n  schema: '@/post'\n  limit: '5'\n")
    await expect(resolveQueriesConfig(ROOT)).rejects.toThrow(/`limit: "5"`/)
    await expect(quiet(() => collectSiteContent(ROOT, { strict: true }))).rejects.toThrow(/`limit: "5"`/)
    await expect(quiet(() => siteProjectToDocument(ROOT))).rejects.toThrow(/`limit: "5"`/)

    rmSync(join(ROOT, 'queries.yml'))
    w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\nqueries:\n  posts:\n    schema: "@/post"\n    limit: 2.5\n')
    await expect(resolveQueriesConfig(ROOT)).rejects.toThrow(/`limit: 2\.5`/)
  })

  it('a raw query config handed to the compiler is refused too', async () => {
    await expect(quiet(() => processQueries(ROOT, { posts: { schema: '@/post', limit: '5' } }, undefined, '/'))).rejects.toThrow(/queries\.posts: `limit: "5"`/)
  })
})
