// ⭐ A schema whose ROOT IS A LIST is checked wherever its data is in the project.
//
// Until 2026-09-24 `validate` checked data one record at a time, and a list schema is
// not one record, so it gave up: a section fed by a query was reported as deferred, and
// a records folder governed by such a schema was skipped without a word. Neither had a
// reason. A query's records ARE the list the section's key receives, and an entity of a
// list schema holds its list under the section's key — both checkable, and now checked.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'
import { queryDataUrl } from '@uniweb/core'

let root
let siteRoot
let foundationPath
let report

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-lists-'))
  foundationPath = join(root, 'foundation')
  siteRoot = join(root, 'site')

  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), 'export default {}\n')
  // A link record — `label` optional here, so the record files themselves are clean.
  write(join(foundationPath, 'schemas', 'link.yml'), 'name: link\nfields:\n  label: { type: string }\n  href: { type: string }\n')
  // A LIST: one `many` section. The section's component declares its key with it.
  write(
    join(foundationPath, 'schemas', 'menu.yml'),
    'name: menu\nsections:\n  items:\n    many: true\n    fields:\n      label: { type: string, required: true }\n      href: { type: string }\n'
  )
  write(join(foundationPath, 'sections', 'Menu', 'meta.js'), "export default { title: 'Menu', data: { links: '@/menu' } }\n")

  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\nqueries:\n  links:\n    schema: "@/link"\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'home', 'page.yml'), 'title: Home\n')
  write(join(siteRoot, 'pages', 'home', 'menu.md'), '---\ntype: Menu\nquery: links\n---\n\n# Menu\n')
  write(join(siteRoot, 'records', 'link', 'home.yml'), 'label: Home\nhref: /\n')
  write(join(siteRoot, 'records', 'link', 'about.yml'), 'href: /about\n')
  // An entity of the list schema itself, written by section: its list under `items`.
  write(join(siteRoot, 'records', 'menu', 'main.yml'), 'items:\n  - label: Home\n    href: /\n  - href: /x\n')

  report = await validateDataInputs({ siteRoot, foundationPath })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const found = () => report.violations.map((v) => `${v.file} ${v.item} ${v.field}:${v.rule}`).sort()

describe('validateDataInputs — a schema whose root is a list', () => {
  it("checks a query's records as the list the section's key receives, and a list entity by section", () => {
    expect(found()).toEqual(
      [
        // `about` has no label: fine as a link, not as an item of the menu the section declares.
        `${queryDataUrl('links')} about label:required`,
        'records/menu/main.yml main items[1].label:required',
      ].sort()
    )
  })

  it('defers nothing', () => {
    expect(report.deferred).toEqual([])
  })

  it('counts each record it checked', () => {
    // 2 links as the menu's list + the same 2 as links (their files) + 1 menu entity.
    expect(report.summary.records).toBe(5)
    expect(report.summary.schemas).toBe(2)
  })
})
