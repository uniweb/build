import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'

/**
 * A section that reads a key nobody delivers is reported at BUILD time.
 *
 * ## What it was like without this
 *
 * `flows` measured it in a real browser on a published site: two records-backed
 * sections rendering their headings and nothing beneath — **8 and 6 characters of
 * text**, against 182/572/289/529/99 for the static sections beside them. Still
 * absent 8 seconds after hydration.
 *
 * ⛔ **And no diagnostic anywhere.** Clean console across three pages, no build
 * warning, HTTP 200 throughout, a successful build, the rest of the page correct.
 * Their words, asked while they believed the fault was theirs: *"whoever is wrong
 * here — us or the product — a person wiring records for the first time is told
 * nothing at all."*
 *
 * The cause was a name: the section's `meta.js` declared `data: { team: … }` and
 * the page delivered a query called `members`. Nothing joins those, and nothing
 * noticed they failed to.
 *
 * ## ⚖️ Why the check is narrow
 *
 * A section may declare keys and legitimately receive nothing. So this fires only when
 * the page delivered SOMETHING and none of it fills a key the section reads — not by
 * name, and not by schema (automatic `as`, 2026-09-14): there the author demonstrably
 * intended data to arrive, and only the names failed to meet. The quiet cases below are
 * as much the contract as the loud one.
 */

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-unread-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A site with one page, one section of type `Team`, and one query.
 * `metaKey` is what the section reads; `queryName` is what the page delivers.
 */
function site({ metaKey, queryName, querySchema = null, record = 'name: Ada\n' }) {
  const siteRoot = join(root, 'site')
  const fdn = join(root, 'src')

  mkdirSync(join(fdn, 'sections', 'Team'), { recursive: true })
  writeFileSync(join(fdn, 'main.js'), 'export const vars = {}\n')
  writeFileSync(
    join(fdn, 'sections', 'Team', 'meta.js'),
    `export default { data: { ${metaKey}: '@/member' } }\n`
  )
  writeFileSync(
    join(fdn, 'sections', 'Team', 'index.jsx'),
    'export default function Team() { return null }\n'
  )
  writeFileSync(join(fdn, 'package.json'), JSON.stringify({ name: 'src', main: './_entry.generated.js' }))
  // `@/member` resolves to the foundation's own `schemas/member.yml`.
  mkdirSync(join(fdn, 'schemas'), { recursive: true })
  writeFileSync(join(fdn, 'schemas', 'member.yml'), 'fields:\n  name:\n    type: string\n')

  mkdirSync(join(siteRoot, 'records', 'member'), { recursive: true })
  writeFileSync(join(siteRoot, 'records', 'member', 'ada.yml'), record)
  const decl = querySchema ? `{ schema: '${querySchema}' }` : '{}'
  writeFileSync(join(siteRoot, 'site.yml'), `name: t\nqueries:\n  ${queryName}: ${decl}\n`)

  const page = join(siteRoot, 'pages', 'home')
  mkdirSync(page, { recursive: true })
  writeFileSync(join(page, 'page.yml'), `query: ${queryName}\n`)
  writeFileSync(join(page, 'index.md'), `---\ntype: Team\n---\n\n# Team\n`)

  return { siteRoot, foundationPath: fdn }
}

const unread = (r) => r.setupErrors.filter((e) => /render with no data/.test(e.message))

describe('a section reading a key the page does not deliver', () => {
  it('⭐ is reported — the case flows measured in a browser', async () => {
    // meta.js reads `team`; the page delivers `members`.
    const report = await validateDataInputs(site({ metaKey: 'team', queryName: 'members' }))
    expect(unread(report).length).toBe(1)
  })

  it('names both sides, because the fix is to make one match the other', async () => {
    const [err] = unread(await validateDataInputs(site({ metaKey: 'team', queryName: 'members' })))
    expect(err.message).toContain('content.data.team')
    expect(err.message).toContain('`members`')
  })

  it('says what happens if it is ignored', async () => {
    // A diagnostic that names a mismatch without naming its consequence leaves the
    // reader to decide whether it matters. This one had a visitor at the end of it.
    const [err] = unread(await validateDataInputs(site({ metaKey: 'team', queryName: 'members' })))
    expect(err.message).toMatch(/nothing else will say so/)
  })
})

describe('⛔ and it stays quiet where silence is correct', () => {
  it('CONTROL — matching names report nothing', async () => {
    // The control that makes the case above mean something: same fixture, one
    // name changed.
    const report = await validateDataInputs(site({ metaKey: 'members', queryName: 'members' }))
    expect(unread(report)).toEqual([])
  })

  it('⭐ a query of the key\'s schema fills it under another name — automatic `as` — and nothing is reported (2026-09-14)', async () => {
    // meta.js reads `team: '@/member'`; the page delivers `members`, a query over `@/member`.
    const report = await validateDataInputs(site({ metaKey: 'team', queryName: 'members', querySchema: '@/member' }))
    expect(unread(report)).toEqual([])
  })

  it('and what fills the key is checked against the key\'s schema', async () => {
    const report = await validateDataInputs(site({ metaKey: 'team', queryName: 'members', querySchema: '@/member', record: 'name: 42\n' }))
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].users).toEqual([{ route: '/', section: 'Team', key: 'team' }])
  })

  it('a page that delivers NO data is not flagged', async () => {
    // A section declaring keys on a page with no fetch at all is ordinary — flagging it
    // would make the check fire on correct sites, which is how a warning gets ignored.
    const { siteRoot, foundationPath } = site({ metaKey: 'team', queryName: 'members' })
    writeFileSync(join(siteRoot, 'pages', 'home', 'page.yml'), 'title: Home\n')
    const report = await validateDataInputs({ siteRoot, foundationPath })
    expect(unread(report)).toEqual([])
  })
})
