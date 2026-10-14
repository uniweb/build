/**
 * What a page leaves out of a document is said at build, naming the file.
 *
 * A link to `javascript:`, an inert `{.name}` — the renderer leaves them out of
 * the page, and a backend that cleans the content it stores removes them, so the
 * next pull would write the file without them. The author hears it from the
 * build first.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

async function warningsOf() {
  const saved = [console.log, console.warn]
  const warned = []
  console.log = () => {}
  console.warn = (message) => warned.push(String(message))
  try {
    await collectSiteContent(ROOT, { strict: false })
  } finally {
    ;[console.log, console.warn] = saved
  }
  return warned
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'vocabulary-warnings-'))
  w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the build names what a page leaves out', () => {
  it('a link that is never followed, and a name that is not a style', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\n---\n# Hi\n\nGo [here](javascript:alert(1)) and [this]{.lead}.\n')
    const warned = (await warningsOf()).filter((m) => m.includes('a page leaves it out'))
    expect(warned).toEqual([
      expect.stringMatching(/^\[content-collector\] pages\/home\/1-hero\.md: a link to `javascript:alert\(1\)` is never followed/),
      expect.stringMatching(/^\[content-collector\] pages\/home\/1-hero\.md: `\{\.lead\}` is not a style name/),
    ])
  })

  it('CONTROL — ordinary content says nothing', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\n---\n# Hi\n\nGo [here](/about){target=_blank} and [this]{accent}.\n')
    expect((await warningsOf()).filter((m) => m.includes('a page leaves it out'))).toEqual([])
  })
})
