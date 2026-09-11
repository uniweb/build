/**
 * `query:` — the shorthand for `fetch: { query }` — at every level that declares
 * data (a section's frontmatter, `page.yml`, `folder.yml`; `site.yml` is covered
 * by `site-fetch-shorthand.test.js`), on the static build and on the sync push,
 * and back through a pull. Ruled 2026-09-11 [Diego]:
 *
 *   - `query:` takes a query name or a list of names; anything richer is `fetch:`;
 *   - `data:`, the key it replaces, is refused — in frontmatter an unreserved key
 *     becomes a section param, so ignoring it would render an empty section;
 *   - a `folder.yml` declares on both lanes — the static build dropped it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument, siteContentDocumentToProject, sectionRecordToFile } from '../src/uwx/index.js'

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
  try {
    return await collectSiteContent(root, { strict: false })
  } finally {
    restore()
  }
}
const page = (content, route) => content.pages.find((p) => p.route === route)
/** A page record on the sync wire, by slug, at any depth. */
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
const frontmatterOf = (file) => yaml.load(readFileSync(file, 'utf8').split('---')[1])
const yamlOf = (file) => yaml.load(readFileSync(file, 'utf8'))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'query-shorthand-'))
  w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\n')
  // `about` sorts first, so it is the homepage and the rest keep their routes
  w('pages/about/about.md', '---\ntype: About\n---\n# About\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a section declares its own data with `query:`', () => {
  it('one name, or a list — one config per name, and `query` is not a param', async () => {
    w('pages/home/1-a.md', '---\ntype: Grid\nquery: team\n---\n# A\n')
    w('pages/home/2-b.md', '---\ntype: Grid\nquery: [team, articles]\n---\n# B\n')
    const [a, b] = page(await collect(), '/home').sections
    expect(a.fetch).toMatchObject({ query: 'team', as: 'team' })
    expect(a.params).not.toHaveProperty('query')
    expect(b.fetch.map((f) => f.as)).toEqual(['team', 'articles'])
  })

  it('the sync push carries it as the section\'s fetch', async () => {
    w('pages/home/1-a.md', '---\ntype: Grid\nquery: team\n---\n# A\n')
    const home = wirePage(await siteProjectToDocument(ROOT), 'home')
    expect(home.page_sections[0].fetch).toMatchObject({ query: 'team' })
  })

  it('refuses a retired `data:`, naming the file and the key that replaced it', async () => {
    w('pages/home/1-a.md', '---\ntype: Grid\ndata: team\n---\n# A\n')
    await expect(collect()).rejects.toThrow(/pages\/home\/1-a\.md: `data:` is retired .*Write `query: team`/)
    await expect(siteProjectToDocument(ROOT)).rejects.toThrow(/`data:` is retired/)
  })

  it('refuses `query:` beside `fetch:` — `fetch:` used to win, silently', async () => {
    w('pages/home/1-a.md', '---\ntype: Grid\nquery: team\nfetch: { query: articles }\n---\n# A\n')
    await expect(collect()).rejects.toThrow(/declare `query:` or `fetch:`, not both/)
  })

  it('refuses a `query:` that is not names — anything richer is `fetch:`', async () => {
    for (const value of ['3', '[]', "''", '{ name: team, limit: 3 }']) {
      w('pages/home/1-a.md', `---\ntype: Grid\nquery: ${value}\n---\n# A\n`)
      await expect(collect(), value).rejects.toThrow(/`query:` takes a query name or a list of names/)
    }
  })
})

describe('page.yml and folder.yml', () => {
  it('a page.yml `query:` is the page\'s fetch on both lanes', async () => {
    w('pages/blog/page.yml', 'title: Blog\nquery: articles\n')
    w('pages/blog/list.md', '---\ntype: List\n---\n# Blog\n')
    expect(page(await collect(), '/blog').fetch).toMatchObject({ query: 'articles', as: 'articles' })
    expect(wirePage(await siteProjectToDocument(ROOT), 'blog').fetch).toMatchObject({ query: 'articles', as: 'articles' })
  })

  it('⭐ a folder.yml declares on the static build as it does on the push — its pages read it through their parent', async () => {
    // ⛔ The build set a folder.yml container's fetch to null: `push` carried the
    // declaration and a hosted site had the data; an exported one had none.
    w('pages/docs/folder.yml', 'title: Docs\nquery: docs\n')
    w('pages/docs/intro.md', '---\ntype: Doc\n---\n# Intro\n')
    const content = await collect()
    expect(page(content, '/docs').fetch).toMatchObject({ query: 'docs', as: 'docs' })
    expect(page(content, '/docs/intro').parent).toBe('/docs')
    expect(wirePage(await siteProjectToDocument(ROOT), 'docs').fetch).toMatchObject({ query: 'docs', as: 'docs' })
  })

  it('CONTROL — the long form in a folder.yml, which the build dropped as well', async () => {
    w('pages/docs/folder.yml', 'title: Docs\nfetch: { query: docs, limit: 3 }\n')
    w('pages/docs/intro.md', '---\ntype: Doc\n---\n# Intro\n')
    expect(page(await collect(), '/docs').fetch).toMatchObject({ query: 'docs', limit: 3 })
  })

  it('refuses `data:` in a page.yml, and points a map at `queries:`', async () => {
    w('pages/blog/page.yml', 'title: Blog\ndata: articles\n')
    await expect(collect()).rejects.toThrow(/pages\/blog\/page\.yml: `data:` is retired/)
    w('pages/blog/page.yml', 'title: Blog\nquery:\n  articles: { schema: "@/article" }\n')
    await expect(collect()).rejects.toThrow(/Declaring queries\? That is `queries:`/)
  })
})

describe('a pull writes ONE declaration key back — the one the file uses', () => {
  const pull = async () => {
    const doc = await siteProjectToDocument(ROOT)
    siteContentDocumentToProject({ document: doc, siteRoot: ROOT })
  }

  it('a page.yml keeps `query:` — never `fetch:` beside it — and one that typed `fetch:` keeps `fetch:`', async () => {
    w('pages/blog/page.yml', 'title: Blog\nquery: [articles, team]\n')
    w('pages/news/page.yml', 'title: News\nfetch:\n  query: articles\n')
    await pull()
    const blog = yamlOf(join(ROOT, 'pages/blog/page.yml'))
    expect(blog.query).toEqual(['articles', 'team'])
    expect(blog).not.toHaveProperty('fetch')
    const news = yamlOf(join(ROOT, 'pages/news/page.yml'))
    expect(news.fetch).toMatchObject({ query: 'articles' })
    expect(news).not.toHaveProperty('query')
    // and the pulled files build
    await expect(collect()).resolves.toBeDefined()
  })

  it('a page.yml holding a retired `data:` line gets the declaration in its place', async () => {
    w('pages/blog/page.yml', 'title: Blog\nquery: articles\n')
    const doc = await siteProjectToDocument(ROOT)
    w('pages/blog/page.yml', 'title: Blog\ndata: articles\n')
    siteContentDocumentToProject({ document: doc, siteRoot: ROOT })
    const blog = yamlOf(join(ROOT, 'pages/blog/page.yml'))
    expect(blog).toMatchObject({ query: 'articles' })
    expect(blog).not.toHaveProperty('data')
  })

  it('a fresh copy gets `query:` for names alone', async () => {
    w('pages/blog/page.yml', 'title: Blog\nfetch:\n  query: articles\n')
    const doc = await siteProjectToDocument(ROOT)
    const fresh = mkdtempSync(join(tmpdir(), 'query-shorthand-fresh-'))
    try {
      mkdirSync(join(fresh, 'pages'), { recursive: true })
      siteContentDocumentToProject({ document: doc, siteRoot: fresh })
      expect(yamlOf(join(fresh, 'pages/blog/page.yml'))).toMatchObject({ query: 'articles' })
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('a new section file gets `query:`; a section that declares its data locally keeps it', () => {
    const record = { type: 'Grid', content: null, fetch: { query: 'team', path: '/data/team.json', as: 'team', prerender: true, merge: false } }
    const fresh = join(ROOT, 'fresh.md')
    sectionRecordToFile({ filePath: fresh, record })
    expect(frontmatterOf(fresh)).toMatchObject({ type: 'Grid', query: 'team' })
    expect(frontmatterOf(fresh)).not.toHaveProperty('fetch')

    const local = join(ROOT, 'local.md')
    writeFileSync(local, '---\ntype: Grid\nfetch:\n  query: team\n  limit: 3\n---\n# Local\n')
    sectionRecordToFile({ filePath: local, record })
    expect(frontmatterOf(local).fetch).toEqual({ query: 'team', limit: 3 })
    expect(frontmatterOf(local)).not.toHaveProperty('query')
  })
})
