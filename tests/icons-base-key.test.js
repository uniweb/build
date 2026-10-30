/**
 * The address of a mirror of the icon corpus is `icons.base`. The runtime read `cdnUrl` until
 * 2026-10-30, a name no host sent, and nothing else in any lane read it. A file still writing it is
 * told, because a renamed field goes quiet: its icons would simply come from the default origin.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('site.yml icons:', () => {
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

  it('reaches the payload as `config.icons.base`', async () => {
    const dir = await makeSite('name: Test\nicons:\n  base: https://icons.example.test\n')
    const content = await collectSiteContent(dir)
    expect(content.config.icons).toEqual({ base: 'https://icons.example.test' })
  })

  it('refuses the retired `cdnUrl`, naming the key to write', async () => {
    const dir = await makeSite('name: Test\nicons:\n  cdnUrl: https://icons.example.test\n')
    await expect(collectSiteContent(dir)).rejects.toThrow('`icons.cdnUrl` is now `icons.base`')
  })

  it('leaves a site with no `icons:` alone', async () => {
    const dir = await makeSite('name: Test\n')
    const content = await collectSiteContent(dir)
    expect(content.config.icons).toBeUndefined()
  })
})
