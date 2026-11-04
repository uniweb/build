/**
 * ⭐ A PAGE FOLDER'S NUMBER ORDERS IT AND NEVER NAMES IT: `pages/2-about/` is `/about`, on every lane,
 * as `guide/1-install.md` is `/guide/install` [Diego, 2026-11-04: "The build should drop the number
 * too"]. ⛔ Until then a build served `2-about/` at `/2-about` while a push sent it as `about`, so a
 * site published two ways had two addresses for one page.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'
import { buildRouteOf } from '../src/uwx/site.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const site = () => join(ROOT, 'site')
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'numbered-folders-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})
const quietly = async (fn) => {
  const warned = []
  vi.spyOn(console, 'warn').mockImplementation((m) => warned.push(String(m)))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const value = await fn()
  return { value, warned }
}
const built = async () => (await quietly(() => collectSiteContent(site(), {}))).value.pages.map((p) => p.route)
// The routes a push sends: each page of the document, by the build's rule for its route.
async function pushed() {
  const doc = (await quietly(() => siteProjectToDocument(site()))).value
  const out = []
  const walk = (records, parent) => {
    for (const r of records || []) {
      const route = buildRouteOf(r, parent, 'en')
      out.push(route)
      walk(r.$children, route)
    }
  }
  walk(doc.pages, '/')
  return out
}

function numbered(siteYml = 'index: home\n') {
  w('site/site.yml', `name: S\nfoundation: "@acme/base@1.0.0"\n${siteYml}`)
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/pages/home/hero.md', '# Hi\n')
  w('site/pages/10-contact/page.yml', 'title: Contact\n')
  w('site/pages/10-contact/form.md', '# Write\n')
  w('site/pages/2-about/page.yml', 'title: About\n')
  w('site/pages/2-about/1-story.md', '# Story\n')
  w('site/pages/2-about/3-team/page.yml', 'title: Team\n')
  w('site/pages/2-about/3-team/people.md', '# People\n')
  w('site/pages/1-guide/folder.yml', 'title: Guide\n')
  w('site/pages/1-guide/2-use.md', '# Use\n')
  w('site/pages/1-guide/1-install.md', '# Install\n')
  w('site/pages/1-guide/3-more/folder.yml', 'title: More\n')
  w('site/pages/1-guide/3-more/tips.md', '# Tips\n')
  w('site/pages/404/page.yml', 'title: Not found\n')
  w('site/pages/404/body.md', '# Not here\n')
}

describe('⭐ a page folder\'s number orders it and never names it', () => {
  it('the build gives each the route the push sends', async () => {
    numbered()
    const routes = await built()
    expect(routes).toEqual(expect.arrayContaining(['/about', '/about/team', '/contact', '/guide', '/guide/install', '/guide/use', '/guide/more', '/guide/more/tips']))
    expect(routes.some((r) => /\/\d+-/.test(r))).toBe(false)
    expect(new Set(routes.filter((r) => r !== '/404'))).toEqual(new Set((await pushed()).filter((r) => r !== '/404')))
  })

  it('a level is ordered by its numbers, then the rest by name: 2 before 10', async () => {
    numbered()
    const top = (await built()).filter((r) => r.split('/').length === 2 && r !== '/404')
    expect(top).toEqual(['/guide', '/about', '/contact', '/'])
  })

  it('a folder-mode level orders its numbered folders and `.md` pages together', async () => {
    numbered()
    expect((await built()).filter((r) => r.startsWith('/guide/'))).toEqual(['/guide/install', '/guide/use', '/guide/more', '/guide/more/tips'])
  })

  it('`index:` names a page as its route does', async () => {
    numbered('index: about\n')
    const { value } = await quietly(() => collectSiteContent(site(), {}))
    const home = value.pages.find((p) => p.route === '/')
    expect(home.title).toBe('About')
    expect(value.pages.map((p) => p.route)).not.toContain('/about')
  })

  it('`pages:` does too — and a list naming one by its number is told so', async () => {
    numbered('index: home\npages:\n  - home\n  - contact\n  - about\n  - 2-about\n  - ...\n')
    const { value, warned } = await quietly(() => collectSiteContent(site(), {}))
    const top = value.pages.map((p) => p.route).filter((r) => r.split('/').length === 2 && r !== '/404')
    expect(top).toEqual(['/', '/contact', '/about', '/guide'])
    expect(warned.join('\n')).toMatch(/the page order lists "2-about", and no page is called that: its name has no number, "about"/)
  })

  it('with no `index:`, the homepage is the page that comes first: a numbered folder before the rest', async () => {
    w('site/site.yml', 'name: S\n')
    w('site/pages/about/page.yml', 'title: About\n')
    w('site/pages/about/body.md', '# About\n')
    w('site/pages/2-contact/page.yml', 'title: Contact\n')
    w('site/pages/2-contact/body.md', '# Contact\n')
    const { value } = await quietly(() => collectSiteContent(site(), {}))
    expect(value.pages.map((p) => [p.route, p.title])).toEqual([['/', 'Contact'], ['/about', 'About']])
  })

  it('CONTROL — a folder that is only a number keeps it: `404` is the not-found page', async () => {
    numbered()
    const { value } = await quietly(() => collectSiteContent(site(), {}))
    expect(value.notFound?.route ?? value.pages.find((p) => p.route === '/404')?.route).toBe('/404')
  })
})
