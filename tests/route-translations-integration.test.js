// Integration: a localized `slug:` in page.yml flows through processPage →
// collectSiteContent → emitted `config.i18n.routeTranslations`, and the
// build-time `slug` is stripped from the page payload (the runtime hydrates
// the precomputed map, not per-page slugs).

import collectSiteContent from '../src/site/content-collector.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('collectSiteContent — localized slugs', () => {
  let siteRoot

  beforeEach(() => {
    siteRoot = join(tmpdir(), `route-tr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(siteRoot, { recursive: true })
    writeFileSync(
      join(siteRoot, 'site.yml'),
      `name: test-site\nlanguages: [en, fr, es]\ndefaultLanguage: en\nindex: home\n`
    )
    writeFileSync(join(siteRoot, 'theme.yml'), `vars:\n  primary: '#000000'\n`)

    // Home page (so the root resolves) — no slug.
    const home = join(siteRoot, 'pages', 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'page.yml'), `title: Home\n`)
    writeFileSync(join(home, '1-hero.md'), `---\ntype: Hero\n---\n\n# Welcome\n`)

    // About-Us page with a per-locale slug map.
    const about = join(siteRoot, 'pages', 'About-Us')
    mkdirSync(about, { recursive: true })
    writeFileSync(
      join(about, 'page.yml'),
      `title: About Us\nslug:\n  fr: a-propos\n  es: acerca-de\n`
    )
    writeFileSync(join(about, '1-intro.md'), `---\ntype: Hero\n---\n\n# About\n`)
  })

  afterEach(() => {
    if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  it('compiles page.yml slug maps into config.i18n.routeTranslations', async () => {
    const { config, pages } = await collectSiteContent(siteRoot)

    expect(config.i18n?.routeTranslations).toEqual({
      fr: { '/About-Us': '/a-propos' },
      es: { '/About-Us': '/acerca-de' },
    })

    // The About-Us page keeps its canonical (folder) route...
    const about = pages.find((p) => p.route === '/About-Us')
    expect(about).toBeTruthy()
    // ...and the build-time `slug` is stripped from the page payload.
    expect(about.slug).toBeUndefined()
  })

  it('emits no i18n.routeTranslations when no page declares a slug', async () => {
    writeFileSync(join(siteRoot, 'pages', 'About-Us', 'page.yml'), `title: About Us\n`)
    const { config } = await collectSiteContent(siteRoot)
    expect(config.i18n?.routeTranslations).toBeUndefined()
  })
})
