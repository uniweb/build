/**
 * ⭐ A RECORD KEPT IN A BIBTEX FILE IS NOT WRITTEN AGAIN BESIDE IT.
 *
 * Measured 2026-09-25 on the `international` template: its four team members lived in one
 * `records/team/team.json`, and a pull into the copy that pushed them wrote each again as a file of
 * its own beside the list — so the next push held every member twice, and refused. ⛔ A JSON or YAML
 * list is no record's home since 2026-09-27 — a file holds one record (`site/record-file.js`) — so
 * a BibTeX file is the one file of several records a pull finds a record in.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordsToProject } from '../src/uwx/index.js'

let SITE
afterEach(() => SITE && rmSync(SITE, { recursive: true, force: true }))

const MEMBER = { name: '@acme/member', sections: { member: { brief: true, fields: { name: { type: 'string' }, role: { type: 'string' } } } } }
const ref = (name, entity) => ({ kind: 'ref', name, entry: { schema: '@acme/member', entity } })

function site(files) {
  SITE = mkdtempSync(join(tmpdir(), 'uwx-pull-list-'))
  writeFileSync(join(SITE, 'site.yml'), 'name: Site\n')
  for (const [rel, body] of Object.entries(files)) {
    const p = join(SITE, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
}

const pull = (recordDocs, names) =>
  recordsToProject({
    folderDoc: { contents: names.map(([name, uuid]) => ref(name, uuid)) },
    recordDocs,
    siteRoot: SITE,
    opts: { resolveDeclaration: () => MEMBER, scope: '@acme' },
  })

describe('pull — a record kept in a BibTeX file', () => {
  it('a BibTeX file is kept as the author has it, and said once — never a second copy beside it', () => {
    const bib = '@article{wei,\n  $uuid = {U1},\n  title = {Birds}\n}\n'
    site({ 'records/member/refs.bib': bib })
    const report = pull([{ $uuid: 'U1', $schema: '@acme/member', member: { name: 'Wei Zhang' } }], [['wei', 'U1']])
    expect(readdirSync(join(SITE, 'records/member'))).toEqual(['refs.bib'])
    expect(readFileSync(join(SITE, 'records/member/refs.bib'), 'utf8')).toBe(bib)
    expect(report.warnings.filter((w) => w.includes('refs.bib'))).toHaveLength(1)
  })

  it('CONTROL — a record in no file is placed as a file of its own, as before', () => {
    site({ 'records/member/.keep': '' })
    const report = pull([{ $uuid: 'U3', $schema: '@acme/member', member: { name: 'Ana' } }], [['ana', 'U3']])
    expect(existsSync(join(SITE, 'records/member/ana.yml')) || existsSync(join(SITE, 'records/member/ana.json'))).toBe(true)
    expect(report.placed).toHaveLength(1)
  })
})
