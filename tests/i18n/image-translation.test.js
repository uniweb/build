/**
 * ⭐ A TRANSLATION CARRIES AN IMAGE'S ALT TEXT AND ITS FILE (2026-10-28).
 *
 * No image was offered for translation: a translated page kept its source alt text, and could not
 * show a screenshot of its own language. An image is a unit now, keyed by its alt text. Its
 * translation is words — the alt text in that language — or an image, which also names that
 * language's file: `![La superposition](/docs-media/fr/overlay.png)`. The build, the dev server and
 * a push apply it (`merge.js::translateImages`), and a pull reads it back (`uwx/locale-sync.js`).
 */

import { markdownToProseMirror } from '@uniweb/content-reader'
import { extractTranslatableContent } from '../../src/i18n/extract.js'
import { mergeTranslations, resolveDocForLocale, translationKeepsMarkup } from '../../src/i18n/merge.js'
import { computeHash } from '../../src/i18n/hash.js'
import { createTranslationCollector, unwrapLocalizedContent } from '../../src/uwx/locale-sync.js'

const ALT = 'The publishing overlay'
const HASH = computeHash(ALT)
const doc = (md) => markdownToProseMirror(md)
const site = (content) => ({ config: {}, pages: [{ route: '/', sections: [{ stableId: 'hero', content }] }] })
const imageOf = (content) => content.content.find((n) => n.type === 'image')

describe('extraction', () => {
  it('offers a block image, keyed by its alt text, its markup the image as written', () => {
    const units = extractTranslatableContent(site(doc(`# Title\n\n![${ALT}](/docs-media/publishing/overlay.png)`))).units
    expect(units[HASH]).toMatchObject({ source: ALT, field: 'image', markup: `![${ALT}](/docs-media/publishing/overlay.png)` })
  })

  it('offers no icon, no image without alt text, and no image inside a paragraph on its own', () => {
    const units = extractTranslatableContent(site(doc('![](lu-house)\n\n![](/x.png)\n\nWords and ![a logo](/logo.svg) inline.'))).units
    const sources = Object.values(units).map((u) => u.source)
    expect(sources).toEqual(['Words and  inline.'])
  })
})

describe('applying a translation', () => {
  const content = () => doc(`![${ALT}](/docs-media/publishing/overlay.png)`)

  it('words give the image its alt text, and keep its file', () => {
    const fr = mergeTranslations(site(content()), { [HASH]: 'La superposition de publication' })
    expect(imageOf(fr.pages[0].sections[0].content).attrs).toMatchObject({
      alt: 'La superposition de publication',
      src: '/docs-media/publishing/overlay.png',
    })
  })

  it('an image gives it its alt text and its file — on the build and on a push alike', () => {
    const table = { [HASH]: '![La superposition](/docs-media/fr/overlay.png)' }
    const built = imageOf(mergeTranslations(site(content()), table).pages[0].sections[0].content)
    const pushed = imageOf(resolveDocForLocale(content(), table, { page: '/', section: 'hero' }))
    for (const image of [built, pushed]) {
      expect(image.attrs).toMatchObject({ alt: 'La superposition', src: '/docs-media/fr/overlay.png', role: 'image' })
    }
  })

  it('a video takes its file and poster, and keeps its role', () => {
    const video = doc(`![Watch it](/v.mp4){role=video poster=/p.jpg}`)
    const table = { [computeHash('Watch it')]: '![Regardez](/v.fr.mp4){poster=/p.fr.jpg}' }
    expect(imageOf(resolveDocForLocale(video, table)).attrs).toMatchObject({
      alt: 'Regardez',
      src: '/v.fr.mp4',
      poster: '/p.fr.jpg',
      role: 'video',
    })
  })

  it('a heading that shares the image\'s words reads an image value as its words', () => {
    const shared = doc(`# ${ALT}\n\n![${ALT}](/docs-media/publishing/overlay.png)`)
    const fr = mergeTranslations(site(shared), { [HASH]: '![La superposition](/docs-media/fr/overlay.png)' })
    const [heading] = fr.pages[0].sections[0].content.content
    expect(heading.content).toEqual([{ type: 'text', text: 'La superposition' }])
  })

  it('the audit counts words for an image as keeping it', () => {
    expect(translationKeepsMarkup(`![${ALT}](/x.png)`, 'La superposition')).toBe(true)
  })
})

describe('a pull reads an image translation back', () => {
  const source = () => doc(`![${ALT}](/docs-media/publishing/overlay.png)`)
  const pulled = (target) => {
    const collector = createTranslationCollector('en')
    unwrapLocalizedContent({ en: source(), fr: target }, 'en', collector, 'pages/hero.md')
    return { value: collector.byLocale.fr?.[HASH], freeform: collector.freeformPending }
  }

  it('words alone, where only the alt text changed', () => {
    const target = source()
    imageOf(target).attrs.alt = 'La superposition'
    expect(pulled(target).value).toBe('La superposition')
  })

  it('the image, where its file changed — without the identity a push stamps beside it', () => {
    const target = source()
    Object.assign(imageOf(target).attrs, { alt: 'La superposition', src: 'https://cdn/fr.png', assetId: 'f1', assetExt: 'png' })
    expect(pulled(target).value).toBe('![La superposition](https://cdn/fr.png)')
  })

  it('CONTROL — an image that changed in what a translation cannot give is free-form', () => {
    const target = source()
    Object.assign(imageOf(target).attrs, { alt: 'La superposition', role: 'banner' })
    const read = pulled(target)
    expect(read.value).toBeUndefined()
    expect(read.freeform.length).toBe(1)
  })
})
