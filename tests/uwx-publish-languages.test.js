// publish_languages on the sync wire — verbatim carry both ways (contract:
// kb/framework/build/uwx-format.md → "Per-locale publish readiness").
//
// Sync push/pull round-trips the FULL working set plus the publish list —
// dangling codes included (a code listed in publishLanguages but not declared
// in languages preserves that locale's publish intent for a later re-add).
// Only *publish* filters; the wire never does.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteInfoToConfig } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-publang-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeSite(siteYml) {
  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'site.yml'), siteYml)
  return src
}

describe('publish_languages — push carry', () => {
  it('carries site.yml publishLanguages verbatim, dangling codes included', async () => {
    const src = makeSite(
      "name: T\nfoundation: '@acme/base@1.0.0'\nlanguages: [en, fr]\ndefaultLanguage: en\npublishLanguages: [en, fr, es]\n"
    )

    const document = await siteProjectToDocument(src)

    // 'es' is dangling (not declared) — carried anyway; the wire never prunes.
    expect(document.info.publish_languages).toEqual(['en', 'fr', 'es'])
    expect(document.info.languages).toEqual(['en', 'fr'])
  })

  it('absent publishLanguages stays absent on the wire (= all declared publishable)', async () => {
    const src = makeSite(
      "name: T\nfoundation: '@acme/base@1.0.0'\nlanguages: [en, fr]\n"
    )

    const document = await siteProjectToDocument(src)

    expect(document.info).not.toHaveProperty('publish_languages')
  })

  it('push hard-errors on nothing-publishable', async () => {
    const src = makeSite(
      "name: T\nfoundation: '@acme/base@1.0.0'\nlanguages: [en, fr]\npublishLanguages: []\n"
    )

    await expect(siteProjectToDocument(src)).rejects.toThrow(/invalid language configuration/)
  })

  it('push hard-errors when the default language is not publishable', async () => {
    const src = makeSite(
      "name: T\nfoundation: '@acme/base@1.0.0'\nlanguages: [en, fr]\ndefaultLanguage: en\npublishLanguages: [fr]\n"
    )

    await expect(siteProjectToDocument(src)).rejects.toThrow(/default language/)
  })
})

describe('publish_languages — pull write-back', () => {
  it('projects info.publish_languages to site.yml publishLanguages', () => {
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })

    siteInfoToConfig({
      document: {
        info: {
          name: 'T',
          foundation: '@acme/base@1.0.0',
          languages: ['en', 'fr'],
          publish_languages: ['en', 'es'],
        },
      },
      siteRoot: dest,
    })

    const siteYml = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(siteYml.publishLanguages).toEqual(['en', 'es']) // dangling 'es' preserved
    expect(siteYml).not.toHaveProperty('publish_languages')
  })

  it('an absent wire field leaves site.yml untouched', () => {
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'site.yml'), 'name: T\npublishLanguages: [en]\n')

    siteInfoToConfig({
      document: { info: { name: 'T', foundation: '@acme/base@1.0.0' } },
      siteRoot: dest,
    })

    const siteYml = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(siteYml.publishLanguages).toEqual(['en'])
  })
})

describe('publish_languages — full round-trip', () => {
  it('push → pull is a fixed point, dangling codes surviving both directions', async () => {
    const src = makeSite(
      "name: RT\nfoundation: '@acme/base@1.0.0'\nlanguages: [en, fr]\ndefaultLanguage: en\npublishLanguages: [en, fr, es]\n"
    )

    const document = await siteProjectToDocument(src)

    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })

    const pulled = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(pulled.languages).toEqual(['en', 'fr'])
    expect(pulled.publishLanguages).toEqual(['en', 'fr', 'es'])

    // and pushing the pulled project reproduces the same wire fields
    const document2 = await siteProjectToDocument(dest)
    expect(document2.info.publish_languages).toEqual(document.info.publish_languages)
    expect(document2.info.languages).toEqual(document.info.languages)
  })
})
