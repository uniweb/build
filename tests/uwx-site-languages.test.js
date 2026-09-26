/**
 * ⭐ A SITE THAT DECLARES NO `languages:` SENDS THE LANGUAGES ITS TRANSLATION FILES MAKE — and a pull
 * does not write that list back where the files already say it.
 *
 * The build serves a site in every language it has a translation file for when `languages:` is absent
 * (`i18n/locales.js`). A push sent `settings.languages` only when declared, so the `international`
 * template — no `languages:`, Spanish and French files — sent no language but its source, beside
 * Spanish and French content and localized URLs.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { computeHash } from '../src/i18n/hash.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uwx-languages-'))
  dirs.push(d)
  return d
}

function project({ languages = null, locales = ['es', 'fr'] } = {}) {
  const root = tmp()
  const w = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  w('site.yml', `name: Site\ndefaultLanguage: en\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n${languages ? `languages: ${languages}\n` : ''}`)
  w('pages/home/page.yml', 'title: Home\n')
  w('pages/home/hero.md', '---\ntype: Hero\n---\n\n# Welcome\n')
  const title = { es: 'Inicio', fr: 'Accueil', de: 'Startseite' }
  for (const l of locales) w(`locales/${l}.json`, JSON.stringify({ [computeHash('Home')]: title[l] }, null, 2) + '\n')
  return root
}
const siteYml = (root) => yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'))

describe('push — the site’s languages', () => {
  it('⭐ none declared: the list its translation files make', async () => {
    expect((await siteProjectToDocument(project())).settings.languages).toEqual(['en', 'es', 'fr'])
  })

  it('CONTROL — a declared list is sent as it is', async () => {
    expect((await siteProjectToDocument(project({ languages: '[en, es]' }))).settings.languages).toEqual(['en', 'es'])
  })

  it('a site with no translation files sends none', async () => {
    expect((await siteProjectToDocument(project({ locales: [] }))).settings.languages).toBeUndefined()
  })
})

describe('pull — the list a push sent for a site that declares none', () => {
  it('⭐ into the copy that pushed: site.yml is left as it was', async () => {
    const root = project()
    const before = readFileSync(join(root, 'site.yml'), 'utf8')
    siteContentDocumentToProject({ document: await siteProjectToDocument(root), siteRoot: root })
    expect(readFileSync(join(root, 'site.yml'), 'utf8')).toBe(before)
  })

  it('⭐ into a clone: no list — its translation files make the same one', async () => {
    const clone = tmp()
    siteContentDocumentToProject({ document: await siteProjectToDocument(project()), siteRoot: clone })
    expect(readFileSync(join(clone, 'locales/es.json'), 'utf8')).toContain('Inicio')
    expect(siteYml(clone).languages).toBeUndefined()
  })

  it('a language the files do not make is written — the list, whole', async () => {
    const clone = tmp()
    const document = await siteProjectToDocument(project())
    document.settings.languages = ['en', 'es', 'fr', 'de'] // German, with nothing translated yet
    siteContentDocumentToProject({ document, siteRoot: clone })
    expect(siteYml(clone).languages).toEqual(['en', 'es', 'fr', 'de'])
  })
})
