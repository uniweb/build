// A version folder's URL is its path, like any folder's. The name decides where it sorts and nothing
// else, so a build and a push agree on every URL and neither has a rule to apply.

import collectSiteContent, { orderFolders } from '../src/site/content-collector.js'
import { warnOfDuplicatePageIds } from '../src/site/duplicate-page-ids.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { vi } from 'vitest'

function page(siteRoot, folder, title, config = '') {
  const dir = join(siteRoot, 'pages', ...folder.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page.yml'), `title: ${title}\n${config}`)
  writeFileSync(join(dir, '1-content.md'), `---\ntype: Text\n---\n\n# ${title}\n`)
}

function folder(siteRoot, name, config) {
  const dir = join(siteRoot, 'pages', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page.yml'), config)
}

describe('collectSiteContent — version folders', () => {
  let siteRoot

  beforeEach(() => {
    siteRoot = join(tmpdir(), `version-folders-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(siteRoot, { recursive: true })
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\nindex: home\n`)
    writeFileSync(join(siteRoot, 'theme.yml'), `colors:\n  primary: '#000000'\n`)
    page(siteRoot, 'home', 'Home')
    folder(siteRoot, 'docs', 'title: Docs\n')
  })

  afterEach(() => {
    if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true })
  })

  it('every page keeps the URL its folder gives it, and hangs from its folder', async () => {
    page(siteRoot, 'docs/start', 'Start')
    page(siteRoot, 'docs/start/install', 'Install')
    folder(siteRoot, 'docs/v1', 'title: "1.x"\n')
    page(siteRoot, 'docs/v1/start', 'Start')
    page(siteRoot, 'docs/v1/start/install', 'Install')

    const { pages } = await collectSiteContent(siteRoot)
    const parentOf = (route) => pages.find((p) => p.route === route)?.parent

    expect(parentOf('/docs/start')).toBe('/docs')
    expect(parentOf('/docs/start/install')).toBe('/docs/start')
    expect(parentOf('/docs/v1')).toBe('/docs')
    expect(parentOf('/docs/v1/start')).toBe('/docs/v1')
    expect(parentOf('/docs/v1/start/install')).toBe('/docs/v1/start')
    expect(pages.find((p) => p.route === '/docs/v1').title).toBe('1.x')
  })

  it('a site with version folders and no pages beside them keeps each one in its URL', async () => {
    page(siteRoot, 'docs/v1/start', 'Start')
    page(siteRoot, 'docs/v2/start', 'Start')

    const { pages } = await collectSiteContent(siteRoot)
    const routes = pages.map((p) => p.route)

    expect(routes).toContain('/docs/v1/start')
    expect(routes).toContain('/docs/v2/start')
    expect(routes).not.toContain('/docs/start')
  })

  it('version folders list after the pages beside them, newest first', async () => {
    page(siteRoot, 'docs/zebra', 'Zebra')
    page(siteRoot, 'docs/apple', 'Apple')
    page(siteRoot, 'docs/v1/start', 'Start')
    page(siteRoot, 'docs/v2.10/start', 'Start')
    page(siteRoot, 'docs/v2.9/start', 'Start')

    const { pages } = await collectSiteContent(siteRoot)
    const kids = pages.filter((p) => p.parent === '/docs').map((p) => p.route)

    expect(kids).toEqual(['/docs/apple', '/docs/zebra', '/docs/v2.10', '/docs/v2.9', '/docs/v1'])
  })

  it('a push lists them the same way', () => {
    const folders = ['v1', 'zebra', 'v2', 'apple'].map((dirName) => ({ dirName }))
    expect(orderFolders(folders).map((f) => f.dirName)).toEqual(['apple', 'zebra', 'v2', 'v1'])
  })

  it('an `order:` still comes first', async () => {
    page(siteRoot, 'docs/apple', 'Apple')
    page(siteRoot, 'docs/v1/start', 'Start')
    writeFileSync(join(siteRoot, 'pages/docs/v1/page.yml'), 'title: "1.x"\norder: 1\n')

    const { pages } = await collectSiteContent(siteRoot)
    const kids = pages.filter((p) => p.parent === '/docs').map((p) => p.route)

    expect(kids).toEqual(['/docs/v1', '/docs/apple'])
  })

  it('a root with version folders keeps its homepage out of them', async () => {
    rmSync(join(siteRoot, 'pages'), { recursive: true, force: true })
    writeFileSync(join(siteRoot, 'site.yml'), `name: test-site\n`)
    page(siteRoot, 'v1/start', 'Old start')
    page(siteRoot, 'start', 'Start')
    page(siteRoot, 'guide', 'Guide')

    const { pages } = await collectSiteContent(siteRoot)
    const home = pages.find((p) => p.route === '/')

    expect(home.title).not.toBe('Old start')
    expect(pages.map((p) => p.route)).toContain('/v1/start')
  })

  it.each(['page.yml', 'folder.yml'])('refuses `versions:` in %s and says what to do', async (file) => {
    page(siteRoot, 'docs/v1/start', 'Start')
    rmSync(join(siteRoot, 'pages/docs/page.yml'))
    writeFileSync(join(siteRoot, 'pages/docs', file), 'versions:\n  v1:\n    label: "1.0"\n')

    await expect(collectSiteContent(siteRoot)).rejects.toThrow(/`versions:` is retired.*`title`.*Move the latest/s)
  })

  it('a section may still have a param called `versions`', async () => {
    const dir = join(siteRoot, 'pages/docs/start')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1-content.md'), `---\ntype: Text\nversions: [a, b]\n---\n\n# Start\n`)

    await expect(collectSiteContent(siteRoot)).resolves.toBeTruthy()
  })

  it('names two pages with one id, with both their URLs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    page(siteRoot, 'docs/start', 'Start', 'id: start\n')
    page(siteRoot, 'docs/v1/start', 'Start', 'id: start\n')

    await collectSiteContent(siteRoot)
    const said = warn.mock.calls.map(([message]) => message).filter((m) => /Page id/.test(m))
    warn.mockRestore()

    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/"start" is on 2 pages: \/docs\/start, \/docs\/v1\/start/)
  })
})

describe('warnOfDuplicatePageIds', () => {
  it('says nothing about unique ids and pages with none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const found = warnOfDuplicatePageIds([
      { id: 'a', route: '/a' },
      { id: null, route: '/b' },
      { id: null, route: '/c' },
      { route: '/d' },
    ])
    expect(found).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
