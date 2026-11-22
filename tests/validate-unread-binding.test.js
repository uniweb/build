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

  // ⛔ Reported until 2026-10-28: a concept block is read from its fence in the section, never
  // from a fetch, so a page's query that feeds another section had not failed to reach it.
  it('a concept block it reads (`md:<tag>`) is not one the page should fill', async () => {
    const report = await validateDataInputs(site({ metaKey: "'md:prompt'", queryName: 'members' }))
    expect(unread(report)).toEqual([])
  })

  it('…while a key beside one is still reported, alone', async () => {
    const [err, ...rest] = unread(await validateDataInputs(site({ metaKey: "'md:prompt': 'Prompt', team", queryName: 'members' })))
    expect(rest).toEqual([])
    expect(err.message).toContain('section reads content.data.team,')
    expect(err.message).not.toContain('content.data.prompt')
  })

  // ⛔ Reported until 2026-11-11, on every publish of a site whose blog page queries its articles: its
  // Hero declares the words it draws itself (`labels`, each with a `default:`), which an author
  // overrides with a ```yaml:labels block, and with none it shows the type's own. It renders
  // without data, so a page's query that feeds another section had not failed to reach it.
  const LABELS = "labels: { copy: { type: 'string', default: 'Copy' }, copied: { type: 'string', default: 'Copied' } }"
  const metaOf = (built, data) =>
    writeFileSync(join(built.foundationPath, 'sections', 'Team', 'meta.js'), `export default { data: { ${data} } }\n`)

  it('a section\'s own words — an inline shape whose every field gives a `default:` — are not ones the page should fill', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, LABELS)
    expect(unread(await validateDataInputs(built))).toEqual([])
  })

  it('…in the form shape too', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, "labels: { fields: [{ name: 'copy', type: 'string', default: 'Copy' }] }")
    expect(unread(await validateDataInputs(built))).toEqual([])
  })

  it('…while a key beside them is still reported, alone', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, `${LABELS}, team: '@/member'`)
    const [err, ...rest] = unread(await validateDataInputs(built))
    expect(rest).toEqual([])
    expect(err.message).toContain('section reads content.data.team,')
    expect(err.message).not.toContain('content.data.labels')
  })

  it('…with some of them empty by default, as a second line or a mark an author may add', async () => {
    // ⛔ Reported until 2026-11-22: every default had to show, so a section whose words held one
    // empty by default (a thank-you's second line) counted as data the page should fill.
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, "labels: { sent: { type: 'string', default: 'Thank you' }, sentText: { type: 'string', default: '' }, required: { type: 'string', default: '' } }")
    expect(unread(await validateDataInputs(built))).toEqual([])
  })

  it('CONTROL — blank defaults are not words: a key whose fields all default to `\'\'` or `null` is reported', async () => {
    // An older way to declare a key a fetch fills: an editor pre-fills it empty, and the section
    // has nothing of its own to show.
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, "articles: { title: { type: 'string', default: '' }, content: { type: 'richtext', default: null } }")
    const [err] = unread(await validateDataInputs(built))
    expect(err.message).toContain('section reads content.data.articles,')
  })

  // ⛔ Reported until 2026-11-22: a key typed by a block type (a data schema that is not linkable, as
  // `@std/overlay` is) is filled by the section's own block, never by a query, since a Model's
  // unlinkable entries are in no site's folder. A Hero that can carry a picture's words, on a blog
  // page that queries its articles, reported it.
  const blockSchema = (built, linkable) =>
    writeFileSync(
      join(built.foundationPath, 'schemas', 'caption.yml'),
      `${linkable === false ? 'linkable: false\n' : ''}fields:\n  text:\n    type: string\n`
    )

  it('a block type\'s key, its schema not linkable, is not one the page should fill', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    blockSchema(built, false)
    metaOf(built, "caption: { schema: '@/caption', single: true }")
    expect(unread(await validateDataInputs(built))).toEqual([])
  })

  it('CONTROL — the same key typed by a linkable schema is reported', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    blockSchema(built, true)
    metaOf(built, "caption: { schema: '@/caption', single: true }")
    const [err] = unread(await validateDataInputs(built))
    expect(err.message).toContain('section reads content.data.caption,')
  })

  it('CONTROL — an inline shape with a field that gives no `default:` holds data the page may be meant to fill, and is reported', async () => {
    const built = site({ metaKey: 'team', queryName: 'members' })
    metaOf(built, "labels: { copy: { type: 'string', default: 'Copy' }, note: { type: 'string' } }")
    const [err] = unread(await validateDataInputs(built))
    expect(err.message).toContain('section reads content.data.labels,')
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

// ⛔ Reported until 2026-11-22: each section was asked on its own, so on a record's page whose query
// fed its header, the form beside it, which can name a person, was reported as data that failed to
// arrive. A delivery another section on the page took arrived where it was meant to.
describe('⛔ a delivery another section on the page took', () => {
  // The page gets a second section, a `Signup` that can name a contact (`@/contact`, linkable).
  const besideTeam = (built, signupFrontmatter = '') => {
    const fdn = built.foundationPath
    mkdirSync(join(fdn, 'sections', 'Signup'), { recursive: true })
    writeFileSync(join(fdn, 'sections', 'Signup', 'meta.js'), "export default { data: { contact: '@/contact' } }\n")
    writeFileSync(join(fdn, 'sections', 'Signup', 'index.jsx'), 'export default function Signup() { return null }\n')
    writeFileSync(join(fdn, 'schemas', 'contact.yml'), 'fields:\n  name:\n    type: string\n')
    const page = join(built.siteRoot, 'pages', 'home')
    rmSync(join(page, 'index.md'))
    writeFileSync(join(page, '1-team.md'), '---\ntype: Team\n---\n\n# Team\n')
    writeFileSync(join(page, '2-signup.md'), `---\ntype: Signup\n${signupFrontmatter}---\n\n# Write to us\n`)
    return built
  }

  it('is not reported on a section beside the one it filled', async () => {
    const built = besideTeam(site({ metaKey: 'team', queryName: 'team' }))
    expect(unread(await validateDataInputs(built))).toEqual([])
  })

  it('CONTROL — one that filled no section on the page is reported on each section that reads data', async () => {
    const built = besideTeam(site({ metaKey: 'team', queryName: 'members' }))
    const errs = unread(await validateDataInputs(built))
    expect(errs.map((e) => e.file).sort()).toEqual(['/ · Signup', '/ · Team'])
    expect(errs[0].message).toContain('this page delivers `members`')
  })

  it('CONTROL — a section\'s own query that fills nothing is reported, whatever the page\'s query filled', async () => {
    const built = besideTeam(site({ metaKey: 'team', queryName: 'team' }), 'query: team\n')
    const [err, ...rest] = unread(await validateDataInputs(built))
    expect(rest).toEqual([])
    expect(err.file).toBe('/ · Signup')
    expect(err.message).toContain('section reads content.data.contact,')
  })
})
