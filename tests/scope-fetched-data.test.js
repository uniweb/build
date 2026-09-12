import { scopeFetchedData, readRouteBoundViews } from '../src/prerender.js'

// In split-content mode each prerendered page embeds only the fetched
// (collection/API) data its own first render reads — the block → page →
// page.parent → site cascade — instead of the whole site's data. Entries are
// tagged with `_scope` ('__site__' or the owning page route) at fetch time and
// the tag is always stripped before embedding.
const site = { config: { fetch: {} }, data: [1], _scope: '__site__' }
const blog = { config: { path: '/data/articles.json', schema: 'articles' }, data: [1, 2, 3], _scope: '/blog' }
const shop = { config: { path: '/data/products.json', schema: 'products' }, data: [9], _scope: '/shop' }
const all = [site, blog, shop]

describe('scopeFetchedData', () => {
  it('keeps only site-level + entries owned by routes in the page cascade', () => {
    // /blog cascade = { '/blog' } (+ site always)
    const out = scopeFetchedData(all, new Set(['/blog']))
    expect(out.map((e) => e.config.schema ?? 'site')).toEqual(['site', 'articles'])
    expect(out).not.toContainEqual(expect.objectContaining({ config: expect.objectContaining({ schema: 'products' }) }))
  })

  it('gives a detail page its parent list route data (concrete /blog/x → scope has /blog)', () => {
    // A dynamic detail page's scope set includes its own route and its parent route
    const out = scopeFetchedData(all, new Set(['/blog/my-post', '/blog']))
    expect(out.map((e) => e.data)).toEqual([[1], [1, 2, 3]]) // site + articles, not products
  })

  it('gives a fetch-less page only site-level data (the payload win)', () => {
    const out = scopeFetchedData(all, new Set(['/about']))
    expect(out).toEqual([{ config: { fetch: {} }, data: [1] }]) // site only, no articles/products
  })

  it('empty scope set (SPA fallback / 404) keeps site-level only', () => {
    expect(scopeFetchedData(all, new Set()).map((e) => e._scope)).toEqual([undefined]) // one entry, tag stripped
  })

  it('null scopeRoutes (non-split) keeps everything', () => {
    expect(scopeFetchedData(all, null)).toHaveLength(3)
  })

  it('always strips the internal _scope tag from every returned entry', () => {
    for (const scope of [new Set(['/blog']), new Set(), null]) {
      for (const e of scopeFetchedData(all, scope)) {
        expect(e).not.toHaveProperty('_scope')
      }
    }
  })
})

describe('a route-bound entry belongs to its own page, in either mode (2026-09-11)', () => {
  // `readRouteBoundViews` reads one view per expanded parametric page. Carried to
  // every page, a site of N such pages would embed N views — or N whole records —
  // in each of them (measured on the first version of the bake).
  const alice = { config: { path: '/data/members/alice.json', as: 'members' }, data: { slug: 'alice' }, _scope: '/members/alice', _routeBound: true }
  const bob = { config: { path: '/data/members/bob.json', as: 'members' }, data: { slug: 'bob' }, _scope: '/members/bob', _routeBound: true }
  const withViews = [...all, alice, bob]
  const slugs = (out) => out.map((e) => e.data?.slug).filter(Boolean)

  it('non-split: every ordinary entry, and only the current page\'s own route-bound one', () => {
    const out = scopeFetchedData(withViews, null, '/members/alice')
    expect(out).toHaveLength(all.length + 1)
    expect(slugs(out)).toEqual(['alice'])
  })

  it('split: the cascade\'s entries, and only the current page\'s own — whatever else the cascade names', () => {
    const out = scopeFetchedData(withViews, new Set(['/members/alice', '/members/bob']), '/members/alice')
    expect(slugs(out)).toEqual(['alice'])
    expect(out.map((e) => e._scope)).toEqual([undefined, undefined])
  })

  it('any other page — or no page — gets none', () => {
    expect(slugs(scopeFetchedData(withViews, null, '/blog'))).toEqual([])
    expect(slugs(scopeFetchedData(withViews, null))).toEqual([])
  })

  it('strips the internal _routeBound tag', () => {
    for (const e of scopeFetchedData(withViews, null, '/members/alice')) expect(e).not.toHaveProperty('_routeBound')
  })
})

describe('readRouteBoundViews', () => {
  const list = { path: '/data/members.json', as: 'members' }
  const view = (slug) => ({ path: `/data/members/${slug}.json`, as: 'members' })
  const pages = [
    { route: '/members' },
    { route: '/members/alice', dynamicContext: { paramValue: 'alice' } },
    { route: '/members/bob', dynamicContext: { paramValue: 'bob' } },
  ]
  const read = vi.fn(async (cfg) => ({ config: cfg, data: cfg.path }))
  beforeEach(() => { read.mockClear() })

  it('reads what each expanded page resolves, filed under that page — skipping what is carried already and pages that are not expanded', async () => {
    const resolvePageFetchConfigs = vi.fn((_templates, route) => [list, view(route.split('/').pop())])
    const out = await readRouteBoundViews({ templates: {}, pages, present: [{ config: list, data: [] }], resolvePageFetchConfigs, read })
    expect(resolvePageFetchConfigs.mock.calls.map((c) => c[1])).toEqual(['/members/alice', '/members/bob'])
    expect(read.mock.calls.map(([cfg]) => cfg.path)).toEqual(['/data/members/alice.json', '/data/members/bob.json'])
    expect(out.map((e) => [e.data, e._scope, e._routeBound])).toEqual([
      ['/data/members/alice.json', '/members/alice', true],
      ['/data/members/bob.json', '/members/bob', true],
    ])
  })

  it('a view two pages bind alike is read ONCE and filed under EACH — the second page is not left without it', async () => {
    // ⛔ The first version filed it under the first page only (measured: the second
    // entry in a branch shipped without its branch's view).
    const branch = { path: '/data/members.json', as: 'members', scope: 'field' }
    const out = await readRouteBoundViews({ templates: {}, pages, present: [], resolvePageFetchConfigs: () => [branch], read })
    expect(read).toHaveBeenCalledTimes(1)
    expect(out.map((e) => e._scope)).toEqual(['/members/alice', '/members/bob'])
    expect(scopeFetchedData(out, null, '/members/bob').map((e) => e.config.scope)).toEqual(['field'])
  })

  it('a read with nothing to embed adds nothing', async () => {
    const out = await readRouteBoundViews({ templates: {}, pages, present: [], resolvePageFetchConfigs: (_t, r) => [view(r)], read: async () => null })
    expect(out).toEqual([])
  })
})

describe('one entry per address — a query several pages declare is embedded once (2026-09-12)', () => {
  // ⛔ Entries are collected per page, so four pages declaring the same two queries
  // produced eight entries and unsplit mode put all eight in every page. Measured on
  // a real build: 46% of the HTML was the duplicates.
  const articles = (route) => ({ config: { path: '/data/articles.json', as: 'articles' }, data: [1, 2, 3], _scope: route })
  const people = (route) => ({ config: { path: '/data/people.json', as: 'people' }, data: [4], _scope: route })
  const four = [articles('/a'), people('/a'), articles('/b'), people('/b'), articles('/c'), people('/c')]

  it('unsplit: the whole site\'s data, each address once', () => {
    const out = scopeFetchedData(four, null, '/a')
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.config.as)).toEqual(['articles', 'people'])
  })

  it('split: the cascade\'s entries, each address once', () => {
    const out = scopeFetchedData(four, new Set(['/a', '/b']), '/a')
    expect(out.map((e) => e.config.as)).toEqual(['articles', 'people'])
  })

  it('⭐ the deduped entry is the SAME answer — the key is what the SPA looks it up under', () => {
    // Two entries sharing a cache key answer the same question, so which one
    // survives cannot change what a page reads.
    const out = scopeFetchedData(four, null, '/a')
    expect(out[0].data).toEqual([1, 2, 3])
  })

  it('a page keeps its OWN route-bound view — a different address, not a duplicate', () => {
    const view = { config: { path: '/data/articles.json', as: 'articles', scope: 'field' }, data: [9], _scope: '/a/x', _routeBound: true }
    const out = scopeFetchedData([...four, view], null, '/a/x')
    expect(out).toHaveLength(3)
    expect(out.filter((e) => e.config.scope === 'field')).toHaveLength(1)
  })

  it('entries that differ by view are NOT duplicates — where/sort/limit are part of the address', () => {
    const filtered = { config: { path: '/data/articles.json', as: 'articles', limit: 3 }, data: [1], _scope: '/b' }
    const out = scopeFetchedData([articles('/a'), filtered], null, '/a')
    expect(out).toHaveLength(2)
  })
})
