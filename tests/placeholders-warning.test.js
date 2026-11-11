/**
 * The `placeholders:` warning speaks only when a page writes a placeholder that nothing resolves.
 *
 * A site's placeholders are values set once for the whole site. Content refers to them as `{name}`,
 * which only a foundation's content handler (normally @uniweb/loom) resolves, and a foundation's
 * components may read them themselves (`website.config.placeholders.currency`). So the build warns
 * when a page writes `{name}` under a foundation with no content handler, the page printing the
 * braces. ⛔ Until 2026-11-11 it warned on any `placeholders:` under such a foundation, telling a
 * site whose components read the value that its pages would print `{name}`, when none did.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — the placeholders: warning', () => {
  let siteDir
  let warn

  async function makeSite(siteYml, body) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), `---\ntype: Hero\n---\n\n# Hi\n\n${body}\n`)
    return siteDir
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  const said = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('placeholders:'))

  it('says nothing when no page writes one — a foundation may read it as a site value', async () => {
    const dir = await makeSite('name: Salon\nplaceholders:\n  currency: EUR\n', 'Prices in euros.')
    const content = await collectSiteContent(dir)
    expect(content.config.placeholders).toEqual({ currency: 'EUR' })
    expect(said()).toEqual([])
  })

  it('names each one a page writes, when no content handler resolves it', async () => {
    const dir = await makeSite(
      'name: Shop\nplaceholders:\n  product: Uniweb\n  vendor:\n    email: billing@acme.example\n',
      'Write to {vendor.email} about { product }.'
    )
    await collectSiteContent(dir)
    const [line, ...rest] = said()
    expect(rest).toEqual([])
    expect(line).toMatch(/`\{vendor\}`/)
    expect(line).toMatch(/`\{product\}`/)
    expect(line).toMatch(/render the braces as text/)
  })

  it('CONTROL — braces around another word are not a placeholder', async () => {
    const dir = await makeSite('name: Shop\nplaceholders:\n  product: Uniweb\n', 'A set {a, b} and {products}.')
    await collectSiteContent(dir)
    expect(said()).toEqual([])
  })
})
