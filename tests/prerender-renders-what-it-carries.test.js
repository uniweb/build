/**
 * ⭐ A PAGE IS PRERENDERED AGAINST WHAT IT CARRIES — the data its HTML embeds, which is all the
 * browser's store holds when it boots on that page (`initUniweb` hydrates from it).
 *
 * The browser renders over the prerendered page rather than hydrating it, so whatever the prerender
 * read that the page does not carry is content the browser takes away again at boot, replaced by a
 * loading state. ⛔ Until 2026-10-25 the static build hydrated one store for a whole locale and
 * filed every page's answers into it in turn, so a section reading the store directly — kit's
 * `useFetched` and `useWholeRecord` do — rendered what the pages before it had fetched (measured
 * with records fetched whole, on a page that showed them through `useWholeRecord`).
 *
 * This runs the build's own prerender over a site on disk: a page whose section is given its records
 * whole, which its data step fetches, and a page after it whose section reads the store for one of
 * them, which its own page never asks for.
 *
 * ⚠️ Reaches `@uniweb/runtime/ssr`, a BUILT artifact — rebuild it (`pnpm -C
 * framework/runtime build:ssr`) after changing the runtime, or this reads stale code.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prerenderSite } from '../src/prerender.js'

// Records synced once carry a `$uuid`, so the store files each one by it, brief or whole.
const ITEMS = [{ $uuid: 'u-seven', $name: 'seven', title: 'Seven' }]
const SEVEN = { ...ITEMS[0], body: 'Full' }

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

const section = (type) => ({ type, content: { type: 'doc', content: [] }, params: {} })

function content({ splitContent }) {
  return {
    config: {
      name: 'T',
      defaultLanguage: 'en',
      queries: { items: { schema: '@/item', path: '/data/items.json' } },
      build: { splitContent },
    },
    theme: {},
    pages: [
      // Its section is given the records WHOLE, so its data step fetches each record's own file.
      { route: '/', id: 'home', isIndex: true, title: 'Home', fetch: { query: 'items', as: 'items' }, sections: [section('Featured')] },
      // Declares nothing. Its section reads the store, as a kit hook does.
      { route: '/about', id: 'about', title: 'About', sections: [section('Peek')] },
      // A page for each record, whose section is given its record whole.
      { route: '/items', id: 'items', title: 'Items', fetch: { query: 'items', as: 'items' }, sections: [section('Plain')] },
      {
        route: '/items/:slug',
        id: 'item',
        parent: '/items',
        isDynamic: true,
        paramName: 'slug',
        title: 'Item',
        sections: [section('ItemPage')],
      },
    ],
  }
}

/**
 * The foundation, as a built `entry.js`: section components as named exports beside the default
 * export's metas. React is imported by its resolved file, so the module loads from a temp directory.
 */
function foundationSource() {
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href
  return `
import React from ${JSON.stringify(react)}
const h = React.createElement
export default {
  meta: {
    Featured: { data: { items: { schema: '@test/items', whole: true } } },
    Peek: {},
    Plain: {},
    ItemPage: { data: { items: { schema: '@test/items', whole: true } } },
  },
}
export const Featured = ({ content }) =>
  h('ul', null, (content.data.items || []).map((r) => h('li', { key: r.$name }, r.body)))
export const Plain = () => h('p', null, 'Plain')
export const ItemPage = ({ content, block }) =>
  h('article', null, block.dataLoading ? 'loading' : (content.data.items?.[0]?.body ?? 'empty'))
export const Peek = () => {
  const held = globalThis.uniweb.activeWebsite.dataStore.getRecord('u-seven')
  return h('p', { id: 'peek' }, held ? (held.whole ? 'whole' : 'brief') : 'none')
}
`
}

function project(siteContent) {
  const root = mkdtempSync(join(tmpdir(), 'prerender-carries-'))
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('site/public/data/items.json', ITEMS)
  write('site/public/data/items/seven.json', SEVEN)
  write('site/dist/index.html', SHELL)
  write('site/dist/site-content.json', siteContent)
  write('foundation/dist/entry.js', foundationSource())
  return root
}

/** The page's HTML: what it shows, and the data it carries for the browser's store. */
function pageAt(root, route) {
  const html = readFileSync(join(root, 'site/dist', route === '/' ? '' : route, 'index.html'), 'utf8')
  const json = html.match(/<script id="__SITE_CONTENT__"[^>]*>([\s\S]*?)<\/script>/)[1]
  return { html, carried: JSON.parse(json).fetchedData || [] }
}

const carriesWhole = (carried) => carried.some((e) => e.config?.path?.endsWith('/data/items/seven.json'))

describe.each([false, true])('a page renders against what it carries (splitContent: %s)', (splitContent) => {
  it('the page after one that fetched a record whole renders without it — it carries no such record', async () => {
    const root = project(content({ splitContent }))
    try {
      await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })

      // CONTROL: the first page fetched the record whole, shows it, and carries it.
      const home = pageAt(root, '/')
      expect(home.html).toContain('<li>Full</li>')
      expect(carriesWhole(home.carried)).toBe(true)

      // ⛔ It rendered `whole` until 2026-10-25: the record the first page had fetched.
      const about = pageAt(root, '/about')
      expect(carriesWhole(about.carried)).toBe(false)
      const shown = about.html.match(/<p id="peek">(\w+)<\/p>/)[1]
      // What the browser's store holds at boot on this page: the list's brief where the page
      // carries the list, nothing where it does not.
      const listCarried = about.carried.some((e) => e.config?.path === '/data/items.json')
      expect(shown).toBe(listCarried ? 'brief' : 'none')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('…and a record page after one that fetched its record whole still asks for it, carries it and shows it', async () => {
    // The build's data step shares one cache across its pages, and the record page asks first
    // whether its record is held whole already. ⛔ The answer was the earlier page's, so the record
    // page asked for nothing and carried nothing — and, rendered against what it carries, showed
    // its loading state (`loadPageData`, 2026-10-25).
    const root = project(content({ splitContent }))
    try {
      await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation') })
      const item = pageAt(root, '/items/seven')
      expect(carriesWhole(item.carried)).toBe(true)
      expect(item.html).toContain('<article>Full</article>')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
