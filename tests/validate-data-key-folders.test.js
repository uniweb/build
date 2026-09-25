// ⭐ A records folder named for a data key the foundation types — and no data schema has its
// name — holds records of that type, and `validate` checks them against it, the way a push sends
// them [Diego, 2026-09-25]. Until then such a folder was left out in silence: an app's invoices,
// typed `invoices: '@/invoice'` in the foundation's main.js, were checked against nothing.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

let root
afterEach(() => root && rmSync(root, { recursive: true, force: true }))

async function validate({ typed }) {
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-keys-'))
  const foundationPath = join(root, 'foundation')
  const siteRoot = join(root, 'site')
  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  // The key is the FOUNDATION's own (`main.js` `data:`), which reaches every section.
  write(join(foundationPath, 'main.js'), `export default { data: { invoices: ${typed ? "'@/invoice'" : '{}'} } }\n`)
  write(join(foundationPath, 'schemas', 'invoice.yml'), 'name: invoice\nfields:\n  number: { type: string, required: true }\n  issued: { type: date }\n')
  write(join(foundationPath, 'sections', 'Invoice', 'meta.js'), "export default { title: 'Invoice' }\n")
  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\nqueries:\n  invoices: {}\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'home', 'page.yml'), 'title: Home\n')
  write(join(siteRoot, 'records', 'invoices', 'one.yml'), 'number: INV-1\nissued: 2026-01-15\n')
  write(join(siteRoot, 'records', 'invoices', 'two.yml'), 'number: INV-2\nissued: mid-January\n')
  return validateDataInputs({ siteRoot, foundationPath })
}

describe('validateDataInputs — a folder named for a typed data key', () => {
  it('checks its records against the key’s type', async () => {
    const report = await validate({ typed: true })
    expect(report.violations.map((v) => `${v.file} ${v.schema} ${v.field}:${v.rule}`)).toEqual([
      'records/invoices/two.yml @/invoice issued:format',
    ])
    expect(report.summary.records).toBe(2)
  })

  it('CONTROL — an untyped key names no schema: the folder is left out, as before', async () => {
    const report = await validate({ typed: false })
    expect(report.violations).toEqual([])
    expect(report.summary.records).toBe(0)
  })
})
