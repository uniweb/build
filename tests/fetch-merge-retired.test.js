/**
 * `merge:` on a fetch is RETIRED (2026-09-14) — refused whatever its value, on the
 * build and on the sync push, and never written back by a pull.
 *
 * It never combined anything reliably: the build holds no parsed tagged block for a
 * fetch to merge with, and the prerender asks each key once. A fetch fills the key it
 * names, and a tagged data block under a key the component declares fills it first.
 *
 * ⚠️ A site synced before the retirement carries `merge: false` on every section's
 * fetch in the stored document — the build's parse emitted it as a default — so the
 * pull is the path where a stale `merge` actually reaches a project file.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { collectSiteContent } from '../src/site/content-collector.js'
import { parseFetchConfig } from '../src/site/data-fetcher.js'
import { authorableDeclaration } from '../src/site/fetch-shapes.js'
import { siteProjectToDocument, siteContentDocumentToProject, sectionRecordToFile } from '../src/uwx/index.js'

let ROOT
const w = (rel, body, root = ROOT) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const quiet = async (fn) => {
  const saved = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    [console.log, console.warn] = saved
  }
}
const collect = () => quiet(() => collectSiteContent(ROOT, { strict: true }))
const frontmatterOf = (file) => yaml.load(readFileSync(file, 'utf8').split('---')[1])
const yamlOf = (file) => yaml.load(readFileSync(file, 'utf8'))

const RETIRED = /`merge:` is retired — a fetch fills the key it names, and a tagged data block under a key the component declares fills it first\. Delete the `merge:` line\./

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fetch-merge-'))
  w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\n')
  w('queries.yml', "team:\n  schema: '@/member'\n")
  // `about` sorts first, so it is the homepage and the rest keep their routes
  w('pages/about/about.md', '---\ntype: About\n---\n# About\n')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the build refuses `merge:` on any fetch, whatever its value', () => {
  it('on a section — naming the file', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nfetch:\n  query: team\n  merge: true\n---\n# Team\n')
    await expect(collect()).rejects.toThrow(/pages\/team\/1-grid\.md: `merge:` is retired/)
    await expect(collect()).rejects.toThrow(RETIRED)
  })

  it('`merge: false` too — the value never mattered', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nfetch:\n  query: team\n  merge: false\n---\n# Team\n')
    await expect(collect()).rejects.toThrow(RETIRED)
  })

  it('on a page.yml, and on one entry of a list', async () => {
    w('pages/team/page.yml', 'title: Team\nfetch:\n  - query: team\n  - query: team\n    as: others\n    merge: true\n')
    await expect(collect()).rejects.toThrow(/pages\/team\/page\.yml: `merge:` is retired/)
  })

  it('on site.yml', async () => {
    w('site.yml', 'name: t\nfoundation: "@acme/x@1.0.0"\nfetch:\n  query: team\n  merge: true\n')
    await expect(collect()).rejects.toThrow(/site\.yml: `merge:` is retired/)
  })

  it('without it the same fetch builds — and the parse emits no `merge` default', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nfetch:\n  query: team\n  limit: 3\n---\n# Team\n')
    const content = await collect()
    const grid = content.pages.find((p) => p.route === '/team').sections[0]
    expect(grid.fetch).toMatchObject({ query: 'team', as: 'team', limit: 3 })
    expect(grid.fetch).not.toHaveProperty('merge')
    expect(parseFetchConfig('team')).not.toHaveProperty('merge')
  })
})

describe('the sync push refuses what the build refuses', () => {
  it('on a section', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nfetch:\n  query: team\n  merge: true\n---\n# Team\n')
    await expect(quiet(() => siteProjectToDocument(ROOT))).rejects.toThrow(RETIRED)
  })

  it('on a page.yml', async () => {
    w('pages/team/page.yml', 'title: Team\nfetch:\n  query: team\n  merge: false\n')
    await expect(quiet(() => siteProjectToDocument(ROOT))).rejects.toThrow(/pages\/team\/page\.yml: `merge:` is retired/)
  })

  it('a section\'s fetch on the wire carries no `merge` — the parse emits no default', async () => {
    w('pages/team/1-grid.md', '---\ntype: Grid\nquery: team\n---\n# Team\n')
    const doc = await quiet(() => siteProjectToDocument(ROOT))
    expect(JSON.stringify(doc)).toContain('"query":"team"')
    expect(JSON.stringify(doc)).not.toContain('"merge"')
  })
})

describe('a pull never writes a stored `merge` back, whatever its value', () => {
  it('a declaration of names alone still becomes `query:`', () => {
    for (const merge of [true, false]) {
      expect(authorableDeclaration({ query: 'team', path: '/data/team.json', as: 'team', merge })).toEqual({ key: 'query', value: 'team' })
    }
  })

  it('a richer declaration keeps what the author wrote and drops `merge`', () => {
    const { key, value } = authorableDeclaration({ query: 'team', path: '/data/team.json', as: 'team', limit: 3, merge: true })
    expect(key).toBe('fetch')
    expect(value).toEqual({ query: 'team', as: 'team', limit: 3 })
  })

  it('a section file and a page.yml projected from a stored document hold no `merge`', async () => {
    const record = { type: 'Grid', content: null, fetch: { query: 'team', path: '/data/team.json', as: 'team', limit: 3, merge: true } }
    const section = join(ROOT, 'grid.md')
    sectionRecordToFile({ filePath: section, record })
    expect(frontmatterOf(section).fetch).toEqual({ query: 'team', as: 'team', limit: 3 })

    w('pages/team/page.yml', 'title: Team\nquery: team\n')
    const doc = await quiet(() => siteProjectToDocument(ROOT))
    const team = doc.pages.find((p) => (p.slug?.en ?? p.slug) === 'team')
    team.fetch = { ...team.fetch, merge: true }
    const fresh = mkdtempSync(join(tmpdir(), 'fetch-merge-pull-'))
    try {
      mkdirSync(join(fresh, 'pages'), { recursive: true })
      siteContentDocumentToProject({ document: doc, siteRoot: fresh })
      const pulled = yamlOf(join(fresh, 'pages/team/page.yml'))
      expect(pulled).toMatchObject({ query: 'team' })
      expect(readFileSync(join(fresh, 'pages/team/page.yml'), 'utf8')).not.toContain('merge')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})
