/**
 * ⭐ `nest:` BESIDE AN EXPLICIT `sections:` LIST — the build applies `nest:` after the list, in
 * every list form (`processNesting`), and the docs say so: "`nest:` wins" and "this works with all
 * section modes" (`docs/reference/page-configuration.md`).
 *
 * ⛔ Until 2026-10-23 the push read an explicit list as authoritative for nesting and ignored
 * `nest:`, so a page that lists its sections and nests a figure under each pushed none of the
 * figures; a pull then deleted their `@` files, absent from the document. And the pull compared the
 * author's list without its `nest:`, so it rewrote both into one inclusive list on every pull.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-sections-nest-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

const snapshot = () => {
  const files = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.uniweb') continue
      if (statSync(p).isDirectory()) walk(p)
      else files[relative(ROOT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(ROOT)
  return files
}

const page = (sections) => {
  w('site.yml', 'name: test-site\nfoundation: "@acme/base@1.0.0"\nindex: home\n')
  w('pages/home/page.yml', `title: Home\nsections: ${sections}\nnest:\n  sync: [sync-figure]\n  cloud: [cloud-figure]\n`)
  w('pages/home/hero.md', '# Hi\n')
  w('pages/home/sync.md', '# Sync\n')
  w('pages/home/cloud.md', '# Cloud\n')
  w('pages/home/@sync-figure.md', '# Sync figure\n')
  w('pages/home/@cloud-figure.md', '# Cloud figure\n')
}
const tree = (sections) =>
  (sections || []).map((s) => {
    const children = s.subsections || s.$children
    return children?.length ? { [s.stableId || s.$id]: tree(children) } : s.stableId || s.$id
  })

for (const [form, list] of [['strict', '[hero, sync, cloud]'], ['inclusive', '[hero, sync, cloud, ...]']]) {
  describe(`a ${form} list with \`nest:\``, () => {
    it('the push nests what the build nests', async () => {
      page(list)
      const built = (await collectSiteContent(ROOT, {})).pages.find((p) => p.route === '/')
      const doc = await siteProjectToDocument(ROOT)

      const expected = ['hero', { sync: ['sync-figure'] }, { cloud: ['cloud-figure'] }]
      expect(tree(built.sections)).toEqual(expected)
      expect(tree(doc.pages.find((p) => p.$id === 'home').page_sections)).toEqual(expected)
    })

    it('a pull of what was pushed keeps the list, the `nest:` and the `@` files as written', async () => {
      page(list)
      const before = snapshot()

      const doc = await siteProjectToDocument(ROOT)
      siteContentDocumentToProject({ document: doc, siteRoot: ROOT, prune: true })

      const after = snapshot()
      for (const file of ['pages/home/page.yml', 'pages/home/@sync-figure.md', 'pages/home/@cloud-figure.md']) {
        expect(after[file], file).toBe(before[file])
      }
    })
  })
}

it('CONTROL — a nesting changed on the backend comes back as a list, and the `nest:` that would override it goes', async () => {
  page('[hero, sync, cloud]')
  const doc = await siteProjectToDocument(ROOT)
  const home = doc.pages.find((p) => p.$id === 'home')
  // The figure moved from `cloud` to `sync`.
  const cloud = home.page_sections.find((s) => s.$id === 'cloud')
  const sync = home.page_sections.find((s) => s.$id === 'sync')
  sync.$children.push(...cloud.$children)
  delete cloud.$children

  siteContentDocumentToProject({ document: doc, siteRoot: ROOT, prune: true })

  const yml = yaml.load(readFileSync(join(ROOT, 'pages/home/page.yml'), 'utf8'))
  expect(yml.nest).toBeUndefined()
  expect(yml.sections).toEqual(['hero', { sync: ['sync-figure', 'cloud-figure'] }, 'cloud', '...'])
})
