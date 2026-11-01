/**
 * A folder beside a mounted route's local stub is never read, because the route's pages come from
 * the mount. The author's page simply isn't there, so the build says so.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT, warn
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mount-local-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  w('site/site.yml', 'name: T\nfoundation: f\nindex: home\npaths:\n  pages/docs: ../mount\n')
  w('site/pages/home/1-body.md', '# Home\n')
  w('mount/one.md', '# One\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const said = () => warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('is not read'))

describe('a local folder under a mounted route', () => {
  it('is named, and its page does not appear', async () => {
    w('site/pages/docs/folder.yml', 'title: Docs\n')
    w('site/pages/docs/extra/1-body.md', '# Extra\n')
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    expect(pages.map((p) => p.route)).not.toContain('/docs/extra')
    expect(said()).toHaveLength(1)
    expect(said()[0]).toContain('pages/docs/extra/')
  })

  it('says nothing of a stub alone', async () => {
    w('site/pages/docs/folder.yml', 'title: Docs\n')
    await collectSiteContent(join(ROOT, 'site'))
    expect(said()).toEqual([])
  })

  it('keeps the mounted pages separate under a page.yml stub, and its markdown a page above them', async () => {
    w('site/pages/docs/page.yml', 'title: Docs\n')
    w('site/pages/docs/1-landing.md', '# Landing\n')
    const { pages } = await collectSiteContent(join(ROOT, 'site'))
    const docs = pages.find((p) => p.route === '/docs')
    expect(docs.hasContent).not.toBe(false)
    expect(pages.map((p) => p.route)).toContain('/docs/one')
  })
})
