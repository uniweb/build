/**
 * A link written as a file means the page that file became, built or pushed.
 *
 * Docs kept in a repo link by file, because that works on GitHub. Mounted into a site, the link went
 * where a browser takes it: `/docs/b.md`, a "Page not found", with nothing said by a build or doctor.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT, warn
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'file-links-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  w('site/site.yml', 'name: T\nfoundation: fnd\nindex: home\npaths:\n  pages/docs: ../mount\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/1-hero.md', '# Home\n\nSee [a page](../../../mount/02-b.md).\n')
  w('site/pages/about/1-one.md', '# One\n\nOn to [the other](./2-two.md).\n')
  w('site/pages/about/2-two.md', '# Two\n')
  w('mount/folder.yml', 'title: Docs\n')
  w('mount/01-a.md', [
    '# A',
    '',
    '[sibling](./02-b.md)',
    '',
    'A [dive](./sub/c.md) in a sentence, a [heading](./02-b.md#it-doesnt--matter), and [theirs](./02-b.md#it-doesn-t-matter).',
    '',
    '[explicit](./02-b.md#custom), [gone](./gone.md), [no heading](./02-b.md#nope), [readme](./README.md).',
    '',
    '[outside](https://example.com/x.md), [root](/x.md), [hash](#here), [a file](./data.csv)',
    '',
  ].join('\n'))
  w('mount/02-b.md', "# B\n\n## It doesn't — matter\n\n## Named {#custom}\n\n[up](../01-a.md) [back](./01-a.md)\n")
  w('mount/README.md', '# Not a page\n')
  w('mount/sub/c.md', '# C\n\n[back up](../01-a.md)\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

/** Every href in a document, in order. */
function hrefs(node, out = []) {
  for (const mark of node?.marks || []) if (mark.attrs?.href) out.push(mark.attrs.href)
  if (node?.attrs?.href) out.push(node.attrs.href)
  for (const child of node?.content || []) hrefs(child, out)
  return out
}
const said = () => warn.mock.calls.map(([m]) => String(m))

describe('built', () => {
  const pageOf = (pages, route) => pages.find((p) => p.route === route)

  it('leads each to the page its file became', async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    const links = hrefs(pageOf(pages, '/docs/a').sections[0].content)
    expect(links.slice(0, 2)).toEqual(['/docs/b', '/docs/sub/c'])
    expect(hrefs(pageOf(pages, '/docs/sub/c').sections[0].content)).toEqual(['/docs/a'])
  })

  it("translates GitHub's anchor to the heading's, and keeps one already right", async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    const links = hrefs(pageOf(pages, '/docs/a').sections[0].content)
    expect(links[2]).toBe('/docs/b#it-doesn-t-matter')
    expect(links[3]).toBe('/docs/b#it-doesn-t-matter')
    expect(links[4]).toBe('/docs/b#custom')
  })

  it('names one that leads nowhere, and leaves it as written', async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    const links = hrefs(pageOf(pages, '/docs/a').sections[0].content)
    expect(links).toContain('./gone.md')
    expect(links).toContain('./README.md')
    expect(said().some((m) => m.includes('./gone.md') && m.includes('no page'))).toBe(true)
    expect(said().some((m) => m.includes('./README.md') && m.includes('no page'))).toBe(true)
    expect(said().some((m) => m.includes('#nope') && m.includes('no such heading'))).toBe(true)
  })

  it('leaves everything that is not a relative link to a markdown file', async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    const links = hrefs(pageOf(pages, '/docs/a').sections[0].content)
    expect(links).toEqual(expect.arrayContaining(['https://example.com/x.md', '/x.md', '#here', './data.csv']))
  })

  it('finds a page from a file outside the mount', async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    expect(hrefs(pageOf(pages, '/').sections[0].content)).toEqual(['/docs/b'])
  })

  it('leads to a section of a page made of several files', async () => {
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    expect(hrefs(pageOf(pages, '/about').sections[0].content)).toEqual(['/about#section-two'])
  })

  it('puts no file path in what the site carries', async () => {
    const content = await collectSiteContent(join(ROOT, 'site'))
    expect(JSON.stringify(content)).not.toContain(join(ROOT, 'mount/01-a.md'))
  })
})

describe('pushed', () => {
  it('reads the same as built', async () => {
    const document = await siteProjectToDocument(join(ROOT, 'site'))
    const a = document.pages.find((p) => p.$id === 'docs').$children.find((p) => p.$id === 'a')
    const doc = a.page_sections[0].content.en
    expect(hrefs(doc).slice(0, 3)).toEqual(['/docs/b', '/docs/sub/c', '/docs/b#it-doesn-t-matter'])
  })
})
