/**
 * A translation holding HTML shows it on the page, so a build says so.
 *
 * HTML is not content: it stays the text it is and shows as written (`@uniweb/content-reader`), and
 * saying so is the caller's job, which pages and free-form translations did and a translation's
 * value did not. Measured 2026-10-31 on a site translated in April as `<span primary="true">`: three
 * headlines in ten languages showed the tag from the October release on, through a build and two
 * publishes that printed nothing.
 */

import { describe, test, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translationsHoldingHtml } from '../../src/i18n/merge.js'
import { buildLocalizedContent } from '../../src/i18n/index.js'

describe('which translations hold HTML', () => {
  test('⭐ a span, as a translator wrote it, by its key', () => {
    const found = translationsHoldingHtml({
      aaaaaaaa: 'Nous construisons <span primary="true">depuis 2012.</span>',
      bbbbbbbb: 'Rien de spécial.'
    })
    expect(found).toEqual(['aaaaaaaa'])
  })

  test('a value with overrides: its default, and each override', () => {
    expect(translationsHoldingHtml({ aaaaaaaa: { default: 'Un <b>mot</b>' } })).toEqual(['aaaaaaaa'])
    expect(translationsHoldingHtml({ bbbbbbbb: { default: 'Un mot', overrides: { 'p:s': 'Un <i>mot</i>' } } })).toEqual(['bbbbbbbb'])
  })

  test('CONTROL — the markup a translation does take', () => {
    expect(
      translationsHoldingHtml({
        aaaaaaaa: 'Nous construisons [depuis 2012.]{primary}',
        bbbbbbbb: '**Gras** et *italique*, [un lien](/page)',
        cccccccc: 'Une ligne<br>puis une autre',
        dddddddd: 'Écrivez `<Hero>` dans la page',
        eeeeeeee: '3 < 5 et 7 > 2'
      })
    ).toEqual([])
  })

  test('CONTROL — an empty table, or none', () => {
    expect(translationsHoldingHtml({})).toEqual([])
    expect(translationsHoldingHtml(undefined)).toEqual([])
  })
})

describe('a build says so', () => {
  const dirs = []
  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
    vi.restoreAllMocks()
  })

  async function buildWith(translations) {
    const root = mkdtempSync(join(tmpdir(), 'uw-i18n-html-'))
    dirs.push(root)
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'locales'), { recursive: true })
    writeFileSync(
      join(root, 'dist', 'site-content.json'),
      JSON.stringify({ config: { defaultLanguage: 'en', languages: ['en', 'fr'] }, pages: [] })
    )
    writeFileSync(join(root, 'locales', 'fr.json'), JSON.stringify(translations))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await buildLocalizedContent(root, { locales: ['fr'], outputDir: join(root, 'dist') })
    return warn.mock.calls.map((call) => call.join(' ')).join('\n')
  }

  test('⭐ one line for the language, naming the file, the keys and the way to write it', async () => {
    const said = await buildWith({
      aaaaaaaa: 'Un <span primary="true">mot</span>',
      bbbbbbbb: 'Deux <span primary="true">mots</span>'
    })
    expect(said).toMatch(/locales\/fr\.json/)
    expect(said).toMatch(/2 translations hold HTML/)
    expect(said).toMatch(/aaaaaaaa, bbbbbbbb/)
    expect(said).toMatch(/\[text\]\{primary\}/)
  })

  test('CONTROL — nothing said over a clean table', async () => {
    expect(await buildWith({ aaaaaaaa: 'Un [mot]{primary}' })).not.toMatch(/HTML/)
  })
})
