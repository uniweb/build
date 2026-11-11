// ⭐ A site that declares no queries still has its records checked: every file in the records
// directory is a record a push sends, so a folder whose data schema resolves to nothing stops the
// build and `uniweb validate`, as it stops the push. ⛔ Until 2026-11-11 both returned at once for a
// site with no queries — measured with uniweb 1.34.1 on a fresh starter holding
// `records/testimonials/claude.md`: the build exited 0, validate said "All data conforms", and
// `push --dry-run` refused the folder.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { processQueries } from '../src/site/query-processor.js'
import { validateDataInputs } from '../src/validate-data.js'

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

let root
let foundationPath
let siteRoot

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-no-queries-'))
  foundationPath = join(root, 'foundation')
  siteRoot = join(root, 'site')
  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), 'export default {}\n')
  write(join(foundationPath, 'schemas', 'member.yml'), 'name: member\nfields:\n  name: { type: string, required: true }\n')
  write(join(foundationPath, 'sections', 'Hero', 'meta.js'), "export default { title: 'Hero' }\n")
  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'home', 'page.yml'), 'title: Home\n')
})

afterEach(() => root && rmSync(root, { recursive: true, force: true }))

const quietly = async (fn) => {
  const spies = ['log', 'warn'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
  try {
    return await fn()
  } finally {
    for (const s of spies) s.mockRestore()
  }
}

describe('records no query reads', () => {
  it('a folder with no data schema stops the build, naming the standard type that fits', async () => {
    write(join(siteRoot, 'records', 'testimonials', 'claude.md'), '---\nquote: It just works.\nname: Claude\n---\n')
    await expect(quietly(() => processQueries(siteRoot, undefined, 'records'))).rejects.toThrow(
      /Every record needs a data schema[\s\S]*records\/testimonials\/ — @\/testimonials — a standard type fits: @std\/testimonial/
    )
  })

  it('…and stops `uniweb validate`, which compiles through the same step', async () => {
    write(join(siteRoot, 'records', 'testimonials', 'claude.md'), '---\nquote: It just works.\nname: Claude\n---\n')
    await expect(quietly(() => validateDataInputs({ siteRoot, foundationPath }))).rejects.toThrow(/records\/testimonials\/ — @\/testimonials/)
  })

  it('records with their schema compile nothing, and are checked', async () => {
    write(join(siteRoot, 'records', 'member', 'ada.yml'), 'name: Ada\norder: 3\n')
    expect(await quietly(() => processQueries(siteRoot, undefined, 'records'))).toEqual({})
    const report = await quietly(() => validateDataInputs({ siteRoot, foundationPath }))
    expect(report.violations.map((v) => `${v.file} ${v.field}:${v.rule}`)).toEqual(['records/member/ada.yml order:undeclared'])
  })

  it('a site with no records directory and no queries does nothing', async () => {
    expect(await quietly(() => processQueries(siteRoot, undefined, 'records'))).toEqual({})
  })
})
