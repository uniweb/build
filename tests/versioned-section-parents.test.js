// A versioned section — `docs/v1/`, `docs/v2/` — and the parent each page declares.
// The latest version's pages sit at `/docs/…` and hang from `/docs`; an older version's
// sit at `/docs/v1/…`, under a folder that is never a page. They declare `/docs` too, by
// the one parent rule (`parentRouteOf`), or no menu and no branch of the tree holds them.

import collectSiteContent from '../src/site/content-collector.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function page(siteRoot, folder, title) {
  const dir = join(siteRoot, 'pages', ...folder.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page.yml'), `title: ${title}\n`)
  writeFileSync(join(dir, '1-content.md'), `---\ntype: Text\n---\n\n# ${title}\n`)
}

describe('collectSiteContent — a versioned section declares its pages\' parents', () => {
  let siteRoot

  beforeEach(() => {
    siteRoot = join(tmpdir(), `versioned-parents-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(siteRoot, { recursive: true })
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\nindex: home\n`)
    writeFileSync(join(siteRoot, 'theme.yml'), `colors:\n  primary: '#000000'\n`)
    page(siteRoot, 'home', 'Home')
    mkdirSync(join(siteRoot, 'pages', 'docs'), { recursive: true })
    writeFileSync(join(siteRoot, 'pages', 'docs', 'page.yml'), `title: Docs\n`)
    page(siteRoot, 'docs/v2/start', 'Start')
    page(siteRoot, 'docs/v2/start/install', 'Install')
    page(siteRoot, 'docs/v1/start', 'Start')
    page(siteRoot, 'docs/v1/start/install', 'Install')
  })

  afterEach(() => {
    if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  it('an older version\'s top pages hang from the section, as the latest\'s do', async () => {
    const { pages } = await collectSiteContent(siteRoot)
    const parentOf = (route) => pages.find((p) => p.route === route)?.parent

    expect(parentOf('/docs/start')).toBe('/docs')
    expect(parentOf('/docs/v1/start')).toBe('/docs')
    expect(parentOf('/docs/start/install')).toBe('/docs/start')
    expect(parentOf('/docs/v1/start/install')).toBe('/docs/v1/start')
  })
})
