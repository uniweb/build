/**
 * ⭐ A PULL WRITES TRANSLATIONS ONLY FOR THE LANGUAGES THE SITE HAS (`documentLanguages`).
 *
 * A section's `content` can hold a language the site does not have, and in a file a language is made
 * by its translation file (`i18n/locales.js`). Measured on 2026-10-30 against a local backend, on a
 * site written in Spanish alone: an edit in the app left an `en` document beside the `es` one, a pull
 * wrote `locales/en.json`, the next push declared `languages: [es, en]`, and the publish asked to serve
 * a second language.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteContentDocumentToProject } from '../src/uwx/index.js'
import { localesToBuild } from '../src/i18n/locales.js'

const doc = (...texts) => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

// One page with one section, its `content` as given.
const site = ({ settings, content, page = {} }) => ({
  info: { name: { es: 'Panadería' }, foundation: '@a/base' },
  ...(settings ? { settings } : {}),
  pages: [
    {
      $id: 'home',
      slug: { es: 'inicio' },
      mode: 'page',
      stable_id: 'home',
      title: { es: 'Inicio' },
      ...page,
      page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content }],
    },
  ],
})

describe('pull — a language the site does not have', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pull-language-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // What a build makes of the files the pull wrote.
  const languagesBuilt = () => localesToBuild(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8')), join(dir, 'locales')).locales

  it('⭐ a site that lists none has its source language: the other is not written, and is named', () => {
    const report = siteContentDocumentToProject({
      siteRoot: dir,
      document: site({
        settings: { default_language: 'es' },
        content: { es: doc('Pan de masa madre. Sí.'), en: doc('Pan de masa madre.'), '@': { en: { mode: 'custom' } } },
      }),
    })
    expect(existsSync(join(dir, 'locales/en.json'))).toBe(false)
    expect(languagesBuilt()).toEqual([])
    expect(report.outsideLanguages).toEqual(['en'])
    expect(readFileSync(join(dir, 'pages/inicio/hero.md'), 'utf8')).toContain('Pan de masa madre. Sí.')
  })

  it('a site that lists its languages: the same, whichever it leaves out', () => {
    const report = siteContentDocumentToProject({
      siteRoot: dir,
      document: site({
        settings: { default_language: 'es', languages: ['es', 'fr'] },
        content: { es: doc('Pan'), fr: doc('Pain'), en: doc('Bread') },
      }),
    })
    expect(existsSync(join(dir, 'locales/en.json'))).toBe(false)
    expect(Object.values(JSON.parse(readFileSync(join(dir, 'locales/fr.json'), 'utf8')))).toEqual(['Pain'])
    expect(report.outsideLanguages).toEqual(['en'])
  })

  it('every place a language is read: a title, a free-form body, a localized URL', () => {
    const report = siteContentDocumentToProject({
      siteRoot: dir,
      document: site({
        settings: { default_language: 'es' },
        // Two paragraphs against one: a free-form translation.
        content: { es: doc('Pan'), de: doc('Brot', 'Und mehr') },
        page: { title: { es: 'Inicio', en: 'Home' }, slug: { es: 'inicio', fr: 'accueil' } },
      }),
    })
    expect(existsSync(join(dir, 'locales'))).toBe(false)
    expect(yaml.load(readFileSync(join(dir, 'pages/inicio/page.yml'), 'utf8')).slug).toBeUndefined()
    expect(report.outsideLanguages).toEqual(['de', 'en', 'fr'])
  })

  it('CONTROL — a language the site lists is written, with nothing to report', () => {
    const report = siteContentDocumentToProject({
      siteRoot: dir,
      document: site({
        settings: { default_language: 'es', languages: ['es', 'en'] },
        content: { es: doc('Pan'), en: doc('Bread') },
        page: { title: { es: 'Inicio', en: 'Home' } },
      }),
    })
    expect(Object.values(JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8')))).toEqual(expect.arrayContaining(['Bread', 'Home']))
    expect(languagesBuilt()).toEqual(['en'])
    expect(report.outsideLanguages).toEqual([])
  })

  it('CONTROL — a wildcard leaves the languages to the translation files', () => {
    const report = siteContentDocumentToProject({
      siteRoot: dir,
      document: site({
        settings: { default_language: 'es', languages: '*' },
        content: { es: doc('Pan'), en: doc('Bread') },
      }),
    })
    expect(Object.values(JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8')))).toEqual(['Bread'])
    expect(report.outsideLanguages).toEqual([])
  })

  it('a translation file the site already keeps is left as it is', () => {
    siteContentDocumentToProject({
      siteRoot: dir,
      document: site({ settings: { default_language: 'es', languages: ['es', 'en'] }, content: { es: doc('Pan'), en: doc('Bread') } }),
    })
    const before = readFileSync(join(dir, 'locales/en.json'), 'utf8')
    siteContentDocumentToProject({
      siteRoot: dir,
      document: site({ settings: { default_language: 'es', languages: ['es'] }, content: { es: doc('Pan'), en: doc('Other') } }),
    })
    expect(readFileSync(join(dir, 'locales/en.json'), 'utf8')).toBe(before)
  })
})
