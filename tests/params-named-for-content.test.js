/**
 * A section's frontmatter naming a param like a field of its content — `title:`, `items:` — that its
 * section type declares no param of is told, at build (and in dev, which collects the same way) and
 * on a push: since 2026-11-11 a param reaches the component as a param only, so a `title:` there
 * never titles the section. A note, never a failure. A param the type declares is the developer's
 * name to choose, and says nothing.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { parseContent } from '@uniweb/semantic-parser'
import { collectSiteContent } from '../src/site/content-collector.js'
import { siteProjectToDocument } from '../src/uwx/index.js'
import { BODY_FIELDS, paramsNamedForContent } from '../src/site/params-named-for-content.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const SCHEMA = {
  _self: { defaultSection: 'Report' },
  Report: { content: { title: 'Report title' }, params: { records: { type: 'select', options: ['invoices', 'sows'] } } },
  Panel: { params: { items: { type: 'number', default: 3 } } },
}

async function notes(run) {
  const saved = [console.log, console.warn]
  const warned = []
  console.log = () => {}
  console.warn = (message) => warned.push(String(message))
  try {
    await run()
  } finally {
    ;[console.log, console.warn] = saved
  }
  return warned.filter((m) => /is a param, and/.test(m))
}
const build = () => notes(() => collectSiteContent(join(ROOT, 'site'), { strict: false }))
const push = () => notes(() => siteProjectToDocument(join(ROOT, 'site')))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'params-named-for-content-'))
  // A foundation beside the site, found by name: its source for the build, its built schema for a push.
  w('foundation/package.json', JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  w('foundation/main.js', "export default { defaultSection: 'Report' }\n")
  w('foundation/sections/Report/meta.js', `export default ${JSON.stringify({ content: SCHEMA.Report.content, params: SCHEMA.Report.params })}\n`)
  w('foundation/sections/Panel/meta.js', `export default ${JSON.stringify({ params: SCHEMA.Panel.params })}\n`)
  w('foundation/dist/meta/schema.json', JSON.stringify(SCHEMA))
  w('site/site.yml', 'name: t\nfoundation: foundation\n')
  w('site/theme.yml', '')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const TITLE_NOTE =
  "`title:` is a param, and Report declares no `title` param, so it doesn't set the section's title " +
  '(`content.title`), which is its heading: write `# Invoices` at the top of the body.'

describe('a param named like a content field its type does not declare', () => {
  it('is told at build, with the file, the type and what to write instead', async () => {
    w('site/pages/home/1-report.md', '---\ntype: Report\ntitle: Invoices\n---\n\nAll invoices.\n')
    expect(await build()).toEqual([`[content-collector] pages/home/1-report.md: ${TITLE_NOTE}`])
  })

  it('is told on a push the same way', async () => {
    w('site/pages/home/1-report.md', '---\ntype: Report\ntitle: Invoices\n---\n\nAll invoices.\n')
    expect(await push()).toEqual([`[push] pages/home/1-report.md: ${TITLE_NOTE}`])
  })

  it('says how the body gives a subtitle and a pretitle, and where any other field comes from', async () => {
    w('site/pages/home/1-report.md', '---\ntype: Report\nsubtitle: For the year\npretitle: Finance\nlinks: false\n---\n')
    expect(await build()).toEqual([
      "[content-collector] pages/home/1-report.md: `subtitle:` is a param, and Report declares no `subtitle` param, so it doesn't set the section's subtitle (`content.subtitle`), which is a heading straight after the title, one level smaller: `## For the year`.",
      "[content-collector] pages/home/1-report.md: `pretitle:` is a param, and Report declares no `pretitle` param, so it doesn't set the section's pretitle (`content.pretitle`), which is the label line above the title: `#> Finance`.",
      "[content-collector] pages/home/1-report.md: `links:` is a param, and Report declares no `links` param, so it doesn't set the section's `content.links`, which comes from the body.",
    ])
  })

  it('a section with no type is its foundation’s default section type', async () => {
    w('site/pages/home/1-report.md', '---\ntitle: Invoices\n---\n')
    expect(await build()).toEqual([`[content-collector] pages/home/1-report.md: ${TITLE_NOTE}`])
  })

  it('is said once per file and key in a process — dev collects again on every edit', async () => {
    w('site/pages/home/1-report.md', '---\ntype: Report\ntitle: Invoices\n---\n')
    expect(await build()).toHaveLength(1)
    expect(await build()).toEqual([])
    expect(await push()).toEqual([])
  })

  it('CONTROL — a param the type declares says nothing, even one named like a content field', async () => {
    w('site/pages/home/1-panel.md', '---\ntype: Panel\nitems: 2\n---\n\n### One\n\n### Two\n')
    expect(await build()).toEqual([])
    expect(await push()).toEqual([])
  })

  it('CONTROL — a type the foundation does not have, and a key that is no content field, say nothing', async () => {
    w('site/pages/home/1-other.md', '---\ntype: Elsewhere\ntitle: Invoices\n---\n')
    w('site/pages/home/2-report.md', '---\ntype: Report\nrecords: sows\nvariant: dark\n---\n')
    expect(await build()).toEqual([])
  })
})

describe('paramsNamedForContent', () => {
  it('reads the type, else the default section type, and says nothing with no schema at hand', () => {
    expect(paramsNamedForContent({ title: 'x' }, 'Report', SCHEMA)).toEqual([{ key: 'title', type: 'Report' }])
    expect(paramsNamedForContent({ title: 'x' }, null, SCHEMA)).toEqual([{ key: 'title', type: 'Report' }])
    expect(paramsNamedForContent({ title: 'x' }, 'Report', null)).toEqual([])
    expect(paramsNamedForContent({ items: 2 }, 'Panel', SCHEMA)).toEqual([])
  })
})

describe('BODY_FIELDS', () => {
  it('is every field the content parser gives a section from its body, less raw and data', () => {
    const body = [
      '#> Eyebrow', '# Title', '## Subtitle', 'Text with [a link](/a).', '[Alone](/b)', '![](lu-house)', '![Photo](a.jpg)',
      '![Doc](a.pdf)', '- one\n- two', '> Quote', '```js\nlet a\n```', '| a | b |\n|---|---|\n| 1 | 2 |', '$$\nx^2\n$$',
      '### Item', 'Item text.',
    ].join('\n\n')
    const fields = Object.keys(parseContent(markdownToProseMirror(body))).filter((key) => key !== 'raw' && key !== 'data')
    expect([...fields].sort()).toEqual([...BODY_FIELDS].sort())
  })
})
