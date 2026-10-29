/**
 * ⭐ A TRANSLATION'S FILE GOES THROUGH THE IMAGE STEP, AS THE CONTENT'S DOES (2026-10-28).
 *
 * A translation names an image's file in its language (`![La superposition](/docs-media/fr/x.png)`,
 * `image-translation.test.js`), and a language's pages are made after the bundle has processed the
 * site's media, from what it wrote. So a French page showed its capture as `public/` holds it, a
 * PNG, where the English page had the build's WebP. The bundle now collects the files each
 * language's pages name (`collectTranslatedAssets`), for the languages `uniweb build` makes
 * (`localesToBuild`), processes them with the site's own, and leaves where it put each one
 * (`builtAssets`) for the step that makes each language's pages (`buildLocalizedContent`), which
 * points them at the build's copy and takes the note out of the payload.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { collectTranslatedAssets, ASSETS_FOLDER_RETIRED } from '../../src/site/assets.js'
import { localesToBuild } from '../../src/i18n/locales.js'
import { buildLocalizedContent } from '../../src/i18n/index.js'
import { mergeTranslations } from '../../src/i18n/merge.js'
import { computeHash } from '../../src/i18n/hash.js'

const ALT = 'The publishing overlay'
const doc = (md) => markdownToProseMirror(md)
const site = (content, extra = {}) => ({
  config: { defaultLanguage: 'en' },
  pages: [{ route: '/', sections: [{ stableId: 'hero', content }] }],
  ...extra
})

let root
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'translated-media-')))
  mkdirSync(join(root, 'locales'), { recursive: true })
  mkdirSync(join(root, 'public', 'docs-media', 'fr'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

describe('collectTranslatedAssets', () => {
  const english = () => doc(`![${ALT}](/docs-media/en/overlay.png)`)
  const known = { '/docs-media/en/overlay.png': { original: '/docs-media/en/overlay.png' } }

  it("collects the file a translation names, and none the site's own content names", () => {
    const fr = mergeTranslations(site(english()), { [computeHash(ALT)]: '![La superposition](/docs-media/fr/overlay.png)' })
    const { assets, unplaced } = collectTranslatedAssets([{ locale: 'fr', content: fr }], known, root, join(root, 'locales'))
    expect(Object.keys(assets)).toEqual(['/docs-media/fr/overlay.png'])
    expect(assets['/docs-media/fr/overlay.png']).toMatchObject({
      resolved: join(root, 'public', 'docs-media', 'fr', 'overlay.png'),
      isImage: true
    })
    expect(unplaced).toEqual([])
  })

  it('CONTROL — a translation of the words alone names no file', () => {
    const fr = mergeTranslations(site(english()), { [computeHash(ALT)]: 'La superposition' })
    const { assets } = collectTranslatedAssets([{ locale: 'fr', content: fr }], known, root, join(root, 'locales'))
    expect(assets).toEqual({})
  })

  it("walks a video's poster, a layout's areas and a subsection, as the rewrite does", () => {
    const content = site(doc('# Home'), {
      layouts: { default: { footer: { sections: [{ stableId: 'f', content: doc('![Logo](/logo.fr.svg)') }] } } }
    })
    content.pages[0].sections[0].subsections = [{ stableId: 's', content: doc('![Tour](/tour.fr.mp4){poster=/tour.fr.jpg}') }]
    const { assets } = collectTranslatedAssets([{ locale: 'fr', content }], {}, root, join(root, 'locales'))
    expect(Object.keys(assets).sort()).toEqual(['/logo.fr.svg', '/tour.fr.jpg', '/tour.fr.mp4'])
    expect(assets['/tour.fr.mp4'].isVideo).toBe(true)
  })

  it('names, rather than guesses, a relative file: a translation sits in no folder', () => {
    const fr = mergeTranslations(site(english()), { [computeHash(ALT)]: '![La superposition](./overlay.fr.png)' })
    const { assets, unplaced } = collectTranslatedAssets([{ locale: 'fr', content: fr }], known, root, join(root, 'locales'))
    expect(assets).toEqual({})
    expect(unplaced).toEqual([{ locale: 'fr', ref: './overlay.fr.png' }])
  })

  it('refuses a file only the retired assets/ folder holds, naming the translation', () => {
    write('assets/overlay.fr.png', 'png')
    write('locales/fr.json', '{}')
    const fr = mergeTranslations(site(english()), { [computeHash(ALT)]: '![La superposition](/overlay.fr.png)' })
    let error
    try {
      collectTranslatedAssets([{ locale: 'fr', content: fr }], known, root, join(root, 'locales'))
    } catch (err) {
      error = err
    }
    expect(error?.code).toBe(ASSETS_FOLDER_RETIRED)
    expect(error.message).toContain('(in locales/fr.json)')
  })
})

describe('localesToBuild — the languages `uniweb build` makes, and the bundle processes for', () => {
  beforeEach(() => {
    for (const locale of ['es', 'fr']) write(`locales/${locale}.json`, '{}')
  })

  it('an explicit list, without the default', () => {
    expect(localesToBuild({ languages: ['en', 'fr'] }, join(root, 'locales'))).toEqual({
      locales: ['fr'],
      skipped: [],
      defaultLocale: 'en'
    })
  })

  it('every translation file for a wildcard, only those publishLanguages lists', () => {
    expect(localesToBuild({ languages: '*', defaultLanguage: 'en', publishLanguages: ['en', 'fr'] }, join(root, 'locales'))).toEqual({
      locales: ['fr'],
      skipped: ['es'],
      defaultLocale: 'en'
    })
  })
})

describe("buildLocalizedContent takes the build's copy", () => {
  const HASH = computeHash(ALT)
  const built = (extra = {}) => {
    write(
      'dist/site-content.json',
      JSON.stringify({
        config: { defaultLanguage: 'en', languages: ['en', 'fr'] },
        // The default language's page as the bundle wrote it: its own image already the build's copy.
        pages: [{ route: '/', sections: [{ stableId: 'hero', content: doc(`![${ALT}](/assets/overlay-aaaaaaaa.webp)`) }] }],
        ...extra
      })
    )
    write('locales/fr.json', JSON.stringify({ [HASH]: '![La superposition](/docs-media/fr/overlay.png)' }))
  }
  const frImage = () => {
    const fr = JSON.parse(readFileSync(join(root, 'dist', 'fr', 'site-content.json'), 'utf8'))
    return fr.pages[0].sections[0].content.content.find((n) => n.type === 'image').attrs
  }

  it("points a translation's file at where the bundle put it, and takes the note out", async () => {
    built({ builtAssets: { paths: { '/docs-media/fr/overlay.png': '/assets/overlay-bbbbbbbb.webp' }, files: {} } })
    await buildLocalizedContent(root, { locales: ['fr'], freeformEnabled: false })
    expect(frImage()).toMatchObject({ alt: 'La superposition', src: '/assets/overlay-bbbbbbbb.webp' })
    const source = JSON.parse(readFileSync(join(root, 'dist', 'site-content.json'), 'utf8'))
    expect('builtAssets' in source).toBe(false)
  })

  it('CONTROL — with no note (a lane that processed no media), the file stays as written', async () => {
    built()
    await buildLocalizedContent(root, { locales: ['fr'], freeformEnabled: false })
    expect(frImage()).toMatchObject({ alt: 'La superposition', src: '/docs-media/fr/overlay.png' })
  })
})
