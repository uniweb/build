/**
 * A localized value with no text in any language — `{}` on the wire — is no value: a pull writes
 * no field for it. ⛔ Until 2026-10-26 the empty map passed through and a gallery's emptied
 * captions were written `caption: {}`, an object where the schema says string; `uniweb validate`
 * refused the fifteen records, and a publish stopped on them.
 */
import yaml from 'js-yaml'
import { renderEntityDocument } from '../src/uwx/index.js'
import { unwrapLocalized, unwrapLocalizedList } from '../src/uwx/backfill.js'
import { createTranslationCollector } from '../src/uwx/locale-sync.js'

const DECLARATION = {
  name: '@acme/photo',
  sections: {
    brief: {
      brief: true,
      fields: {
        title: { type: 'string', localized: true },
        caption: { type: 'string', localized: true },
        tags: { type: 'string', localized: true, multiple: true },
      },
    },
  },
}

function pull(brief) {
  const text = renderEntityDocument({
    document: { $uuid: 'U-1', $schema: '@acme/photo', brief },
    declaration: DECLARATION,
    format: 'yml',
    sourceLocale: 'en',
    collector: createTranslationCollector('en'),
  })
  return { text, file: yaml.load(text) }
}

describe('a localized value with no text in any language', () => {
  it('⭐ writes no field', () => {
    const { text, file } = pull({ title: { en: 'Balayage' }, caption: {} })
    expect(file).toEqual({ $uuid: 'U-1', title: 'Balayage' })
    expect(text).not.toMatch(/caption/)
  })

  it('is no element of a localized list', () => {
    expect(unwrapLocalizedList([{}, { en: 'blonde' }], 'en')).toEqual(['blonde'])
  })

  // CONTROLS: an empty string is a value, and another language stands in for a missing source.
  it('control: an empty string is written, and another language stands in', () => {
    expect(pull({ title: { en: 'Balayage' }, caption: { en: '' } }).file.caption).toBe('')
    expect(unwrapLocalized({ fr: 'Mèches' }, 'en')).toBe('Mèches')
    expect(unwrapLocalized({}, 'en')).toBeUndefined()
    expect(unwrapLocalized('plain', 'en')).toBe('plain')
  })
})
