/**
 * ⭐ A FOLDER PROMOTED TO `/` MEANS ONE THING ON EVERY LANE. Its pages are at the root, and they're
 * still its pages. A folder with no content of its own stays a container at `/`, leading to its first
 * page, and no page of it is promoted in its place.
 *
 * ⛔ Until 2026-11-02 the build asked "am I at the site root?" as `parentRoute === '/'`, which holds one
 * level down too, in a promoted folder. So it promoted the first page of a homepage folder with no
 * content: `/` showed that page, with nothing at its own address, while a push kept the folder as a
 * container, and the same site had `/installation` once published and a 404 for it once built. The
 * build also gave these pages no parent, since a route like `/content` has nothing above it, so the
 * site's menus differed. Measured against a published site, route by route, that day.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { collectSiteContent } from '../src/site/content-collector.js'

let root
const write = (rel, body) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), typeof body === 'string' ? body : yaml.dump(body))
}
const md = (title) => `---\ntype: T\n---\n\n# ${title}\n`

const routes = async () => {
  const { pages } = await collectSiteContent(root)
  return Object.fromEntries(pages.map((p) => [p.route, { parent: p.parent, content: p.hasContent, index: p.isIndex || false }]))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'homepage-folder-'))
  write('theme.yml', {})
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('a homepage folder', () => {
  it('with content of its own: its pages are at the root, and they are its pages', async () => {
    write('site.yml', { name: 'T', index: 'guide' })
    write('pages/guide/page.yml', { title: 'Guide' })
    write('pages/guide/1-overview.md', md('Overview'))
    write('pages/guide/content/page.yml', { title: 'Content' })
    write('pages/guide/content/1.md', md('Content'))
    write('pages/guide/content/more/page.yml', { title: 'More' })
    write('pages/guide/content/more/1.md', md('More'))
    write('pages/about/page.yml', { title: 'About' })
    write('pages/about/1.md', md('About'))

    const got = await routes()
    expect(got['/']).toMatchObject({ index: true, content: true, parent: null })
    expect(got['/content']).toMatchObject({ index: false, parent: '/' })
    expect(got['/content/more']).toMatchObject({ parent: '/content' })
    // CONTROL: a page beside it isn't its page.
    expect(got['/about']).toMatchObject({ parent: null })
    expect(got['/guide']).toBeUndefined()
  })

  it('with no content of its own: stays a container at `/`, and each of its pages keeps its address', async () => {
    write('site.yml', { name: 'T', index: 'start' })
    write('pages/start/page.yml', { title: 'Start' })
    write('pages/start/install/page.yml', { title: 'Install' })
    write('pages/start/install/1.md', md('Install'))
    write('pages/start/configure/page.yml', { title: 'Configure' })
    write('pages/start/configure/1.md', md('Configure'))

    const got = await routes()
    expect(got['/']).toMatchObject({ index: true, content: false })
    expect(got['/install']).toMatchObject({ index: false, content: true, parent: '/' })
    expect(got['/configure']).toMatchObject({ index: false, content: true, parent: '/' })
  })

  it('in folder mode: the same', async () => {
    write('site.yml', { name: 'T', index: 'start' })
    write('pages/start/folder.yml', { title: 'Start' })
    write('pages/start/install.md', md('Install'))
    write('pages/start/configure.md', md('Configure'))

    const got = await routes()
    expect(got['/']).toMatchObject({ index: true, content: false })
    expect(got['/install']).toMatchObject({ index: false, parent: '/' })
    expect(got['/configure']).toMatchObject({ index: false, parent: '/' })
  })

  it('holding a folder named 404: that is a page of the site, not its not-found page', async () => {
    write('site.yml', { name: 'T', index: 'start' })
    write('pages/start/page.yml', { title: 'Start' })
    write('pages/start/1.md', md('Start'))
    write('pages/start/404/page.yml', { title: 'Four oh four' })
    write('pages/start/404/1.md', md('The album'))

    const { pages, notFound } = await collectSiteContent(root)
    expect(notFound ?? null).toBe(null)
    expect(pages.map((p) => p.route)).toContain('/404')
  })
})

describe('the site root itself', () => {
  it('promotes its homepage and takes a 404 folder as its not-found page, as it always has', async () => {
    write('site.yml', { name: 'T', index: 'home' })
    write('pages/home/page.yml', { title: 'Home' })
    write('pages/home/1.md', md('Home'))
    write('pages/404/page.yml', { title: 'Not found' })
    write('pages/404/1.md', md('Not found'))

    const { pages, notFound } = await collectSiteContent(root)
    expect(pages.find((p) => p.route === '/').isIndex).toBe(true)
    expect(notFound?.title).toBe('Not found')
    expect(pages.some((p) => p.ofHomepage)).toBe(false)
  })
})
