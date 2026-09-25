/**
 * ⭐ A PUSH SENDS THE TRANSLATIONS THE BUILD WOULD BUILD — the site's locales by one rule.
 *
 * An explicit `languages:` list is the set; `'*'` or no `languages:` at all is every translation
 * file. Measured 2026-09-25 on the `international` template, which declares no `languages:`: its
 * build produced `/es/` and `/fr/`, its push sent English alone, and a clone came back with no
 * translations at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'
import { resolveLocaleList } from '../src/i18n/locales.js'

let ROOT
afterEach(() => ROOT && rmSync(ROOT, { recursive: true, force: true }))

function site(languagesLine) {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-site-locales-'))
  const w = (rel, body) => {
    const p = join(ROOT, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  w('site.yml', ['name: Site', 'defaultLanguage: en', 'foundation: "@acme/fnd@1.0.0"', languagesLine, ''].filter((l) => l !== null).join('\n'))
  w('pages/home/page.yml', 'title: Home\n')
  w('pages/home/hero.md', '---\ntype: Hero\n---\n# Welcome\n')
  w('locales/es.json', JSON.stringify({ [computeHash('Home')]: 'Inicio' }))
  w('locales/fr.json', JSON.stringify({ [computeHash('Home')]: 'Accueil' }))
  w('locales/manifest.json', JSON.stringify({ units: {} }))
  w('locales/_memory.json', JSON.stringify({}))
  return ROOT
}

const homeTitle = async (root) => (await siteProjectToDocument(root)).pages.find((p) => p.stable_id === 'home' || p.slug?.en === 'home')?.title

describe('the push sends each locale the site has', () => {
  it('⭐ no `languages:` — every translation file, as the build reads them', async () => {
    expect(await homeTitle(site(null))).toEqual({ en: 'Home', es: 'Inicio', fr: 'Accueil' })
  })

  it("`languages: '*'` — the same", async () => {
    expect(await homeTitle(site("languages: '*'"))).toEqual({ en: 'Home', es: 'Inicio', fr: 'Accueil' })
  })

  it('CONTROL — an explicit list is the set, as written', async () => {
    expect(await homeTitle(site('languages: [en, es]'))).toEqual({ en: 'Home', es: 'Inicio' })
  })
})

describe('resolveLocaleList — the one rule', () => {
  it('reads no locale from the manifest or the translation memory', () => {
    const root = site(null)
    expect(resolveLocaleList(undefined, join(root, 'locales'))).toEqual(['es', 'fr'])
  })
})
