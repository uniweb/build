// `uniweb add version`: what a copy of a site's docs gets wrong, and what this does about each.

import { addVersion } from '../src/site/add-version.js'
import collectSiteContent from '../src/site/content-collector.js'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

let root

function write(path, text) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (path) => readFileSync(join(root, path), 'utf8')
const has = (path) => existsSync(join(root, path))

const body = (title, rest = '') => `---\ntype: Text\n---\n\n# ${title}\n\n${rest}\n`

beforeEach(() => {
  root = join(tmpdir(), `add-version-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  write('site.yml', 'name: test\nindex: home\n')
  write('theme.yml', "colors:\n  primary: '#000000'\n")
  write('pages/home/page.yml', 'title: Home\n')
  write('pages/home/1-hello.md', body('Home'))
  write('pages/about/page.yml', 'id: about\ntitle: About\n')
  write('pages/about/1-about.md', body('About'))
  write('pages/docs/page.yml', 'id: d41b8ac0\ntitle: Docs\norder: 2\n')
  write('pages/docs/start/page.yml', 'id: start\ntitle: Start\norder: 1\n# a comment worth keeping\n')
  write(
    'pages/docs/start/1-start.md',
    body(
      'Start',
      [
        'By id: [guide](page:guide) and [anchored](page:guide#setup).',
        'By path: [a](page:docs/guide) and [b](/docs/guide#setup).',
        'Leaving: [about](page:about), [home](page:/), [site](https://example.com), [outside](/about).',
        'Inline code stays: `[a](page:guide)`, and ``[b](page:guide)``.',
        '',
        '```md',
        '[sample](page:guide)',
        '```',
        '',
        '```yaml:nav',
        '- href: page:guide',
        '- href: /about',
        '```',
        '',
        '```json:more',
        '{ "href": "/docs/guide", "other": "words" }',
        '```',
        '',
        '![image](./shot.png)',
      ].join('\n')
    )
  )
  write('pages/docs/start/shot.png', 'not really a png')
  write('pages/docs/guide/page.yml', 'id: guide\ntitle: Guide\norder: 2\n')
  write('pages/docs/moved/page.yml', 'title: Moved\norder: 3\nredirect: page:start\n')
  write('pages/docs/guide/1-guide.md', '---\ntype: Text\nlink: page:start\nother: /about\n---\n\n# Guide\n\n[Up](../start/1-start.md) and [out](../../about/1-about.md).\n')
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe('the copy', () => {
  it('goes beside the docs, which stay as they were', async () => {
    const before = read('pages/docs/start/1-start.md')
    const report = await addVersion(root, { name: 'v2', folder: 'docs' })

    expect(report).toMatchObject({ name: 'v2', folder: 'docs', route: '/docs/v2', pages: 3, path: 'pages/docs/v2' })
    expect(has('pages/docs/v2/start/1-start.md')).toBe(true)
    expect(has('pages/docs/v2/start/shot.png')).toBe(true)
    expect(read('pages/docs/start/1-start.md')).toBe(before)
    expect(read('pages/docs/page.yml')).toContain('id: d41b8ac0')
  })

  it('is at its own URLs, with the docs at theirs', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    const { pages } = await collectSiteContent(root)
    const routes = pages.map((p) => p.route)

    expect(routes).toEqual(expect.arrayContaining(['/docs/start', '/docs/guide', '/docs/v2', '/docs/v2/start', '/docs/v2/guide']))
    expect(pages.find((p) => p.route === '/docs/v2').title).toBe('v2')
  })

  it('takes no page ids, and keeps the file otherwise as written', async () => {
    const report = await addVersion(root, { name: 'v2', folder: 'docs' })
    const copy = read('pages/docs/v2/start/page.yml')

    expect(copy).not.toMatch(/^id:/m)
    expect(copy).toContain('# a comment worth keeping')
    expect(report.ids).toBe(2)
  })

  it('leaves no two pages with one id, and warns of none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await addVersion(root, { name: 'v2', folder: 'docs' })
    await collectSiteContent(root)
    const said = warn.mock.calls.map(([m]) => m).filter((m) => /Page id/.test(m))
    warn.mockRestore()
    expect(said).toEqual([])
  })
})

describe('the links in it', () => {
  const start = async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    return read('pages/docs/v2/start/1-start.md')
  }

  it('lead to the copy, by id or by path, anchors kept', async () => {
    const text = await start()
    expect(text).toContain('[guide](page:docs/v2/guide)')
    expect(text).toContain('[anchored](page:docs/v2/guide#setup)')
    expect(text).toContain('[a](page:docs/v2/guide)')
    expect(text).toContain('[b](/docs/v2/guide#setup)')
  })

  it('leave alone anything outside the docs', async () => {
    const text = await start()
    expect(text).toContain('[about](page:about)')
    expect(text).toContain('[home](page:/)')
    expect(text).toContain('[site](https://example.com)')
    expect(text).toContain('[outside](/about)')
  })

  it('in a code sample stay words', async () => {
    const text = await start()
    expect(text).toContain('`[a](page:guide)`')
    expect(text).toContain('``[b](page:guide)``')
    expect(text).toContain('```md\n[sample](page:guide)\n```')
  })

  it('in a tagged data block are content', async () => {
    const text = await start()
    expect(text).toContain('- href: page:docs/v2/guide')
    expect(text).toContain('- href: /about')
    expect(text).toContain('"href": "/docs/v2/guide"')
  })

  it('in frontmatter and a page\'s config lead to the copy too', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    const text = read('pages/docs/v2/guide/1-guide.md')
    expect(text).toContain('link: page:docs/v2/start')
    expect(text).toContain('other: /about')
    expect(read('pages/docs/v2/moved/page.yml')).toContain('redirect: page:docs/v2/start')
  })

  it('that are relative stay inside the copy, and reach out one level further', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    const text = read('pages/docs/v2/guide/1-guide.md')
    expect(text).toContain('[Up](../start/1-start.md)')
    expect(text).toContain('[out](../../../about/1-about.md)')
    expect(read('pages/docs/v2/start/1-start.md')).toContain('![image](./shot.png)')
  })

  it('all resolve, on the built site', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    const { pages } = await collectSiteContent(root)
    const copy = JSON.stringify(pages.find((p) => p.route === '/docs/v2/guide').sections)
    expect(pages.find((p) => p.route === '/docs/v2/moved').redirect).toBe('page:docs/v2/start')
    expect(copy).toContain('/docs/v2/start')
    expect(copy).toContain('/about')
    expect(copy).not.toContain('.md')
  })
})

describe('the version\'s own page', () => {
  it('names it and keeps it out of search engines', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs', label: '2.x' })
    expect(yaml.load(read('pages/docs/v2/page.yml'))).toEqual({ title: '2.x', seo: { noindex: true } })
  })

  it('leaves it open when asked', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs', keepInSearch: true })
    expect(yaml.load(read('pages/docs/v2/page.yml'))).toEqual({ title: 'v2' })
  })

  it('keeps the page order, without other versions in it', async () => {
    write('pages/docs/page.yml', 'title: Docs\npages: [guide, start, v1, ...]\n')
    await addVersion(root, { name: 'v2', folder: 'docs' })
    expect(yaml.load(read('pages/docs/v2/page.yml')).pages).toEqual(['guide', 'start', '...'])
  })

  it('a folder in folder mode copies as one', async () => {
    write('pages/manual/folder.yml', 'title: Manual\n')
    write('pages/manual/1-intro.md', body('Intro'))
    write('pages/manual/2-more.md', body('More', '[Intro](page:manual/intro)'))
    const report = await addVersion(root, { name: 'v1', folder: 'manual' })
    expect(has('pages/manual/v1/folder.yml')).toBe(true)
    expect(has('pages/manual/v1/page.yml')).toBe(false)
    expect(read('pages/manual/v1/2-more.md')).toContain('[Intro](page:manual/v1/intro)')
    const { pages } = await collectSiteContent(root)
    expect(pages.map((p) => p.route)).toEqual(expect.arrayContaining(['/manual/v1/intro', '/manual/v1/more']))
    expect(report.pages).toBeGreaterThanOrEqual(2)
  })

  it('a folder with content of its own has each page say it, and says why', async () => {
    write('pages/docs/1-landing.md', body('Landing'))
    const report = await addVersion(root, { name: 'v2', folder: 'docs' })
    expect(yaml.load(read('pages/docs/v2/start/page.yml')).seo).toEqual({ noindex: true })
    expect(has('pages/docs/v2/1-landing.md')).toBe(true)
    expect(report.notes.join(' ')).toMatch(/content of its own/)
  })
})

describe('where it goes', () => {
  it('the folder that already holds versions, with none named', async () => {
    await addVersion(root, { name: 'v1', folder: 'docs' })
    const report = await addVersion(root, { name: 'v2' })
    expect(report.folder).toBe('docs')
    expect(has('pages/docs/v2/start/page.yml')).toBe(true)
  })

  it('a later version leaves earlier ones out of its copy', async () => {
    await addVersion(root, { name: 'v1', folder: 'docs' })
    await addVersion(root, { name: 'v2', folder: 'docs' })
    expect(readdirSync(join(root, 'pages/docs/v2')).sort()).toEqual(['guide', 'moved', 'page.yml', 'start'])
  })

  it('`docs` with none named and none yet', async () => {
    expect((await addVersion(root, { name: 'v2' })).folder).toBe('docs')
  })

  it('a folder promoted to the homepage puts its copy at the root', async () => {
    rmSync(join(root, 'pages/home'), { recursive: true, force: true })
    rmSync(join(root, 'pages/about'), { recursive: true, force: true })
    write('site.yml', 'name: test\nindex: docs\n')
    write('pages/docs/start/1-start.md', body('Start', '[Guide](page:guide) and [home](page:/) and [path](/guide)'))
    write('pages/docs/guide/page.yml', 'id: guide\ntitle: Guide\norder: 2\n')

    const report = await addVersion(root, { name: 'v1' })
    expect(report).toMatchObject({ folder: 'docs', route: '/v1', pages: 3 })

    const text = read('pages/docs/v1/start/1-start.md')
    expect(text).toContain('[Guide](page:v1/guide)')
    expect(text).toContain('[home](page:v1)')
    expect(text).toContain('[path](/v1/guide)')

    const { pages } = await collectSiteContent(root)
    const routes = pages.map((p) => p.route)
    expect(routes).toEqual(expect.arrayContaining(['/', '/start', '/guide', '/v1', '/v1/start', '/v1/guide']))
    // A folder with no content stays a container, leading to its first page, here and in the copy.
    expect(pages.find((p) => p.route === '/').hasContent).toBe(false)
    expect(pages.find((p) => p.route === '/v1').hasContent).toBe(false)
  })

  it('the whole site, when asked', async () => {
    write('pages/home/page.yml', 'id: home\ntitle: Home\n')
    write('pages/home/1-hello.md', body('Home', '[About](page:about) and [Home](page:/)'))
    rmSync(join(root, 'pages/docs'), { recursive: true, force: true })
    const report = await addVersion(root, { name: 'v1', folder: '.' })
    expect(report).toMatchObject({ folder: '', route: '/v1', path: 'pages/v1', pages: 2 })
    const text = read('pages/v1/home/1-hello.md')
    expect(text).toContain('[About](page:v1/about)')
    expect(text).toContain('[Home](page:v1/home)')
    const { pages } = await collectSiteContent(root)
    expect(pages.map((p) => p.route)).toEqual(expect.arrayContaining(['/', '/about', '/v1/home', '/v1/about']))
    expect(pages.find((p) => p.route === '/').title).toBe('Home')
  })

  it('a homepage with pages of its own: they are at the root, and in the copy under its folder', async () => {
    rmSync(join(root, 'pages/docs'), { recursive: true, force: true })
    rmSync(join(root, 'pages/about'), { recursive: true, force: true })
    write('pages/home/install/page.yml', 'id: install\ntitle: Install\n')
    write('pages/home/install/1-install.md', body('Install', '[Home](page:/) and [path](/install)'))
    const report = await addVersion(root, { name: 'v1', folder: '.' })
    expect(report.pages).toBe(2)
    const text = read('pages/v1/home/install/1-install.md')
    expect(text).toContain('[Home](page:v1/home)')
    expect(text).toContain('[path](/v1/home/install)')
    const { pages } = await collectSiteContent(root)
    expect(pages.map((p) => p.route)).toEqual(expect.arrayContaining(['/', '/install', '/v1/home', '/v1/home/install']))
  })

  it('a mounted folder gets the copy in the mount', async () => {
    rmSync(join(root, 'pages/docs'), { recursive: true, force: true })
    write('site.yml', 'name: test\nindex: home\npaths:\n  pages/docs: external/docs\n')
    write('external/docs/start/page.yml', 'title: Start\n')
    write('external/docs/start/1-start.md', body('Start'))
    const report = await addVersion(root, { name: 'v1' })
    expect(report.route).toBe('/docs/v1')
    expect(has('external/docs/v1/start/page.yml')).toBe(true)
    expect(has('pages/docs/v1')).toBe(false)
    expect(report.notes.join(' ')).toMatch(/mounted/)
  })

  it('a translation by hand comes along, by route, and one by id becomes one by route', async () => {
    write('locales/freeform/es/page-ids/guide/guide.md', '---\n---\n\n# Guía\n\n[Inicio](page:start)\n')
    write('locales/freeform/es/pages/docs/start/start.md', '# Inicio\n')
    await addVersion(root, { name: 'v2', folder: 'docs' })
    expect(read('locales/freeform/es/pages/docs/v2/guide/guide.md')).toContain('[Inicio](page:docs/v2/start)')
    expect(has('locales/freeform/es/pages/docs/v2/start/start.md')).toBe(true)
    expect(has('locales/freeform/es/page-ids/guide/guide.md')).toBe(true)
  })
})

describe('what it refuses, writing nothing', () => {
  it.each(['2', 'latest', 'version2', 'v', ''])('the name %s', async (name) => {
    await expect(addVersion(root, { name, folder: 'docs' })).rejects.toThrow(/isn't a version's name/)
    expect(has('pages/docs/v2')).toBe(false)
  })

  it('suggests the name it probably meant', async () => {
    await expect(addVersion(root, { name: '2', folder: 'docs' })).rejects.toThrow(/Did you mean v2/)
  })

  it('a version that exists', async () => {
    await addVersion(root, { name: 'v2', folder: 'docs' })
    await expect(addVersion(root, { name: 'v2', folder: 'docs' })).rejects.toThrow(/already exists/)
  })

  it('a folder that does not', async () => {
    await expect(addVersion(root, { name: 'v2', folder: 'nope' })).rejects.toThrow(/no folder pages\/nope/)
  })

  it('a folder that is itself a version', async () => {
    await addVersion(root, { name: 'v1', folder: 'docs' })
    await expect(addVersion(root, { name: 'v2', folder: 'docs/v1' })).rejects.toThrow(/is a version/)
  })

  it('no way to tell which folder', async () => {
    rmSync(join(root, 'pages/docs'), { recursive: true, force: true })
    await expect(addVersion(root, { name: 'v2' })).rejects.toThrow(/--in <folder>/)
  })

  it('two folders that hold versions, with none named', async () => {
    write('pages/api/start/1-a.md', body('A'))
    await addVersion(root, { name: 'v1', folder: 'docs' })
    await addVersion(root, { name: 'v1', folder: 'api' })
    await expect(addVersion(root, { name: 'v2' })).rejects.toThrow(/More than one folder holds versions: docs, api/)
  })

  it('a dry run says what would happen, and writes nothing', async () => {
    const report = await addVersion(root, { name: 'v2', folder: 'docs', dryRun: true })
    expect(report).toMatchObject({ pages: 3, route: '/docs/v2' })
    expect(report.links).toBeGreaterThan(0)
    expect(has('pages/docs/v2')).toBe(false)
  })
})
