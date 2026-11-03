/**
 * A route holds no `?`, `#` or `%` [Diego, 2026-11-02]: a URL reads them as its own, so a page whose
 * route held one answered while every link to it broke. A build and a push refuse each place a
 * route is made: a folder's name, a page file's name, a page's `slug:` and `site.yml`'s
 * `i18n.routeTranslations`. Every other character stays, a `:` and an accent included.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quietly = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn] = saved
  }
}
const collect = () => quietly(() => collectSiteContent(ROOT, { strict: false }))
const push = () => quietly(() => siteProjectToDocument(ROOT))
const SAYS = /and a route can't hold `\?`, `#` or `%`: a URL reads them as its own, so every link to the page would break/

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'route-characters-'))
  w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\nlanguages: [en, fr]\n')
  w('pages/home/home.md', '---\ntype: Hero\n---\n# Home\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe.each([
  ['a build', collect],
  ['a push', push],
])('%s refuses', (_, run) => {
  it.each(['What-is-this?', 'C#-guide', '100%-Guide'])('a folder named `%s`', async (name) => {
    w(`pages/${name}/page.md`, '---\ntype: Text\n---\n# x\n')
    await expect(run()).rejects.toThrow(SAYS)
    await expect(run()).rejects.toThrow(`a folder named \`${name}\` holds`)
  })

  it('a page file named with one, in a folder whose files are pages', async () => {
    w('pages/docs/folder.yml', 'title: Docs\n')
    w('pages/docs/faq?.md', '# FAQ\n')
    await expect(run()).rejects.toThrow('a page file named `faq?.md` holds `?`')
  })

  // `team` sorts after `home`, so `home` stays the homepage and `team` keeps its own route.
  it("a page's `slug:` in another language", async () => {
    w('pages/team/page.yml', 'title: Team\nslug:\n  fr: qui?\n')
    w('pages/team/team.md', '---\ntype: Text\n---\n# Team\n')
    await expect(run()).rejects.toThrow('`slug.fr` of the page at /team, `qui?`, holds `?`')
  })

  it("a route in `site.yml`'s `i18n.routeTranslations`", async () => {
    w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\nlanguages: [en, fr]\ni18n:\n  routeTranslations:\n    fr:\n      /team: /equipe#haut\n')
    w('pages/team/team.md', '---\ntype: Text\n---\n# Team\n')
    await expect(run()).rejects.toThrow("`site.yml`'s `i18n.routeTranslations.fr` gives /team the route `/equipe#haut`, which holds `#`")
  })

  it('CONTROL — an accent, `,`, `&`, `\'` and a `:` are text, and pass', async () => {
    for (const name of ["À-propos-d'Uniweb", 'Analytics,-Testing,-and-Growth', 'Equipment-&-Resources', 'Note:-a-thing']) {
      w(`pages/${name}/page.md`, '---\ntype: Text\n---\n# x\n')
    }
    w('pages/about/page.yml', 'title: About\nslug:\n  fr: à-propos\n')
    w('pages/about/about.md', '---\ntype: Text\n---\n# About\n')
    await expect(run()).resolves.toBeDefined()
  })
})

it('a build keeps the `:` page as a page, not a pattern', async () => {
  w('pages/Note:-a-thing/page.md', '---\ntype: Text\n---\n# Note\n')
  const content = await collect()
  expect(content.pages.find((p) => p.route === '/Note:-a-thing')).toMatchObject({ isDynamic: false })
})
