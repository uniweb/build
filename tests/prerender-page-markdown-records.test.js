/**
 * ⭐ A PRERENDERED PAGE'S MARKDOWN CARRIES THE RECORDS ITS SECTIONS SHOW — what the page's render
 * read (`render(…, { sectionData: true })`), written after each section by the one writer of a
 * language's projections (`agentFiles`).
 *
 * The case that asked for it: a pricing page whose cards show each tier's price from records. Its
 * Markdown held what the author wrote and nothing its sections drew from records, so an assistant
 * reading it found no price (measured on a site built with uniweb 1.30.2). The page's HTML carried
 * more records than its sections show — another page's query among them — which is why the records
 * come from the render and not from what the page carries.
 *
 * This runs the build's own prerender over a site on disk, as `prerender-renders-what-it-carries`
 * does. ⚠️ It reaches `@uniweb/runtime/ssr`, a BUILT artifact: rebuild it (`pnpm -C framework/runtime
 * build:ssr`) after changing the runtime, or this reads stale code.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prerenderSite } from '../src/prerender.js'

const TIERS = [
  { $name: 'basic', title: 'Basic', price: 148 },
  { $name: 'pro', title: 'Pro', price: 298 },
]
const ARTICLES = [
  { $name: 'a', title: 'A post' },
  { $name: 'b', title: 'B post' },
]

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

const doc = (...nodes) => ({ type: 'doc', content: nodes })
const heading = (text) => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] })
const dataBlock = (tag, data) => ({ type: 'dataBlock', attrs: { tag, language: 'yaml', data } })
const section = (type, stableId, over = {}) => ({ type, stableId, content: doc(heading(stableId)), params: {}, ...over })

function content() {
  return {
    config: {
      name: 'T',
      defaultLanguage: 'en',
      queries: {
        tiers: { schema: '@/tier', path: '/data/tiers.json' },
        articles: { schema: '@/article', path: '/data/articles.json' },
      },
      // The site's binding: every top-level page carries the articles, whether or not it shows them.
      fetch: { query: 'articles', as: 'articles' },
    },
    theme: {},
    pages: [
      { route: '/', id: 'home', isIndex: true, title: 'Home', sections: [section('Plain', 'home')] },
      {
        route: '/pricing',
        id: 'pricing',
        title: 'Pricing',
        sections: [
          // The section's own fetch, which the build prerenders into it.
          section('Plans', 'plans', { content: doc(heading('Priced by the tier your academy runs on.')), fetch: [{ query: 'tiers', as: 'tiers' }] }),
          section('Compare', 'compare', {
            content: doc(heading('Compare'), dataBlock('comparison', { rows: [{ label: 'From {price}' }] })),
            fetch: [{ query: 'tiers', as: 'tiers' }],
          }),
        ],
      },
      // As the build writes a fetch: with its compiled file's address, which a record page's markdown reads.
      { route: '/blog', id: 'blog', title: 'Blog', fetch: { query: 'articles', as: 'articles', path: '/data/articles.json' }, sections: [section('ArticleList', 'list')] },
      {
        route: '/blog/:slug',
        id: 'post',
        parent: '/blog',
        isDynamic: true,
        paramName: 'slug',
        title: 'Post',
        sections: [
          section('ArticleBody', 'body'),
          section('Related', 'related', { fetch: { query: 'articles', as: 'related', current: 'exclude' } }),
        ],
      },
    ],
  }
}

function foundationSource() {
  const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href
  return `
import React from ${JSON.stringify(react)}
const h = React.createElement
const list = (key) => ({ content }) => h('ul', null, (content.data[key] || []).map((r) => h('li', { key: r.$name }, r.title)))
export default {
  meta: {
    Plain: {},
    Plans: { data: { tiers: '@/tier' } },
    Compare: { data: { comparison: null, tiers: '@/tier' } },
    ArticleList: { data: { articles: '@/article' } },
    ArticleBody: { data: { article: { schema: '@/article', single: true } } },
    Related: { data: { related: '@/article' } },
  },
}
export const Plain = () => h('p', null, 'plain')
export const Plans = ({ content }) => h('ul', null, (content.data.tiers || []).map((t) => h('li', { key: t.$name }, '$' + t.price)))
export const Compare = () => h('table', null)
export const ArticleList = list('articles')
export const ArticleBody = ({ content }) => h('article', null, content.data.article?.title ?? 'none')
export const Related = list('related')
`
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'prerender-md-records-'))
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('site/public/data/tiers.json', TIERS)
  write('site/public/data/articles.json', ARTICLES)
  for (const article of ARTICLES) write(`site/public/data/articles/${article.$name}.json`, article)
  write('site/dist/index.html', SHELL)
  write('site/dist/site-content.json', content())
  write('foundation/dist/entry.js', foundationSource())
  return root
}

async function built() {
  const root = project()
  const lines = []
  await prerenderSite(join(root, 'site'), { foundationDir: join(root, 'foundation'), onProgress: (line) => lines.push(line) })
  const read = (file) => readFileSync(join(root, 'site/dist', file), 'utf8')
  return { root, lines, read, has: (file) => existsSync(join(root, 'site/dist', file)) }
}

describe('a prerendered page\'s markdown carries the records its sections show', () => {
  it('⭐ the pricing page: its prices, under the fetch\'s name, after the section that shows them', async () => {
    const { root, read, lines } = await built()
    try {
      const md = read('pricing.md')
      expect(md).toContain('# Priced by the tier your academy runs on.\n\n<!-- tiers -->\n\n```json')
      expect(md).toContain('"price": 148')
      // The second section shows the same records: named again, not repeated.
      expect(md.match(/"price": 148/g)).toHaveLength(1)
      expect(md).toContain('<!-- tiers: as above -->')
      // Its tagged block once, as written; not again as records.
      expect(md.match(/comparison/g)).toHaveLength(1)
      expect(md).toContain('From {price}')
      expect(lines.some((line) => /Page markdown: \d+ pages? now carry the records their sections show/.test(line))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('CONTROL — records the page\'s HTML carries and no section of it shows are not in its markdown', async () => {
    const { root, read } = await built()
    try {
      // The HTML carries the site's articles (its binding reaches every top-level page)…
      expect(read('pricing/index.html')).toContain('/data/articles.json')
      // …and the markdown names none of them.
      expect(read('pricing.md')).not.toContain('A post')
      // CONTROL: the blog page's section shows them, and its markdown carries them.
      expect(read('blog.md')).toContain('<!-- articles -->')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a record page: its record once, as before, and its sections\' other records beside them', async () => {
    const { root, read } = await built()
    try {
      const md = read('blog/a.md')
      expect(md).toContain('<!-- related -->')
      expect(md).toContain('"title": "B post"')
      // The page's own record, which its first section shows, is written once — as the page's.
      expect(md.match(/"title": "A post"/g)).toHaveLength(1)
      expect(md.trimEnd().endsWith('```json\n' + JSON.stringify(ARTICLES[0], null, 2) + '\n```')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a page whose sections showed no records is left as the bundle step wrote it', async () => {
    const { root, has } = await built()
    try {
      // The bundle step didn't run here, so nothing wrote the home page's markdown — and neither did this.
      expect(has('index.md')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
