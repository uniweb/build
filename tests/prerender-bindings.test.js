/**
 * What the static build's prerender does with a binding — ruled 2026-09-13 and
 * 2026-09-14 [Diego]: a query defines its set, its `limit` included, and a binding
 * narrows that set — its count is how many a list shows, never which records have a
 * page; the query's count is part of which records exist.
 *
 * Measured before these held, each through `executeAllFetches` → `expandDynamicPages`
 * → the runtime's own render-time store:
 *
 *   - a list binding's `limit: 2` made two detail pages of five;
 *   - a section's fetch was executed as authored — a French page baked the English
 *     file — and its baked data outranked the runtime's answer;
 *   - a `[slug]` page whose own section declares the route query rendered every
 *     record on every expanded page: the template's baked list was cloned into each;
 *   - two bindings of one key in a section: the build baked the last, the runtime
 *     delivers the first.
 *
 * ⚠️ Reaches `@uniweb/runtime/ssr`, a BUILT artifact — rebuild it (`pnpm -C
 * framework/runtime build:ssr`) after changing the runtime, or this reads stale code.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPrerender, hydrateDataStore, resolvePageFetchConfigs, prepareProps } from '@uniweb/runtime/ssr'
import { executeAllFetches, expandDynamicPages, readRouteBoundViews } from '../src/prerender.js'

const POSTS = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug, $name: slug, title: slug.toUpperCase() }))
// A delivered record carries `$route` — the page that shows it, filled at render time on
// every lane, the prerender's included (2026-09-14); the build bakes none into the file.
const LINKED = POSTS.map((post) => ({ ...post, $route: `/blog/${post.slug}` }))
const ref = (extra = {}) => ({ query: 'posts', path: '/data/posts.json', as: 'posts', prerender: true, merge: false, ...extra })
const QUERIES = { posts: { schema: '@/post' } }
const noop = () => {}

function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'prerender-bindings-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

const section = (id, fetch = null) => ({ id, type: 'X', content: { type: 'doc', content: [] }, ...(fetch ? { fetch } : {}) })

/** The build's prerender steps, in its order, then the runtime's store for one page. */
async function prerender(content, root, localeInfo = { locale: 'en', defaultLocale: 'en' }) {
  const { fetched, fetchedData, bake } = await executeAllFetches(content, root, noop, localeInfo)
  content.fetchedData = fetchedData
  const templates = { ...content, pages: content.pages }
  content.pages = expandDynamicPages(content.pages, fetched, noop, undefined, { siteFetch: content.config?.fetch ?? null })
  const baked = await readRouteBoundViews({
    templates, pages: content.pages, present: content.fetchedData, resolvePageFetchConfigs, read: bake, locale: localeInfo.locale,
  })
  content.fetchedData = [...content.fetchedData, ...baked]
  const website = initPrerender(content, { default: {} }, []).activeWebsite
  hydrateDataStore(website, content.fetchedData)
  const delivered = (route, index = 0) => {
    const page = website.pages.find((p) => p.route === route)
    return page ? website.entityStore.resolve(page.bodyBlocks[index], {}) : null
  }
  // What the block already holds under each key. It OUTRANKS the store's answer:
  // `prepareProps` fills only the keys a block does not hold.
  const held = (route, index = 0) => website.pages.find((p) => p.route === route)?.bodyBlocks[index]?.parsedContent?.data ?? {}
  // What the component receives: the store's answer merged under what the block holds.
  const rendered = (route, index = 0) => {
    const block = website.pages.find((p) => p.route === route)?.bodyBlocks[index]
    const answer = website.entityStore.resolve(block, {})
    return prepareProps(block, {}, answer.status === 'ready' ? answer.data : null).content.data
  }
  return { routes: content.pages.map((p) => p.route), delivered, held, rendered, fetchedData: content.fetchedData }
}

describe('a count is how many a list shows — never which records have a page', () => {
  const content = () => ({
    config: { queries: QUERIES },
    pages: [
      { route: '/blog', id: 'blog', fetch: ref({ limit: 2 }), sections: [section('list')] },
      { route: '/blog/:slug', id: 'post', isDynamic: true, paramName: 'slug', sections: [section('post')] },
    ],
  })

  it('every record the list page\'s binding selects gets its page — not the two it shows', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const { routes } = await prerender(content(), root)
    expect(routes).toEqual(['/blog', '/blog/a', '/blog/b', '/blog/c', '/blog/d', '/blog/e'])
    rmSync(root, { recursive: true, force: true })
  })

  it('a page past the count delivers its own record, from what the build hydrated', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const { delivered } = await prerender(content(), root)
    expect(delivered('/blog/e')).toEqual({ status: 'ready', data: { posts: [LINKED[4]] } })
    rmSync(root, { recursive: true, force: true })
  })

  it('CONTROL — the list page still embeds and delivers the two it shows', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const { delivered, fetchedData } = await prerender(content(), root)
    expect(fetchedData.find((e) => e._scope === '/blog').data).toEqual(POSTS.slice(0, 2))
    expect(delivered('/blog')).toEqual({ status: 'ready', data: { posts: LINKED.slice(0, 2) } })
    rmSync(root, { recursive: true, force: true })
  })

  it('⛔ a query\'s own limit defines its set — its list shows three, and only those three have pages (ruled 2026-09-14)', async () => {
    // Until then no `limit` decided which records had pages, the query's included:
    // this made six routes of a query that selects three.
    const root = site({ 'public/data/posts.json': POSTS })
    const c = content()
    c.config.queries = { posts: { schema: '@/post', limit: 3 } }
    c.pages[0].fetch = ref()
    const { routes, delivered } = await prerender(c, root)
    expect(routes).toEqual(['/blog', '/blog/a', '/blog/b', '/blog/c'])
    expect(delivered('/blog').data.posts).toEqual(LINKED.slice(0, 3))
    rmSync(root, { recursive: true, force: true })
  })

  it('a list that narrows a query\'s set to fewer still leaves every record of the set its page', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const c = content()
    c.config.queries = { posts: { schema: '@/post', limit: 3 } }
    const { routes, delivered } = await prerender(c, root)
    expect(routes).toEqual(['/blog', '/blog/a', '/blog/b', '/blog/c'])
    expect(delivered('/blog').data.posts).toEqual(LINKED.slice(0, 2))
    expect(delivered('/blog/c')).toEqual({ status: 'ready', data: { posts: [LINKED[2]] } })
    rmSync(root, { recursive: true, force: true })
  })
})

describe('a section\'s fetch is resolved by the runtime\'s rule', () => {
  it('a non-default locale bakes the localized records — not the default locale\'s', async () => {
    const root = site({
      'public/data/posts.json': [{ slug: 'a', title: 'English' }],
      'dist/fr/data/posts.json': [{ slug: 'a', title: 'Français' }],
    })
    const content = { config: {}, pages: [{ route: '/blog', sections: [section('s', ref())] }] }
    await executeAllFetches(content, root, noop, { locale: 'fr', defaultLocale: 'en', distDir: join(root, 'dist') })
    expect(content.pages[0].sections[0].parsedContent.data.posts).toEqual([{ slug: 'a', title: 'Français' }])
    rmSync(root, { recursive: true, force: true })
  })

  it('the binding\'s where narrows the query\'s set — never reaching past its limit (ruled 2026-09-14)', async () => {
    // The set is the query's first two, a and b; the binding keeps what it holds of b, c, d.
    // ⛔ Until then the two were merged — the where applied first, the limit after — and
    // this baked b and c, a record the query does not select.
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: { posts: { schema: '@/post', limit: 2 } } },
      pages: [{ route: '/blog', sections: [section('s', ref({ where: { slug: { in: ['b', 'c', 'd'] } } }))] }],
    }
    await executeAllFetches(content, root, noop, { locale: 'en', defaultLocale: 'en' })
    expect(content.pages[0].sections[0].parsedContent.data.posts.map((p) => p.slug)).toEqual(['b'])
    rmSync(root, { recursive: true, force: true })
  })

  it('⛔ the first binding of a key is baked — as the runtime delivers it, not the last', async () => {
    const root = site({ 'public/data/posts.json': POSTS, 'public/data/other.json': [{ slug: 'z' }] })
    const content = {
      config: {},
      pages: [{ route: '/blog', sections: [section('s', [ref(), { query: 'other', path: '/data/other.json', as: 'posts', prerender: true }])] }],
    }
    await executeAllFetches(content, root, noop, { locale: 'en', defaultLocale: 'en' })
    expect(content.pages[0].sections[0].parsedContent.data.posts).toEqual(POSTS)
    rmSync(root, { recursive: true, force: true })
  })

  it('⛔ a list a section fetches for itself reaches its component linked (2026-09-14)', async () => {
    // The build bakes the section's list into its content, and what a block holds outranks
    // the store's answer — the one that carries `$route`. Until this held the component got
    // the baked records bare, so a list on a prerendered page linked nowhere.
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: QUERIES },
      pages: [
        { route: '/blog', id: 'blog', sections: [section('list', ref({ limit: 2 }))] },
        { route: '/blog/:slug', id: 'post', isDynamic: true, paramName: 'slug', fetch: ref(), sections: [section('post')] },
      ],
    }
    const { held, rendered } = await prerender(content, root)
    expect(held('/blog').posts).toEqual(POSTS.slice(0, 2))
    expect(rendered('/blog').posts).toEqual(LINKED.slice(0, 2))
    rmSync(root, { recursive: true, force: true })
  })

  it('CONTROL — a key the section holds from no fetch of its own is left as it is', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: QUERIES },
      pages: [
        { route: '/blog', id: 'blog', sections: [{ ...section('list'), parsedContent: { data: { posts: POSTS.slice(0, 1) } } }] },
        { route: '/blog/:slug', id: 'post', isDynamic: true, paramName: 'slug', fetch: ref(), sections: [section('post')] },
      ],
    }
    const { rendered } = await prerender(content, root)
    expect(rendered('/blog').posts).toEqual(POSTS.slice(0, 1))
    rmSync(root, { recursive: true, force: true })
  })
})

describe('a parametric page\'s sections are the runtime\'s to fill', () => {
  const content = () => ({
    config: { queries: QUERIES },
    pages: [
      { route: '/blog', id: 'blog', sections: [section('list')] },
      { route: '/blog/:slug', id: 'post', isDynamic: true, paramName: 'slug', sections: [section('post', ref())] },
    ],
  })

  it('the template\'s section carries nothing baked', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const c = content()
    await executeAllFetches(c, root, noop, { locale: 'en', defaultLocale: 'en' })
    expect(c.pages[1].sections[0].parsedContent).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  it('⛔ each expanded page delivers ITS record, when its own section declares the route query', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const { routes, delivered, held } = await prerender(content(), root)
    expect(routes).toEqual(['/blog', '/blog/a', '/blog/b', '/blog/c', '/blog/d', '/blog/e'])
    expect(delivered('/blog/b')).toEqual({ status: 'ready', data: { posts: [LINKED[1]] } })
    expect(delivered('/blog/e')).toEqual({ status: 'ready', data: { posts: [LINKED[4]] } })
    // and nothing the block holds outranks it — the whole list did, cloned from the template
    expect(held('/blog/b').posts).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('`current:` and nested pages reach a static build (ruled 2026-09-13)', () => {
  it('a section with `current: exclude` gets the others on every expanded page, `limit` counting them', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: QUERIES },
      pages: [
        { route: '/blog', id: 'blog', fetch: ref(), sections: [section('list')] },
        { route: '/blog/:slug', id: 'post', parent: '/blog', isDynamic: true, paramName: 'slug', sections: [section('post'), section('related', ref({ current: 'exclude', limit: 2 }))] },
      ],
    }
    const { delivered } = await prerender(content, root)
    expect(delivered('/blog/a', 1)).toEqual({ status: 'ready', data: { posts: [LINKED[1], LINKED[2]] } })
    expect(delivered('/blog/b', 1)).toEqual({ status: 'ready', data: { posts: [LINKED[0], LINKED[2]] } })
    expect(delivered('/blog/b', 0)).toEqual({ status: 'ready', data: { posts: [LINKED[1]] } })
    rmSync(root, { recursive: true, force: true })
  })

  it('⭐ `current:` follows the query — a fetch of the route query under a key of its own gets the others (2026-09-14)', async () => {
    // Until then `current:` was read under the route key alone: `related` got the list.
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: QUERIES },
      pages: [
        { route: '/blog', id: 'blog', fetch: ref(), sections: [section('list')] },
        { route: '/blog/:slug', id: 'post', parent: '/blog', isDynamic: true, paramName: 'slug', sections: [section('post'), section('related', ref({ as: 'related', current: 'exclude', limit: 2 }))] },
      ],
    }
    const { delivered } = await prerender(content, root)
    expect(delivered('/blog/b', 1)).toEqual({ status: 'ready', data: { related: [LINKED[0], LINKED[2]], posts: [LINKED[1]] } })
    rmSync(root, { recursive: true, force: true })
  })

  it('a page nested inside `[slug]` expands per record and delivers the record — its route query two levels up', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: QUERIES },
      pages: [
        { route: '/blog', id: 'blog', fetch: ref({ limit: 2 }), sections: [section('list')] },
        { route: '/blog/:slug', id: 'post', parent: '/blog', isDynamic: true, paramName: 'slug', sections: [section('post')] },
        { route: '/blog/:slug/cv', id: 'cv', parent: '/blog/:slug', isDynamic: true, paramName: 'slug', sections: [section('cv')] },
      ],
    }
    const { routes, delivered } = await prerender(content, root)
    expect(routes).toEqual(expect.arrayContaining(['/blog/e', '/blog/e/cv', '/blog/a/cv']))
    expect(delivered('/blog/e/cv')).toEqual({ status: 'ready', data: { posts: [LINKED[4]] } })
    rmSync(root, { recursive: true, force: true })
  })
})
