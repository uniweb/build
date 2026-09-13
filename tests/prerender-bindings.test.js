/**
 * What the static build's prerender does with a binding — ruled 2026-09-13 [Diego]:
 * a binding narrows its query and picks its own count, and a count is how many a
 * list shows, never which records have a page.
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
import { initPrerender, hydrateDataStore, resolvePageFetchConfigs } from '@uniweb/runtime/ssr'
import { executeAllFetches, expandDynamicPages, readRouteBoundViews } from '../src/prerender.js'

const POSTS = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug, $name: slug, title: slug.toUpperCase() }))
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
  return { routes: content.pages.map((p) => p.route), delivered, held, fetchedData: content.fetchedData }
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
    expect(delivered('/blog/e')).toEqual({ status: 'ready', data: { posts: [POSTS[4]] } })
    rmSync(root, { recursive: true, force: true })
  })

  it('CONTROL — the list page still embeds and delivers the two it shows', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const { delivered, fetchedData } = await prerender(content(), root)
    expect(fetchedData.find((e) => e._scope === '/blog').data).toEqual(POSTS.slice(0, 2))
    expect(delivered('/blog')).toEqual({ status: 'ready', data: { posts: POSTS.slice(0, 2) } })
    rmSync(root, { recursive: true, force: true })
  })

  it('a query\'s own limit reaches the list through the resolved binding — the compiled file is not cut', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const c = content()
    c.config.queries = { posts: { schema: '@/post', limit: 3 } }
    c.pages[0].fetch = ref()
    const { routes, delivered } = await prerender(c, root)
    expect(routes).toHaveLength(6)
    expect(delivered('/blog').data.posts).toEqual(POSTS.slice(0, 3))
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

  it('the query\'s limit and the binding\'s where both apply', async () => {
    const root = site({ 'public/data/posts.json': POSTS })
    const content = {
      config: { queries: { posts: { schema: '@/post', limit: 2 } } },
      pages: [{ route: '/blog', sections: [section('s', ref({ where: { slug: { in: ['b', 'c', 'd'] } } }))] }],
    }
    await executeAllFetches(content, root, noop, { locale: 'en', defaultLocale: 'en' })
    expect(content.pages[0].sections[0].parsedContent.data.posts.map((p) => p.slug)).toEqual(['b', 'c'])
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
    expect(delivered('/blog/b')).toEqual({ status: 'ready', data: { posts: [POSTS[1]] } })
    expect(delivered('/blog/e')).toEqual({ status: 'ready', data: { posts: [POSTS[4]] } })
    // and nothing the block holds outranks it — the whole list did, cloned from the template
    expect(held('/blog/b').posts).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })
})
