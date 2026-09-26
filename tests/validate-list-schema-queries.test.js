// ⭐ A QUERY OVER A LIST SCHEMA DELIVERS ITS ENTITIES — each a whole list — and is checked so.
//
// `menus: { schema: '@/menu' }` over `records/menu/*.yml`, each file one menu holding `items:`.
// Until 2026-09-26 the query's records were checked as ONE menu's items, so every such query failed
// ("missing required field '[0].label'") — and a push, which gates on this check, stopped.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'

let root
afterEach(() => root && rmSync(root, { recursive: true, force: true }))
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

async function check(menuFile) {
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-list-query-'))
  const foundation = join(root, 'foundation')
  const site = join(root, 'site')
  write(join(foundation, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundation, 'main.js'), 'export default {}\n')
  write(
    join(foundation, 'schemas', 'menu.yml'),
    'name: menu\nsections:\n  items:\n    many: true\n    fields:\n      label: { type: string, required: true }\n      href: { type: string }\n'
  )
  write(join(foundation, 'sections', 'Menu', 'meta.js'), "export default { title: 'Menu', data: { menus: '@/menu' } }\n")
  write(join(site, 'site.yml'), 'name: fixture\nfoundation: foundation\nqueries:\n  menus:\n    schema: "@/menu"\n')
  write(join(site, 'package.json'), JSON.stringify({ name: 'site', dependencies: { foundation: 'file:../foundation' } }))
  write(join(site, 'records', 'menu', 'main.yml'), menuFile)
  write(join(site, 'pages', 'home', 'page.yml'), 'title: Home\n')
  write(join(site, 'pages', 'home', 'menu.md'), '---\ntype: Menu\nquery: menus\n---\n')
  return validateDataInputs({ siteRoot: site, foundationPath: foundation })
}

describe('a query over a schema whose root is a list', () => {
  it('⭐ checks each record it delivers as one menu', async () => {
    const report = await check('items:\n  - label: Home\n    href: /\n  - label: About\n    href: /about\n')
    expect(report.violations).toEqual([])
    expect(report.setupErrors).toEqual([])
  })

  it('CONTROL — a menu missing a required label is still found', async () => {
    const report = await check('items:\n  - href: /\n')
    expect(report.violations.map((v) => v.message)).toContain("missing required field 'items[0].label'")
  })
})
