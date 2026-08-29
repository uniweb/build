import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument } from '../src/uwx/index.js'

// What the sync wire carries for a page's `data:` / `fetch:` declaration.
//
// The author's `query:` shorthand is build-time sugar over a path, and for
// a long time that is all that crossed: the producer resolved it and sent the
// resolved path. A resolved path names one place and closes the question — so a
// host able to serve those records live had no way to say so, and the site had
// no way to ask.
//
// The wire carries BOTH: the query name (`query`) for a consumer that can
// resolve it against a host's declared lane, and the compiled artifact (`path`)
// for one that cannot, or has not learned to yet.

let ROOT

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const buildSite = async () => {
  w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
  w('pages/blog/page.yml', 'title: Blog\ndata: articles\n')
  w('pages/blog/list.md', '---\ntype: List\n---\n\n# Blog\n')
  const doc = await siteProjectToDocument(ROOT)
  const blog = doc.pages.find((p) => p.title === 'Blog' || p.$id?.includes('blog'))
  return blog
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-fetch-decl-'))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a page fetch declaration on the sync wire', () => {
  it('carries the query name, unresolved', async () => {
    const blog = await buildSite()
    expect(blog.fetch.query).toBe('articles')
    // ⛔ and never the retired name. `fetch` is a blob the backend carries, not one
    // it models — framework already ships `transform`/`detailPage`/`merge` inside
    // it — so there was never a second spelling to keep in step.
    expect(blog.fetch.collection).toBeUndefined()
  })

  it('carries the compiled artifact path alongside it', async () => {
    // Not redundant: it is the answer when no host declares a lane, and it is
    // what a consumer still reading `fetch.path` receives.
    const blog = await buildSite()
    expect(blog.fetch.path).toBe('/data/articles.json')
  })

  it('carries the schema, which keys content.data and the cache', async () => {
    const blog = await buildSite()
    expect(blog.fetch.schema).toBe('articles')
  })

  it('never leaks the build-time shorthand as the only source', async () => {
    // `query:` alone would not resolve at render on a consumer that knows
    // nothing about a lane — the regression this pairing exists to prevent.
    const blog = await buildSite()
    expect(blog.fetch.path || blog.fetch.url).toBeTruthy()
  })
})
