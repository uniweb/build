/**
 * A localized field may hold ONE PLAIN STRING — the value in every language (a backend ruling of
 * 2026-09-26: `localized` means a field MAY vary by language). A pull writes it as the value and
 * collects no translation: there is no other language to write.
 */
import yaml from 'js-yaml'
import { renderEntityDocument } from '../src/uwx/index.js'
import { createTranslationCollector } from '../src/uwx/locale-sync.js'

const DECLARATION = {
  name: '@acme/link',
  sections: {
    brief: {
      brief: true,
      fields: {
        label: { type: 'string', localized: true },
        url: { type: 'string', localized: true },
      },
    },
  },
}

function pull(brief) {
  const collector = createTranslationCollector('en')
  const text = renderEntityDocument({
    document: { $uuid: 'U-1', $schema: '@acme/link', brief },
    declaration: DECLARATION,
    format: 'yml',
    sourceLocale: 'en',
    collector,
  })
  return { file: yaml.load(text), byLocale: collector.byLocale }
}

describe('a localized field holding one plain string', () => {
  it('⭐ is written as the value, and no translation is collected', () => {
    const { file, byLocale } = pull({ label: { en: 'Docs', fr: 'Documentation' }, url: 'https://a.example' })
    expect(file.url).toBe('https://a.example')
    expect(JSON.stringify(byLocale)).not.toContain('https://a.example')
  })

  it('CONTROL — beside it, a per-language map still gives the source value and collects the rest', () => {
    const { file, byLocale } = pull({ label: { en: 'Docs', fr: 'Documentation' }, url: 'https://a.example' })
    expect(file.label).toBe('Docs')
    expect(Object.values(byLocale.fr || {})).toContain('Documentation')
  })
})
