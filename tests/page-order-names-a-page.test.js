/**
 * A name in a page order that matches no page is said.
 *
 * It does nothing, and the list reads as if it worked: every page is still there, in file order.
 * `content: [01-welcome, 02-next]` was in four of unipress's starters for that reason, so moving an
 * entry changed nothing and nothing explained why. A file's number isn't part of its name.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT, warn
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'page-order-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

function document(content) {
  writeFileSync(join(ROOT, 'document.yml'), `name: T\ncontent:\n${content.map((c) => `  - ${c}`).join('\n')}\n`)
  mkdirSync(join(ROOT, 'content'), { recursive: true })
  writeFileSync(join(ROOT, 'content/01-welcome.md'), '# Welcome\n')
  writeFileSync(join(ROOT, 'content/02-next.md'), '# Next\n')
  return collectSiteContent(ROOT, { configFile: 'document.yml', profile: 'document' })
}

const orderWarnings = () =>
  warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('page order'))

describe('a page order', () => {
  it('follows the names it lists, and says nothing', async () => {
    const { pages } = await document(['next', 'welcome'])
    expect(pages.map((p) => p.route)).toEqual(['/', '/welcome'])
    expect(pages[0].title).toBe('Next')
    expect(orderWarnings()).toEqual([])
  })

  it('names an entry that carries the file number, and gives the page its name', async () => {
    await document(['02-next', '01-welcome'])
    const [first, second] = orderWarnings()
    expect(first).toContain('"02-next"')
    expect(first).toContain('"next"')
    expect(second).toContain('"01-welcome"')
    expect(second).toContain('"welcome"')
  })

  it('names an entry that matches nothing at all', async () => {
    await document(['welcome', 'gone'])
    const warnings = orderWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"gone"')
  })

  it('says nothing of a list that leaves room for the rest', async () => {
    await document(['welcome', '...'])
    expect(orderWarnings()).toEqual([])
  })
})
