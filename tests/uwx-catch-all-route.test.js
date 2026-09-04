/**
 * The `[...path]` route folder on the sync wire — one fixed spelling, ruled
 * 2026-09-04 [Diego] — and back.
 *
 * The producer sends the page's `slug` as the marker itself (`...path`) and
 * `param_name: slug`, because the record is delivered by its handle, the LAST
 * segment of the capture, exactly as under `[slug]`. The pull writer restores
 * the one spelling from that pair, never `[slug]`. ⚠️ What a consumer's
 * projector emits as the page ROUTE for such a page is that consumer's;
 * framework's own build emits `/…/:path*`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument } from '../src/uwx/index.js'
import { pageDirName } from '../src/uwx/site-project.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'uwx-catch-all-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a [...path] template page on the sync wire', () => {
  it('rides as slug `...path` with param_name `slug`', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/blog/page.yml', 'title: Blog\ndata: articles\n')
    w('pages/blog/list.md', '---\ntype: List\n---\n\n# Blog\n')
    w('pages/blog/[...path]/page.yml', 'title: Article\n')
    w('pages/blog/[...path]/article.md', '---\ntype: Article\n---\n')
    const doc = await siteProjectToDocument(ROOT)
    const blog = doc.pages.find((p) => p.title?.en === 'Blog' || p.title === 'Blog')
    const template = (blog?.$children || []).find((p) => p.is_dynamic)
    expect(template).toBeDefined()
    expect(template.slug).toEqual({ en: '...path' })
    expect(template.param_name).toBe('slug')
  })

  it('CONTROL — a [slug] page still rides under the folder\'s own label', async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\n')
    w('pages/blog/page.yml', 'title: Blog\ndata: articles\n')
    w('pages/blog/[postId]/page.yml', 'title: Article\n')
    w('pages/blog/[postId]/article.md', '---\ntype: Article\n---\n')
    const doc = await siteProjectToDocument(ROOT)
    const blog = doc.pages.find((p) => p.title?.en === 'Blog' || p.title === 'Blog')
    const template = (blog?.$children || []).find((p) => p.is_dynamic)
    expect(template.slug).toEqual({ en: 'postId' })
    expect(template.param_name).toBe('postId')
  })
})

describe('the pull writer restores the one spelling', () => {
  it('[...path] from slug `...path`, whatever param_name says', () => {
    expect(pageDirName({ slug: { en: '...path' }, is_dynamic: true, param_name: 'slug' }, 'en')).toBe('[...path]')
  })

  it('CONTROL — [param] from param_name, and a static slug as itself', () => {
    expect(pageDirName({ slug: { en: 'slug' }, is_dynamic: true, param_name: 'postId' }, 'en')).toBe('[postId]')
    expect(pageDirName({ slug: { en: 'about' } }, 'en')).toBe('about')
  })
})
