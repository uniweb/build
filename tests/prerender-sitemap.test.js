/**
 * ⭐ THE STATIC BUILD'S SITEMAP IS THE ONE A HOST SERVING THE SITE FROM ITS CONTENT MAKES, and it
 * lists exactly the pages the build wrote, at the URLs their heads state.
 *
 * This runs the build's own prerender over a site on disk in two languages: a parametric page and
 * its records, a folder that sends visitors to its first page, an authored redirect, a page kept out
 * of search, and a page whose render fails. Then: every listed URL is a page the build wrote, whose
 * `<link rel="canonical">` is that URL; and the file is byte for byte what `@uniweb/projections`
 * makes from each language's content and the record entries a host holds
 * (`generateRecordSearchIndex`), less the one page the build could not write.
 *
 * ⚠️ Reaches `@uniweb/runtime/ssr`, a BUILT artifact — rebuild it (`pnpm -C
 * framework/runtime build:ssr`) after changing the runtime, or this reads stale code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { recordRoutes, generateRecordSearchIndex, sitemapEntries, renderSitemap } from '@uniweb/projections'
import { prerenderSite } from '../src/prerender.js'

const ADDRESS = 'https://example.com/'
const ITEMS = [
  { $name: 'alpha', title: 'Alpha' },
  { $name: 'beta', title: 'Beta' },
]
const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'
const section = (type) => ({ type, content: { type: 'doc', content: [] }, params: {} })

/** One language's content, as the bundle writes it. */
function content() {
  return {
    config: {
      name: 'T',
      defaultLanguage: 'en',
      languages: ['en', 'fr'],
      i18n: { routeTranslations: { fr: { '/items': '/articles' } } },
      url: ADDRESS,
      trailingSlash: true,
      queries: { items: { schema: '@/item', path: '/data/items.json' } },
    },
    theme: {},
    pages: [
      { route: '/', id: 'home', isIndex: true, title: 'Home', sections: [section('Plain')], lastModified: '2026-10-20T10:00:00.000Z' },
      { route: '/items', id: 'items', title: 'Items', fetch: { query: 'items', as: 'items' }, sections: [section('Plain')] },
      {
        route: '/items/:slug',
        id: 'item',
        parent: '/items',
        isDynamic: true,
        paramName: 'slug',
        title: 'Item',
        seo: { changefreq: 'weekly' },
        sections: [section('Plain')],
      },
      // No content of its own: it sends visitors to its first page.
      { route: '/guide', id: 'guide', title: 'Guide', hasContent: false, sections: [] },
      { route: '/guide/start', id: 'start', title: 'Start', sections: [section('Plain')] },
      { route: '/moved', id: 'moved', title: 'Moved', redirect: '/items', sections: [section('Plain')] },
      { route: '/secret', id: 'secret', title: 'Secret', seo: { noindex: true }, sections: [section('Plain')] },
      // Its render fails, so the build writes no file for it.
      { route: '/broken', id: 'broken', title: 'Broken', sections: [section('Broken')] },
    ],
  }
}

function foundationSource() {
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href
  return `
import React from ${JSON.stringify(react)}
const h = React.createElement
export default { meta: { Plain: {}, Broken: {} } }
export const Plain = ({ block }) => h('p', null, block.page?.title || 'Plain')
export const Broken = () => { throw new Error('Invalid hook call (test)') }
`
}

let root
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'prerender-sitemap-'))
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('site/public/data/items.json', ITEMS)
  write('site/dist/index.html', SHELL)
  write('site/dist/site-content.json', content())
  write('site/dist/fr/index.html', SHELL)
  write('site/dist/fr/site-content.json', content())
  write('site/dist/fr/data/items.json', ITEMS)
  write('foundation/dist/entry.js', foundationSource())
  await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation'), onProgress: () => {} })
}, 60000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const dist = () => join(root, 'site/dist')
const sitemap = () => readFileSync(join(dist(), 'sitemap.xml'), 'utf8')
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

describe('the static build’s sitemap', () => {
  it('⭐ lists each page the build wrote, in each language, its records after the site’s own pages', () => {
    expect(locs(sitemap())).toEqual([
      ADDRESS,
      `${ADDRESS}items/`,
      `${ADDRESS}guide/start/`,
      `${ADDRESS}items/alpha/`,
      `${ADDRESS}items/beta/`,
      `${ADDRESS}fr/`,
      `${ADDRESS}fr/articles/`,
      `${ADDRESS}fr/guide/start/`,
      `${ADDRESS}fr/articles/alpha/`,
      `${ADDRESS}fr/articles/beta/`,
    ])
  })

  it('⭐ every URL it lists is a page the build wrote, whose head names that URL its canonical', () => {
    for (const loc of locs(sitemap())) {
      const file = join(dist(), new URL(loc).pathname, 'index.html')
      expect(existsSync(file), loc).toBe(true)
      const canonical = readFileSync(file, 'utf8').match(/<link rel="canonical" href="([^"]+)"/)?.[1]
      expect(canonical, loc).toBe(loc)
    }
  })

  it('a page whose render failed is not listed — the build wrote no file for it', () => {
    expect(existsSync(join(dist(), 'broken', 'index.html'))).toBe(false)
    expect(sitemap()).not.toContain('/broken/')
  })

  it('⭐ is the file a host makes from each language’s content and its record entries', () => {
    const hosted = ['en', 'fr'].flatMap((locale) => {
      const siteContent = content()
      const records = recordRoutes(siteContent).flatMap(({ name, pattern, field }) =>
        generateRecordSearchIndex(name, { ...siteContent.config.queries[name], pattern, field }, ITEMS, locale).entries
      )
      return sitemapEntries(siteContent, { records, locale })
    })
    // The host's answers every page, its broken one included: a visitor's browser renders it.
    expect(hosted.some((entry) => entry.route === '/broken')).toBe(true)
    expect(sitemap()).toBe(renderSitemap(hosted.filter((entry) => entry.route !== '/broken')))
  })

  it('robots.txt names it', () => {
    expect(readFileSync(join(dist(), 'robots.txt'), 'utf8')).toBe(`User-agent: *\n\nSitemap: ${ADDRESS}sitemap.xml\n`)
  })
})
