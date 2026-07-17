import { scopeFetchedData } from '../src/prerender.js'

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
