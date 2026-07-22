/**
 * The resolved base path must reach the content payload.
 *
 * Regression: the base was resolved in the vite config (`--base` > UNIWEB_BASE
 * > site.yml::base) and handed to vite, but never written onto
 * `siteContent.config.base`. The browser was fine — it derives the router
 * basename from vite's BASE_URL — but the prerenderer has no BASE_URL and sets
 * `website.basePath` from `config.base` alone. So a base supplied via
 * UNIWEB_BASE (what the generated GitHub Pages workflow does) left basePath
 * empty during prerender, and every prerendered `<a href>` came out without the
 * prefix: a crawler or no-JS visitor following one left the site entirely,
 * while hydration quietly repaired it for everyone else.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — resolved base', () => {
  let siteDir

  async function makeSite(siteYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteDir
  }

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('records a base that site.yml does not declare', async () => {
    const dir = await makeSite('name: Test\n')

    const content = await collectSiteContent(dir, { base: '/my-repo/' })

    expect(content.config.base).toBe('/my-repo/')
  })

  it('lets the resolved base win over site.yml (matching config precedence)', async () => {
    const dir = await makeSite('name: Test\nbase: /from-yaml/\n')

    const content = await collectSiteContent(dir, { base: '/from-env/' })

    expect(content.config.base).toBe('/from-env/')
  })

  it('keeps site.yml::base when no base is passed', async () => {
    const dir = await makeSite('name: Test\nbase: /from-yaml/\n')

    const content = await collectSiteContent(dir)

    expect(content.config.base).toBe('/from-yaml/')
  })

  it('leaves the field absent at the root base', async () => {
    const dir = await makeSite('name: Test\n')

    // '/' is not a real base, and in shell mode `config.base` belongs to the
    // serving layer (it injects the served subpath). Writing a build-time '/'
    // would park a meaningless value in that slot.
    for (const base of ['/', undefined]) {
      const content = await collectSiteContent(dir, { base })
      expect(content.config.base).toBeUndefined()
    }
  })
})

describe('collectSiteContent — theme font links', () => {
  let siteDir

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('carries the theme font links through to the payload', async () => {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-site-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), 'name: Test\n')
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    await writeFile(
      join(siteDir, 'theme.yml'),
      'fonts:\n  body: "Inter, sans-serif"\n  import:\n    - url: "https://fonts.googleapis.com/css2?family=Inter:wght@400"\n'
    )

    const content = await collectSiteContent(siteDir)

    // Without this the head gets a preconnect and no stylesheet, so the
    // imported family never loads.
    expect(content.theme.links).toContain('rel="stylesheet"')
    expect(content.theme.links).toContain('fonts.googleapis.com/css2?family=Inter')
  })
})
