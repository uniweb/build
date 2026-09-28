/**
 * A folder entry's `label` — one text, or one text per language (2026-09-28): how each lane
 * reads it (`src/site/entry-label.js`).
 */
import { readLabel, labelOnWire, labelForFile, labelIn } from '../src/site/entry-label.js'

describe('readLabel — what an author may write', () => {
  it('one text, trimmed; a number is text', () => {
    expect(readLabel('  Ada  ')).toEqual({ label: 'Ada' })
    expect(readLabel(2024)).toEqual({ label: '2024' })
  })

  it('one text per language, keeping each that says something', () => {
    expect(readLabel({ en: 'Ada', fr: ' Ada (fr) ', de: '' })).toEqual({ label: { en: 'Ada', fr: 'Ada (fr)' } })
  })

  it('an empty one of either is no label', () => {
    expect(readLabel('  ')).toEqual({ label: null })
    expect(readLabel({ en: '' })).toEqual({ label: null })
    expect(readLabel(null)).toEqual({ label: null })
  })

  it('refuses what is neither', () => {
    expect(readLabel(['Ada']).error).toMatch(/neither a text nor one text per language/)
    expect(readLabel({ en: ['Ada'] }).error).toMatch(/gives `en` something that is not text/)
  })
})

describe('labelOnWire — a push sends a map of languages', () => {
  it('one text is the source language’s; a map goes as written', () => {
    expect(labelOnWire('Ada', 'en')).toEqual({ en: 'Ada' })
    expect(labelOnWire({ en: 'Ada', fr: 'Ada (fr)' }, 'en')).toEqual({ en: 'Ada', fr: 'Ada (fr)' })
  })
})

describe('labelForFile — a pull writes every language the label holds', () => {
  it('the source language’s alone is one text — the form an author writes most', () => {
    expect(labelForFile({ en: 'Ada' }, 'en')).toBe('Ada')
    expect(labelForFile('Ada', 'en')).toBe('Ada')
  })

  it('any other language keeps the map, the source language first', () => {
    const written = labelForFile({ fr: 'Ada (fr)', en: 'Ada' }, 'en')
    expect(written).toEqual({ en: 'Ada', fr: 'Ada (fr)' })
    expect(Object.keys(written)).toEqual(['en', 'fr'])
  })

  it('CONTROL — one language that is not the source stays a map: one text would claim the source’s', () => {
    expect(labelForFile({ fr: 'Ada (fr)' }, 'en')).toEqual({ fr: 'Ada (fr)' })
  })

  it('nothing to write when it holds no text', () => {
    expect(labelForFile({ en: '' }, 'en')).toBeNull()
    expect(labelForFile(undefined, 'en')).toBeNull()
  })
})

describe('labelIn — the text a language gets', () => {
  const label = { en: 'Ada', fr: 'Ada (fr)' }
  it('the language, its base language, then the site’s default language', () => {
    expect(labelIn(label, 'fr', 'en')).toBe('Ada (fr)')
    expect(labelIn(label, 'fr-CA', 'en')).toBe('Ada (fr)')
    expect(labelIn(label, 'es', 'en')).toBe('Ada')
  })

  it('none when the label holds nothing of that chain — as a records service answers', () => {
    expect(labelIn({ fr: 'Ada (fr)' }, 'en', 'en')).toBeNull()
  })

  it('one text is every language’s', () => {
    expect(labelIn('Ada', 'fr', 'en')).toBe('Ada')
  })
})
