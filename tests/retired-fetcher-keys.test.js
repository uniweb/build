/**
 * The site-level `fetcher:` vocabulary the default fetcher used to read —
 * `baseUrl`, `headers`, `envelope`, `supports`, `request` — was retired on
 * 2026-09-04: a third-party endpoint is a foundation TRANSPORT, and the runtime
 * every site loads carries no client for an author's own backend.
 *
 * What makes the retirement safe rather than silent is HERE: a site still
 * declaring one of those keys is told once, at build time, and the key is
 * dropped from the payload — because the alternative is the failure class this
 * seam exists to remove. A `baseUrl` nothing reads does not error; the author's
 * backend simply stops being reached, and every `where:` evaluates over an
 * empty answer that looks like "no records".
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — the retired fetcher: vocabulary', () => {
  let siteDir
  let warn

  async function makeSite(siteYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
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

  const retiredWarnings = () =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('retired and ignored'))

  it('drops a retired key from the payload and says so', async () => {
    const dir = await makeSite(
      'name: Test\nfetcher:\n  baseUrl: https://api.example.com\n  supports: [where, limit]\n' +
        '  transports:\n    articles: acme\n  acme:\n    apiKey: pk_123\n'
    )
    const content = await collectSiteContent(dir)
    // what stays: the site's SELECTION of transports and a transport's binding config
    expect(content.config.fetcher).toEqual({ transports: { articles: 'acme' }, acme: { apiKey: 'pk_123' } })
    expect(content.config.fetcher).not.toHaveProperty('baseUrl')
    expect(content.config.fetcher).not.toHaveProperty('supports')
    const lines = retiredWarnings()
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines[0]).toContain('`baseUrl`')
    expect(lines[0]).toContain('`supports`')
    expect(lines[0]).toContain('transport')
  })

  it('CONTROL — a fetcher: block that only selects transports passes untouched, silently', async () => {
    const dir = await makeSite('name: Test\nfetcher:\n  transports:\n    articles: acme\n')
    const content = await collectSiteContent(dir)
    expect(content.config.fetcher).toEqual({ transports: { articles: 'acme' } })
    expect(retiredWarnings()).toEqual([])
  })

  it('CONTROL — a site with no fetcher: block carries none', async () => {
    const dir = await makeSite('name: Test\n')
    const content = await collectSiteContent(dir)
    expect(content.config.fetcher).toBeUndefined()
    expect(retiredWarnings()).toEqual([])
  })
})
