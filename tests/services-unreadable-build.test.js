/**
 * The static build stops on a `services:` entry it cannot read, as the push does
 * (`refuseUnreadableServices`) — beside the retired top-level keys.
 *
 * ⛔ Read as it was, `search: yes` was an address: the site's own search provider at
 * `yes`, which a built site's search would have asked (F14, 2026-10-07).
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — a services entry it cannot read', () => {
  let siteDir

  async function makeSite(siteYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteDir
  }

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('stops the build on `search: yes`, saying to write `true`', async () => {
    const dir = await makeSite('name: S\nservices:\n  search: yes\n')
    await expect(collectSiteContent(dir)).rejects.toThrow(
      /site\.yml: `services\.search` is the text `yes`, not a switch .* Write `search: true` to turn it on/
    )
  })

  it('builds with `search: true`, and carries no address for it', async () => {
    const dir = await makeSite('name: S\nservices:\n  search: true\n  submit: /forms\n')
    const content = await collectSiteContent(dir)
    expect(content.config.search).toBeUndefined()
    expect(content.config.submit).toBe('/forms')
  })
})
