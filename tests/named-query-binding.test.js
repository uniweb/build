/**
 * The NAMED-QUERY binding model: a query's NAME and the key its results land
 * under are two different things.
 *
 *   `query` — which named query runs. Also what `path` is derived from.
 *   `as`    — the `content.data.<as>` key a component reads. Defaults to the
 *             query name when the author gives none.
 *
 * **[Diego, 2026-09-12]** — *"`as` is not the query name in general. It takes the
 * query name when there is no given `as`. that is the idea. it determines the key
 * where the query results are saved at rendering `content.data.<as>`"*
 *
 * ⭐ **WHY THIS IS PINNED SEPARATELY FROM THE `as` OVERRIDE ITSELF.** These two
 * become load-bearing the moment an authoring tool lets a query be NAMED
 * independently of the component key it lands on — `recent-posts` delivered to a
 * component that reads `content.data.posts`. Two regressions would be silent:
 *
 *   1. ⛔ **If `as` collapsed back into the query name**, or `path` started
 *      following `as` instead of `query`, a renamed query would resolve to the
 *      wrong data file. A client that derives a request URL from `path` breaks
 *      only for renamed queries — a thin failure surface that no amount of
 *      ordinary use would expose.
 *   2. ⛔ **If a declaration with no consumer were ever pruned** (a plausible
 *      "tidy unused queries" optimisation), a query declared before anything
 *      binds it would vanish on the next round trip. Declaring first is the
 *      ordinary order when a query is authored as a named, reusable thing.
 *
 * ⚠️ **The build lane and the sync wire compute `as` by SEPARATE mechanisms**
 * (`parseFetchConfig`'s `fetch.as || fetch.query`, and `resolveWireFetch` leaving an
 * authored `as` in its spread). Measured 2026-09-12: collapsing one leaves the other
 * green, so both are asserted here. Each assertion below was verified to FAIL with
 * its own mechanism reverted — a pin that cannot fail is not a pin.
 *
 * ⚖️ `data-fetcher.test.js` already pins the bare `as` override; what is here is
 * what it does NOT cover — `path`'s derivation while they differ, the same across
 * the sync wire, the binding key through the public surface, and the round trip.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { routeQuery } from '@uniweb/core/fetch-config'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

let ROOT
const w = (rel, body, root = ROOT) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quiet = () => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  return () => { [console.log, console.warn] = saved }
}
const collect = async (root = ROOT) => {
  const restore = quiet()
  try { return await collectSiteContent(root, { strict: false }) } finally { restore() }
}
const wirePage = (doc, slug) => {
  const walk = (list) => {
    for (const r of list || []) {
      if ((r.slug?.en ?? r.slug) === slug) return r
      const hit = walk(r.$children)
      if (hit) return hit
    }
    return null
  }
  return walk(doc.pages)
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'named-query-'))
  // ⚠️ TWO page folders on purpose: with one, root promotion moves it to `/` and
  // the route this file looks up does not exist.
  w('site.yml', [
    'name: t',
    'foundation: "@acme/x@1.0.0"',
    'queries:',
    '  recent-posts:',
    '    schema: "@std/article"',
    '    sort: date desc',
    '    limit: 3',
    '  featured-posts:',
    '    schema: "@std/article"',
    '    where: { featured: true }',
    '',
  ].join('\n'))
  w('pages/about/a.md', '---\ntype: Hero\n---\n# About\n')
  w('pages/blog/page.yml', 'title: Blog\nfetch:\n  query: recent-posts\n  as: posts\n  limit: 5\n')
  w('pages/blog/a.md', '---\ntype: List\n---\n# Blog\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a query NAME and its binding key are separate', () => {
  it('⭐ `path` follows the QUERY, not `as` — the half an `as` override test does not reach', () => {
    const cfg = parseFetchConfig({ query: 'recent-posts', as: 'posts' })
    expect(cfg.as).toBe('posts')
    expect(cfg.query).toBe('recent-posts')
    // ⛔ If this ever reads `/data/posts.json`, a renamed query loads the wrong file.
    expect(cfg.path).toBe('/data/recent-posts.json')
  })

  it('the BINDING KEY is `as`, through the public surface a consumer uses', () => {
    // `bindingKey` is internal; `routeQuery` is the exported function computed FROM
    // it, so this fails if `as` ever stops being what a record binds under.
    const page = parseFetchConfig({ query: 'recent-posts', as: 'posts' })
    expect(routeQuery({ page }).key).toBe('posts')
  })

  it('CONTROL — with no `as`, the key IS the query name (the default, not a rule)', () => {
    const cfg = parseFetchConfig({ query: 'recent-posts' })
    expect(cfg.as).toBe('recent-posts')
    expect(routeQuery({ page: cfg }).key).toBe('recent-posts')
  })

  it('end to end: the build keeps them apart on the page', async () => {
    const page = (await collect()).pages.find((p) => p.route === '/blog')
    expect(page.fetch).toMatchObject({ query: 'recent-posts', as: 'posts', path: '/data/recent-posts.json' })
    // the fetch's own shaping rides along beside the decl's
    expect(page.fetch.limit).toBe(5)
  })

  it('⭐ the SYNC WIRE preserves all three — the transport a sync client round-trips', async () => {
    const blog = wirePage(await siteProjectToDocument(ROOT), 'blog')
    expect(blog.fetch).toMatchObject({ query: 'recent-posts', as: 'posts', path: '/data/recent-posts.json' })
  })
})

describe('a decl no component consumes survives the round trip', () => {
  // `featured-posts` is declared and referenced by NO page and NO section.
  it('push carries it', async () => {
    const names = ((await siteProjectToDocument(ROOT)).queries || []).map((d) => d.name)
    expect(names).toContain('featured-posts')
  })

  it('⭐ pull writes it back, shaping intact — nothing filters on "is this consumed?"', async () => {
    const doc = await siteProjectToDocument(ROOT)
    const fresh = mkdtempSync(join(tmpdir(), 'named-query-pull-'))
    try {
      mkdirSync(join(fresh, 'pages'), { recursive: true })
      writeFileSync(join(fresh, 'site.yml'), 'name: t\nfoundation: "@acme/x@1.0.0"\n')
      siteContentDocumentToProject({ document: doc, siteRoot: fresh })
      const p = join(fresh, 'queries.yml')
      expect(existsSync(p)).toBe(true)
      const back = yaml.load(readFileSync(p, 'utf8'))
      expect(back['featured-posts']).toMatchObject({ schema: '@std/article', where: { featured: true } })
      // and the consumed one is not special-cased either
      expect(back['recent-posts']).toMatchObject({ schema: '@std/article', limit: 3 })
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('CONTROL — two decls may share one Model, which is what makes "recent vs featured" expressible', async () => {
    const decls = (await collect()).config.queries
    expect(decls['recent-posts'].schema).toBe('@std/article')
    expect(decls['featured-posts'].schema).toBe('@std/article')
  })
})
