/**
 * A section's file asking for a placement its section type does not honour is
 * told so at build — and in dev, which collects the same way — naming the file
 * and the type. A warning, never a failure: the block sits in the text column.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { warnPlacementsNotOffered } from '../src/site/placement-warnings.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const TABLE = '| Plan | Price |\n| ---- | ----- |\n| Basic | $10 |\n'

async function placementWarnings() {
  const saved = [console.log, console.warn]
  const warned = []
  console.log = () => {}
  console.warn = (message) => warned.push(String(message))
  try {
    await collectSiteContent(join(ROOT, 'site'), { strict: false })
  } finally {
    ;[console.log, console.warn] = saved
  }
  return warned.filter((m) => /placement/.test(m))
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'placement-warnings-'))
  // A foundation beside the site, found by name, as `foundationSections` finds one.
  w('foundation/package.json', JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  w('foundation/main.js', 'export default {}\n')
  w('foundation/sections/Article/meta.js', "export default { content: { sequence: { label: 'The article', placement: ['wide', 'left', 'right'] } } }\n")
  w('foundation/sections/Hero/meta.js', "export default { content: { title: 'Headline', image: 'Photo' } }\n")
  w('foundation/sections/Legacy/meta.js', "export default { title: 'Legacy' }\n")
  w('site/site.yml', 'name: t\nfoundation: foundation\n')
  w('site/theme.yml', '')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the build says when content asks for a placement its section type does not offer', () => {
  it('names the file, the block, what it asks and what the type offers', async () => {
    w(
      'site/pages/home/1-article.md',
      `---\ntype: Article\n---\n# Title\n\n![A](a.jpg){placement=wide}\n\n![B](b.jpg){placement=full}\n\n${TABLE}\n: Plans {placement=full}\n\n![](lu-house){placement=left}\n`,
    )
    expect(await placementWarnings()).toEqual([
      '[content-collector] pages/home/1-article.md: an image asks for `placement=full`, which Article does not offer (it offers left, right, wide) — it sits in the text column',
      '[content-collector] pages/home/1-article.md: a table asks for `placement=full`, which Article does not offer (it offers left, right, wide) — it sits in the text column',
      '[content-collector] pages/home/1-article.md: an icon takes no placement, so `placement=left` does nothing',
    ])
  })

  it('a type whose content has no sequence offers none', async () => {
    w('site/pages/home/1-hero.md', '---\ntype: Hero\n---\n# Hi\n\n![A](a.jpg){placement=wide}\n')
    expect(await placementWarnings()).toEqual([
      '[content-collector] pages/home/1-hero.md: an image asks for `placement=wide`, which Hero does not offer — it sits in the text column',
    ])
  })

  it('a type that says nothing about its content is unknown, and nothing is said', async () => {
    w('site/pages/home/1-legacy.md', '---\ntype: Legacy\n---\n# Hi\n\n![A](a.jpg){placement=wide}\n')
    expect(await placementWarnings()).toEqual([])
  })

  it('CONTROL — every placement the type offers says nothing', async () => {
    w('site/pages/home/1-article.md', `---\ntype: Article\n---\n# T\n\n![A](a.jpg){placement=left}\n\n${TABLE}\n: Plans {placement=wide #tbl-p}\n`)
    expect(await placementWarnings()).toEqual([])
  })
})

describe('warnPlacementsNotOffered', () => {
  const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: '/a.jpg', placement: 'wide' } }] }
  const run = (type, sectionTypes) => {
    const out = []
    warnPlacementsNotOffered(doc, type, sectionTypes, (m) => out.push(m))
    return out
  }

  it("a section with no type is checked against the foundation's defaultSection", () => {
    const types = { _self: { defaultSection: 'Plain' }, Plain: { content: [{ element: 'title', kind: 'heading' }] } }
    expect(run(null, types)).toEqual(['an image asks for `placement=wide`, which Plain does not offer — it sits in the text column'])
  })

  it('nothing at hand — no foundation, an unknown type — says nothing', () => {
    expect(run('Article', null)).toEqual([])
    expect(run('Missing', { Article: {} })).toEqual([])
    expect(run(null, {})).toEqual([])
  })
})
