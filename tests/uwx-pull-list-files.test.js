/**
 * ⭐ A RECORD KEPT IN A LIST FILE IS PULLED BACK INTO ITS ENTRY.
 *
 * Measured 2026-09-25 on the `international` template: its four team members live in one
 * `records/team/team.json`, and a pull into the copy that pushed them wrote each again as a file of
 * its own beside the list — so the next push held every member twice, and refused.
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

describe('pull — a record kept in a list file', () => {
  it('⭐ a JSON list: the record is written into its entry, the others untouched, no file beside it', () => {
    site({
      'records/member/members.json': JSON.stringify(
        [
          { $uuid: 'U1', slug: 'wei', name: 'Wei', role: 'Lead' },
          { $uuid: 'U2', slug: 'lin', name: 'Lin', role: 'Field' },
        ],
        null,
        2
      ) + '\n',
    })
    const report = pull(
      [
        { $uuid: 'U1', $schema: '@acme/member', member: { name: 'Wei Zhang', role: 'Lead' } },
        { $uuid: 'U2', $schema: '@acme/member', member: { name: 'Lin', role: 'Field' } },
      ],
      [['wei', 'U1'], ['lin', 'U2']]
    )
    expect(readdirSync(join(SITE, 'records/member'))).toEqual(['members.json'])
    expect(JSON.parse(readFileSync(join(SITE, 'records/member/members.json'), 'utf8'))).toEqual([
      { $uuid: 'U1', slug: 'wei', name: 'Wei Zhang', role: 'Lead' },
      { $uuid: 'U2', slug: 'lin', name: 'Lin', role: 'Field' },
    ])
    expect(report.placed).toEqual([])
    expect(report.skipped).toEqual([])
  })

  it('a YAML list, the same', () => {
    site({ 'records/member/members.yml': '- $uuid: U1\n  slug: wei\n  name: Wei\n' })
    pull([{ $uuid: 'U1', $schema: '@acme/member', member: { name: 'Wei Zhang' } }], [['wei', 'U1']])
    expect(readdirSync(join(SITE, 'records/member'))).toEqual(['members.yml'])
    expect(readFileSync(join(SITE, 'records/member/members.yml'), 'utf8')).toBe('- $uuid: U1\n  slug: wei\n  name: Wei Zhang\n')
  })

  it('a BibTeX file is kept as the author has it, and said once — never a second copy beside it', () => {
    const bib = '@article{wei,\n  $uuid = {U1},\n  title = {Birds}\n}\n'
    site({ 'records/member/refs.bib': bib })
    const report = pull([{ $uuid: 'U1', $schema: '@acme/member', member: { name: 'Wei Zhang' } }], [['wei', 'U1']])
    expect(readdirSync(join(SITE, 'records/member'))).toEqual(['refs.bib'])
    expect(readFileSync(join(SITE, 'records/member/refs.bib'), 'utf8')).toBe(bib)
    expect(report.warnings.filter((w) => w.includes('refs.bib'))).toHaveLength(1)
  })

  it('CONTROL — a record in no file is placed as a file of its own, as before', () => {
    site({ 'records/member/members.json': '[]\n' })
    const report = pull([{ $uuid: 'U3', $schema: '@acme/member', member: { name: 'Ana' } }], [['ana', 'U3']])
    expect(existsSync(join(SITE, 'records/member/ana.yml')) || existsSync(join(SITE, 'records/member/ana.json'))).toBe(true)
    expect(report.placed).toHaveLength(1)
  })
})
