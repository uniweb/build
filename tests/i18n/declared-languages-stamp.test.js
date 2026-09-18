/**
 * The build stamps the locale set it resolved onto every payload it writes.
 *
 * ⛔ THE BUILD AND THE RUNTIME USED TO DISAGREE ABOUT WHERE LOCALES COME FROM.
 * The build derives them from the FILESYSTEM — every `locales/*.json` — while
 * `Website.buildLocalesList` reads `config.languages` and nothing else. A site
 * with locale files and no `languages:` in `site.yml` therefore built a complete
 * `dist/<locale>/` tree whose Website reported `hasMultipleLocales() === false`,
 * and everything gated on that answer switched off silently in the rendered
 * output: no link was locale-prefixed, no route translation was applied although
 * the build had emitted the translated routes as real directories, and any
 * foundation UI gated on it — the language switcher — vanished.
 *
 * ⭐ Nothing failed. Both sides did exactly what they were written to do, which is
 * why it survived: the only symptom was a French page whose every link pointed
 * into the English tree. Measured 2026-09-18 on our own `international` template,
 * which was in this state, and independently on a documentation site whose author
 * reported it as a `page:` defect.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildLocalizedContent } from '../../src/i18n/index.js'

const ROOT = '/tmp/uniweb-declared-languages-test'
const DIST = join(ROOT, 'dist')

async function setup(config) {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(join(ROOT, 'locales'), { recursive: true })
  await mkdir(DIST, { recursive: true })
  await writeFile(join(ROOT, 'locales', 'fr.json'), '{}')
  await writeFile(join(ROOT, 'locales', 'es.json'), '{}')
  await writeFile(
    join(DIST, 'site-content.json'),
    JSON.stringify({ config, pages: [{ route: '/', title: 'Home', sections: [] }] })
  )
}

const languagesOf = async (path) =>
  JSON.parse(await readFile(path, 'utf8')).config.languages

afterEach(async () => { await rm(ROOT, { recursive: true, force: true }) })

describe('declared locale set on the built payload', () => {
  beforeEach(async () => { await setup({ defaultLanguage: 'en' }) })

  it('stamps the resolved set when site.yml declared none', async () => {
    await buildLocalizedContent(ROOT, {
      locales: ['fr', 'es'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'fr', 'site-content.json'))).toEqual(['en', 'fr', 'es'])
  })

  it('stamps the DEFAULT locale payload too, so "/" keeps its switcher', async () => {
    await buildLocalizedContent(ROOT, {
      locales: ['fr', 'es'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'site-content.json'))).toEqual(['en', 'fr', 'es'])
  })

  it('carries the default locale, not only the translated ones', async () => {
    await buildLocalizedContent(ROOT, {
      locales: ['fr'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'fr', 'site-content.json'))).toContain('en')
  })
})

describe('an authored languages list', () => {
  it('keeps authored entries — including a { code, label } object — and appends the rest', async () => {
    await setup({
      defaultLanguage: 'en',
      languages: ['en', { code: 'fr', label: 'Français (CA)' }]
    })
    await buildLocalizedContent(ROOT, {
      locales: ['fr', 'es'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'fr', 'site-content.json'))).toEqual([
      'en',
      { code: 'fr', label: 'Français (CA)' },
      'es'
    ])
  })

  it('drops the wildcard rather than passing it through as a code', async () => {
    // `languages: '*'` means "discover from locales/" — the build has already
    // done that discovery, so the resolved codes replace the marker.
    await setup({ defaultLanguage: 'en', languages: ['*'] })
    await buildLocalizedContent(ROOT, {
      locales: ['fr'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'fr', 'site-content.json'))).toEqual(['en', 'fr'])
  })
})

describe('the default locale is the root tree', () => {
  it('writes no dist/<default>/ even when languages declares it', async () => {
    // The trap: an explicit `languages: [en, fr]` resolves verbatim, default
    // included, so the DECLARED form minted a byte-identical duplicate of every
    // page while the wildcard form did not. Measured 2026-09-18: 47 pages.
    await setup({ defaultLanguage: 'en', languages: ['en', 'fr'] })
    const outputs = await buildLocalizedContent(ROOT, {
      locales: ['en', 'fr'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(Object.keys(outputs)).toEqual(['fr'])
    expect(existsSync(join(DIST, 'en'))).toBe(false)
    expect(existsSync(join(DIST, 'fr', 'site-content.json'))).toBe(true)
  })

  it('still declares the default in the stamped locale set', async () => {
    // Skipping its OUTPUT tree must not drop it from the DECLARED set — the
    // language switcher needs it as a choice.
    await setup({ defaultLanguage: 'en', languages: ['en', 'fr'] })
    await buildLocalizedContent(ROOT, {
      locales: ['en', 'fr'],
      outputDir: DIST,
      generateSearchIndexes: false,
      freeformEnabled: false
    })
    expect(await languagesOf(join(DIST, 'fr', 'site-content.json'))).toEqual(['en', 'fr'])
  })
})
