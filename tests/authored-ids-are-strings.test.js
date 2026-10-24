/**
 * An id an author wrote is a string, whatever YAML reads it as (`authoredId`).
 *
 * ⛔ Until 2026-10-24 `id: 404` in a page.yml stayed the number 404: it matched no `page:404` link
 * on a built site, and a push sent it as the page's `stable_id`, which a backend refused (measured
 * that day, HTTP 400: "item.data.stable_id must be a string").
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authoredId, collectSiteContent, processMarkdownFile } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT, SITE
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'authored-ids-'))
  SITE = join(ROOT, 'site')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

function makeSite() {
  w('site/site.yml', 'name: T\nfoundation: fnd\nindex: home\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/page.yml', 'id: home\n')
  w('site/pages/home/1-hero.md', '---\ntype: Hero\nid: 7\n---\n\n# Home\n')
  w('site/pages/404/page.yml', 'id: 404\ntitle: Not found\n')
  w('site/pages/404/1-body.md', '# Not found\n')
  w('site/pages/archive/page.yml', 'id: 2026\n')
  w('site/pages/archive/1-body.md', '# Archive\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
}

describe('authoredId', () => {
  it('names the string an author wrote', () => {
    expect(authoredId(404)).toBe('404')
    expect(authoredId('home')).toBe('home')
    expect(authoredId(0)).toBe('0')
    expect(authoredId(undefined)).toBeNull()
    expect(authoredId(null)).toBeNull()
    expect(authoredId('')).toBeNull()
  })
})

describe('an id YAML reads as a number', () => {
  it("is a string on a built site's page and section", async () => {
    makeSite()
    const content = await collectSiteContent(SITE)
    expect(content.pages.find((p) => p.route === '/archive').id).toBe('2026')
    // The not-found page is kept beside the pages, under its own key.
    expect(content.notFound.id).toBe('404')
    const { section } = await processMarkdownFile(join(SITE, 'pages/home/1-hero.md'), '0', SITE)
    expect(section.stableId).toBe('7')
  })

  it("is a string in a push's page and section records", async () => {
    makeSite()
    const doc = await siteProjectToDocument(SITE)
    const notFound = doc.pages.find((p) => p.slug?.en === '404')
    expect(notFound.stable_id).toBe('404')
    expect(notFound.$id).toBe('404')
    const hero = doc.pages.find((p) => p.slug?.en === 'home').page_sections.find((s) => s.type === 'Hero')
    expect(hero.stable_id).toBe('7')
    expect(hero.$id).toBe('7')
  })
})
