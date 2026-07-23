/**
 * Publish filter for per-locale readiness — `publishLanguages` (contract:
 * kb/framework/build/uwx-format.md → "Per-locale publish readiness").
 *
 * On published build paths (`dropUnpublished: true`) the embedded
 * `config.languages` is the publishable intersection and invalid publish
 * configs hard-error. Dev keeps the full declared set (draft locales stay
 * previewable, like `hidden` pages). `publishLanguages` itself never ships
 * in the payload — it has no runtime consumer.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — publishLanguages filter', () => {
  let siteDir

  async function makeSite(siteYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-publang-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteDir
  }

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('publish build embeds only the publishable intersection', async () => {
    const dir = await makeSite(
      'name: Test\nlanguages: [en, fr, de]\npublishLanguages: [en, fr]\n'
    )

    const content = await collectSiteContent(dir, { dropUnpublished: true })

    expect(content.config.languages).toEqual(['en', 'fr'])
    expect(content.config).not.toHaveProperty('publishLanguages')
  })

  it('dev build keeps the full declared set (drafts previewable)', async () => {
    const dir = await makeSite(
      'name: Test\nlanguages: [en, fr, de]\npublishLanguages: [en]\n'
    )

    const content = await collectSiteContent(dir)

    expect(content.config.languages).toEqual(['en', 'fr', 'de'])
    // the list itself still never ships in a payload
    expect(content.config).not.toHaveProperty('publishLanguages')
  })

  it('absent publishLanguages = all declared publishable (back-compat)', async () => {
    const dir = await makeSite('name: Test\nlanguages: [en, fr]\n')

    const content = await collectSiteContent(dir, { dropUnpublished: true })

    expect(content.config.languages).toEqual(['en', 'fr'])
  })

  it('dangling publish codes never leak into the embedded list', async () => {
    const dir = await makeSite(
      'name: Test\nlanguages: [en]\npublishLanguages: [en, fr]\n'
    )

    const content = await collectSiteContent(dir, { dropUnpublished: true })

    expect(content.config.languages).toEqual(['en'])
  })

  it('publish build hard-errors on nothing-publishable', async () => {
    const dir = await makeSite('name: Test\nlanguages: [en, fr]\npublishLanguages: []\n')

    await expect(collectSiteContent(dir, { dropUnpublished: true })).rejects.toThrow(
      /invalid language configuration/
    )
  })

  it('publish build hard-errors when the default language is not publishable', async () => {
    const dir = await makeSite(
      'name: Test\ndefaultLanguage: en\nlanguages: [en, fr]\npublishLanguages: [fr]\n'
    )

    await expect(collectSiteContent(dir, { dropUnpublished: true })).rejects.toThrow(
      /default language/
    )
  })

  it('dev build only warns on an invalid publish config', async () => {
    const dir = await makeSite('name: Test\nlanguages: [en, fr]\npublishLanguages: []\n')

    const content = await collectSiteContent(dir)

    expect(content.config.languages).toEqual(['en', 'fr'])
  })

  it('embedded defaultLanguage stays the resolved effective default', async () => {
    const dir = await makeSite(
      'name: Test\nlanguages: [fr, en]\npublishLanguages: [fr, en]\n'
    )

    const content = await collectSiteContent(dir, { dropUnpublished: true })

    expect(content.config.defaultLanguage).toBe('fr')
  })
})
