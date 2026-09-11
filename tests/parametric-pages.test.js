/**
 * Parametric pages in the build — the producer half of the rules ruled on
 * 2026-09-11 [Diego]:
 *
 *   - no `parentSchema` on any page: the route query is worked out where it is read;
 *   - a page nested inside a `[name]` folder is parametric too, binding its ancestor's param;
 *   - `[dir]`, `[path]` and any folder inside `[...path]` are refused, on a build and on a sync;
 *   - `$name` is the handle of every compiled record — its FINAL slug;
 *   - a branch is `scope:`; `where: { path: { under } }` and `under` are refused;
 *   - a named query's clauses bound to the route are left for the runtime, not compiled
 *     against the literal `':dir'`, and its `scope` is never baked — the runtime applies
 *     the scope that wins, as the records service does.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { processQueries } from '../src/site/query-processor.js'
import { parseFetchConfig, applyPostProcessing, _resetUnknownFetchKeyWarnings } from '../src/site/data-fetcher.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quiet = () => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  return () => { [console.log, console.warn] = saved }
}
const collect = async () => {
  const restore = quiet()
  try {
    return await collectSiteContent(ROOT, { strict: false })
  } finally {
    restore()
  }
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'parametric-'))
  w('site.yml', 'name: test-site\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the collector', () => {
  beforeEach(() => {
    // `about` sorts first, so it is the homepage and `members` keeps its own route
    w('pages/about/about.md', '---\ntype: About\n---\n# About\n')
    w('pages/members/page.yml', 'title: Members\nfetch:\n  url: https://example.com/members.json\n  as: members\n')
    w('pages/members/list.md', '---\ntype: List\n---\n# Members\n')
    w('pages/members/[slug]/card.md', '---\ntype: Card\n---\n# Card\n')
    w('pages/members/[slug]/cv/cv.md', '---\ntype: Cv\n---\n# CV\n')
  })

  it('emits no `parentSchema` on any page — the route query is worked out where it is read', async () => {
    const content = await collect()
    expect(content.pages.some((p) => 'parentSchema' in p)).toBe(false)
  })

  it('a page nested inside a [slug] folder is parametric, binding its ancestor\'s param', async () => {
    const content = await collect()
    const cv = content.pages.find((p) => p.route === '/members/:slug/cv')
    expect(cv).toMatchObject({ isDynamic: true, paramName: 'slug', parent: '/members/:slug' })
    // CONTROL — the page it sits in is the bracket folder, as always
    expect(content.pages.find((p) => p.route === '/members/:slug')).toMatchObject({ isDynamic: true, paramName: 'slug' })
    expect(content.pages.find((p) => p.route === '/members')).toMatchObject({ isDynamic: false })
  })

  it('refuses a folder named [dir] — `:dir` is a route variable', async () => {
    w('pages/members/[dir]/page.md', '---\ntype: Card\n---\n')
    await expect(collect()).rejects.toThrow(/cannot be named `\[dir\]`/)
  })

  it('refuses [path], pointing at [...path]', async () => {
    w('pages/docs/[path]/page.md', '---\ntype: Doc\n---\n')
    await expect(collect()).rejects.toThrow(/Did you mean `\[\.\.\.path\]`/)
  })

  it('refuses a folder inside [...path] — its route could never be reached', async () => {
    w('pages/docs/[...path]/doc.md', '---\ntype: Doc\n---\n')
    w('pages/docs/[...path]/edit/edit.md', '---\ntype: Edit\n---\n')
    await expect(collect()).rejects.toThrow(/sits inside a `\[\.\.\.path\]` folder/)
  })

  it('CONTROL — a `_`-named folder inside [...path] is not a page, and is not refused', async () => {
    w('pages/docs/[...path]/doc.md', '---\ntype: Doc\n---\n')
    w('pages/docs/[...path]/_images/readme.md', 'not a page\n')
    await expect(collect()).resolves.toBeDefined()
  })
})

describe('the sync walker refuses what the collector refuses', () => {
  it('[dir]', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/members/[dir]/page.yml', 'title: X\n')
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/cannot be named `\[dir\]`/)
  })

  it('a folder inside [...path]', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/docs/[...path]/page.yml', 'title: Doc\n')
    w('pages/docs/[...path]/edit/page.yml', 'title: Edit\n')
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/sits inside a `\[\.\.\.path\]` folder/)
  })

  const under = '  where:\n    path:\n      under: field\n'
  it('`under` on a page\'s fetch', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/members/page.yml', `title: M\nfetch:\n  query: members\n${under}`)
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/Write `scope: "field"`/)
  })

  it('`under` on the site\'s fetch', async () => {
    w('site.yml', `name: test-site\nfoundation: "@acme/base@1.0.0"\nfetch:\n  path: /data/members.json\n${under}`)
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/site\.yml fetch: .*Write `scope: "field"`/)
  })

  it('`under` on a named query', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('queries.yml', `members:\n  schema: '@/member'\n${under}`)
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/queries\.members: .*Write `scope: "field"`/)
  })

  it('CONTROL — `scope:` syncs, on a page\'s fetch and on a named query', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/members/page.yml', 'title: M\nfetch:\n  query: members\n  scope: field\n')
    w('queries.yml', "members:\n  schema: '@/member'\n  scope: field\n")
    const doc = await siteProjectToDocument(ROOT)
    expect(JSON.stringify(doc)).toContain('"scope":"field"')
  })
})

describe('$name on compiled records — the record\'s final slug (ruled 2026-09-11)', () => {
  const run = async (queries) => {
    const restore = quiet()
    try {
      return await processQueries(ROOT, queries, null, '/')
    } finally {
      restore()
    }
  }

  it('from the filename, and from a frontmatter `slug:` that overrides it — what sync sends as the name', async () => {
    w('entities/article/hello.md', '---\ntitle: Hello\n---\nBody\n')
    w('entities/article/renamed.md', '---\ntitle: Renamed\nslug: custom\n---\nBody\n')
    const { articles } = await run({ articles: { schema: '@/article' } })
    const byTitle = Object.fromEntries(articles.map((r) => [r.title, r]))
    expect(byTitle.Hello).toMatchObject({ slug: 'hello', $name: 'hello' })
    expect(byTitle.Renamed).toMatchObject({ slug: 'custom', $name: 'custom' })
  })

  it('on every format — an array-form file\'s own slugs', async () => {
    w('entities/person/team.yml', '- slug: ada\n  name: Ada\n- slug: lin\n  name: Lin\n')
    const { people } = await run({ people: { schema: '@/person' } })
    expect(people.map((r) => r.$name).sort()).toEqual(['ada', 'lin'])
  })
})

describe('a named query\'s narrowing at build — only what is fixed for every page', () => {
  beforeEach(() => {
    w('entities/entry/a.md', '---\ntitle: A\n---\n')
    w('entities/entry/b.md', '---\ntitle: B\n---\n')
    w('records.yml', ['- folder: field', '  records:', '    - entry/a.md', '- folder: lab', '  records:', '    - entry/b.md', ''].join('\n'))
  })
  const run = async (queries) => {
    const restore = quiet()
    try {
      return await processQueries(ROOT, queries, null, '/')
    } finally {
      restore()
    }
  }

  it('a fixed scope is never baked — every record compiles, with the placement the runtime scopes by', async () => {
    // The runtime applies the scope that wins — a page fetch's own, else this
    // query's (`resolveQuerySource` carries it) — as the records service does.
    // Baked, a page's own `scope:` could only narrow inside the query's branch on
    // a static site, and would replace it on a hosted one.
    const { q } = await run({ q: { schema: '@/entry', scope: 'field' } })
    expect(q.map((r) => [r.slug, r.path]).sort()).toEqual([['a', 'field'], ['b', 'lab']])
  })

  it('CONTROL — a fixed where is applied at build', async () => {
    const { q } = await run({ q: { schema: '@/entry', where: { title: 'A' } } })
    expect(q.map((r) => r.slug)).toEqual(['a'])
  })

  it('a routed scope and a routed where are left for the runtime — every record compiles', async () => {
    // ⛔ `where: { path: :dir }` was applied here to the literal ':dir' until
    // 2026-09-11 and compiled to NO records (measured); `scope: :dir` was ignored.
    const { routedScope, routedWhere } = await run({
      routedScope: { schema: '@/entry', scope: ':dir' },
      routedWhere: { schema: '@/entry', where: { path: ':dir' } },
    })
    expect(routedScope.map((r) => r.slug).sort()).toEqual(['a', 'b'])
    expect(routedWhere.map((r) => r.slug).sort()).toEqual(['a', 'b'])
  })

  it('refuses `where: { path: { under } }`, naming scope', async () => {
    await expect(run({ q: { schema: '@/entry', where: { path: { under: 'field' } } } })).rejects.toThrow(/scope: "field"/)
  })
})

describe('a page\'s fetch — `scope` is recognized, `under` is refused', () => {
  beforeEach(() => _resetUnknownFetchKeyWarnings())

  it('keeps `scope` on a query reference and on a source', () => {
    const warn = console.warn
    const seen = []
    console.warn = (m) => seen.push(m)
    try {
      expect(parseFetchConfig({ query: 'logbook', scope: ':dir' })).toMatchObject({ query: 'logbook', scope: ':dir' })
      expect(parseFetchConfig({ path: '/data/logbook.json', scope: 'field' })).toMatchObject({ scope: 'field' })
    } finally {
      console.warn = warn
    }
    expect(seen.some((m) => m.includes('"scope"'))).toBe(false)
  })

  it('refuses `under` wherever it sits in a where, with a message naming scope', () => {
    expect(() => parseFetchConfig({ query: 'x', where: { path: { under: 'a' } } })).toThrow(/Write `scope: "a"`/)
    expect(() => parseFetchConfig({ refine: true, where: { or: [{ tag: { under: 'b' } }] } })).toThrow(/`under` is no longer an operator/)
  })

  it('applyPostProcessing applies scope before where, sort and limit', () => {
    const rows = [{ slug: 'a', path: 'field' }, { slug: 'b', path: 'lab' }, { slug: 'c', path: 'field/x' }]
    expect(applyPostProcessing(rows, { scope: 'field', limit: 1 }).map((r) => r.slug)).toEqual(['a'])
    expect(applyPostProcessing(rows, { scope: 'field' }).map((r) => r.slug)).toEqual(['a', 'c'])
  })
})
