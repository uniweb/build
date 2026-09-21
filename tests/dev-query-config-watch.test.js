/**
 * The dev server regenerates the query files when what DEFINES them changes — `queries.yml`,
 * `records.yml`, or the `queries:` of `site.yml` — not only when a record does.
 *
 * ⛔ Until 2026-09-14 it watched `records/` alone, and it captured the query list once, at
 * startup. Editing `queries.yml` or `records.yml` changed nothing in `public/data/` until the
 * server was restarted, and a `site.yml` edit re-collected the pages but left every query
 * file as it was — so a query added or narrowed, or a record moved to a folder, looked like
 * it had not worked.
 *
 * These drive the plugin itself — `configResolved`, `buildStart`, `configureServer` — with
 * real file watchers, and read what lands on disk.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentPlugin, siteRootChange } from '../src/site/plugin.js'

let ROOT
let plugin
let sent
let saved

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const titles = (name) => {
  const file = join(ROOT, 'public/data', `${name}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).map((r) => r.title) : null
}
// The folder each compiled record sits in, by title — what `records.yml` decides.
const paths = (name) => {
  const file = join(ROOT, 'public/data', `${name}.json`)
  return existsSync(file) ? Object.fromEntries(JSON.parse(readFileSync(file, 'utf8')).map((r) => [r.title, r.path])) : null
}
const settle = (ms) => new Promise((done) => setTimeout(done, ms))

async function startDev() {
  plugin = siteContentPlugin({ sitePath: './' })
  await plugin.configResolved({ root: ROOT, publicDir: join(ROOT, 'public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
  await plugin.buildStart()
  sent = []
  plugin.configureServer({ ws: { send: (message) => sent.push(message) }, middlewares: { use: () => {} } })
  // Let the watchers deliver whatever the setup's own writes produced, then start counting.
  await settle(400)
  sent.length = 0
}

const reloaded = () => sent.some((m) => m?.type === 'full-reload')
const WAIT = { timeout: 5000, interval: 50 }

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'dev-query-watch-'))
  saved = [console.log, console.warn, console.error]
  console.log = () => {}
  console.warn = () => {}
  w('site.yml', 'name: t\n')
  w('pages/home/1-hero.md', '---\ntype: Hero\n---\n# Home\n')
  w('records/article/a.md', '---\ntitle: A\n---\n')
  w('records/article/b.md', '---\ntitle: B\n---\n')
})
afterEach(() => {
  plugin?.closeBundle()
  plugin = null
  ;[console.log, console.warn, console.error] = saved
  rmSync(ROOT, { recursive: true, force: true })
})

describe('what a change at the site root asks the dev server to redo', () => {
  it('names the three files that define the query files, and what else it reads', () => {
    expect(siteRootChange('queries.yml')).toBe('queries')
    expect(siteRootChange('site.yml')).toBe('queries')
    expect(siteRootChange('records.yml')).toBe('records')
    expect(siteRootChange('theme.yml')).toBe('content')
    expect(siteRootChange('head.html')).toBe('content')
    // CONTROL — a file the dev server does not read, an editor's swap file, and no name
    expect(siteRootChange('package.json')).toBeNull()
    expect(siteRootChange('.queries.yml.swp')).toBeNull()
    expect(siteRootChange(null)).toBeNull()
  })
})

describe('the dev server regenerates the query files', { timeout: 15000 }, () => {
  it('when queries.yml changes — with the new query list', async () => {
    w('queries.yml', "recent:\n  schema: '@/article'\n  where: { title: A }\n")
    await startDev()
    expect(titles('recent')).toEqual(['A'])

    w('queries.yml', "recent:\n  schema: '@/article'\nnewest:\n  schema: '@/article'\n  sort: title desc\n")
    await vi.waitFor(() => {
      expect(titles('recent')).toEqual(['A', 'B'])
      expect(titles('newest')).toEqual(['B', 'A'])
      expect(reloaded()).toBe(true)
    }, WAIT)
  })

  it('when records.yml changes — and when it is created after the server started', async () => {
    // `records.yml` decides which folder each record sits in, never whether it is one:
    // every file in `records/` is compiled, so what moves is each record's `path`.
    w('queries.yml', "recent:\n  schema: '@/article'\n")
    await startDev()
    expect(paths('recent')).toEqual({ A: '', B: '' })

    w('records.yml', '- folder: archive\n  records:\n    - article/a.md\n')
    await vi.waitFor(() => {
      expect(paths('recent')).toEqual({ A: 'archive', B: '' })
      expect(reloaded()).toBe(true)
    }, WAIT)

    w('records.yml', '- folder: archive\n  records:\n    - article/*.md\n')
    await vi.waitFor(() => expect(paths('recent')).toEqual({ A: 'archive', B: 'archive' }), WAIT)
  })

  it('when the `queries:` of site.yml changes', async () => {
    w('site.yml', "name: t\nqueries:\n  posts:\n    schema: '@/article'\n")
    await startDev()
    expect(titles('posts')).toEqual(['A', 'B'])
    expect(titles('featured')).toBeNull()

    w('site.yml', "name: t\nqueries:\n  posts:\n    schema: '@/article'\n  featured:\n    schema: '@/article'\n    where: { title: B }\n")
    await vi.waitFor(() => {
      expect(titles('featured')).toEqual(['B'])
      expect(reloaded()).toBe(true)
    }, WAIT)
  })

  it('CONTROL — an entity change still regenerates, as it always did', async () => {
    w('queries.yml', "recent:\n  schema: '@/article'\n")
    await startDev()
    w('records/article/c.md', '---\ntitle: C\n---\n')
    await vi.waitFor(() => expect(titles('recent')).toEqual(['A', 'B', 'C']), WAIT)
  })
})
