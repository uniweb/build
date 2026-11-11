// ⭐ `uniweb validate` reports what a push refuses to carry, in every record file: a key its data
// schema has no place for, and a markdown body with no field to hold it. ⛔ Until 2026-11-11 it
// passed both ("0 violation(s)"), the build delivered them, and the site learned at its first push
// that its records could not sync (measured with `records/std/testimonial/` holding `order:`).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'

let root
let report

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-undeclared-'))
  const foundationPath = join(root, 'foundation')
  const siteRoot = join(root, 'site')

  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), "export default { name: '@acme/site-kit' }\n")
  write(join(foundationPath, 'schemas', 'member.yml'), 'name: member\nfields:\n  name: { type: string, required: true }\n  joined: { type: date }\n')
  write(join(foundationPath, 'schemas', 'note.yml'), 'name: note\nfields:\n  title: { type: string, required: true }\n')
  write(join(foundationPath, 'sections', 'Team', 'meta.js'), "export default { title: 'Team', data: { members: '@/member' } }\n")
  write(join(foundationPath, 'sections', 'Quotes', 'meta.js'), "export default { title: 'Quotes', data: { quotes: '@std/testimonial' } }\n")

  write(
    join(siteRoot, 'site.yml'),
    'name: fixture\nfoundation: foundation\nqueries:\n  members:\n    schema: "@/member"\n  quotes:\n    schema: "@std/testimonial"\n'
  )
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'team', 'page.yml'), 'title: Team\n')
  write(join(siteRoot, 'pages', 'team', 'team.md'), '---\ntype: Team\nquery: members\n---\n\n# Team\n')
  write(join(siteRoot, 'pages', 'quotes', 'page.yml'), 'title: Quotes\n')
  write(join(siteRoot, 'pages', 'quotes', 'quotes.md'), '---\ntype: Quotes\nquery: quotes\n---\n\n# Quotes\n')
  // A section reads this record, so the delivered-record pass checks its values; its file is
  // still checked for what a push cannot carry.
  write(join(siteRoot, 'records', 'member', 'ada.yml'), 'name: Ada\norder: 3\n')
  write(join(siteRoot, 'records', 'member', 'bob.yml'), 'name: Bob\n')
  write(join(siteRoot, 'records', 'note', 'hello.md'), '---\ntitle: Hello\n---\n\nThe text, with no field to hold it.\n')
  write(join(siteRoot, 'records', 'std', 'testimonial', 'claude.md'), '---\nquote: It just works.\nname: Claude\nlogo: claude.svg\n---\n')

  report = await validateDataInputs({ siteRoot, foundationPath })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const findings = () => report.violations.map((v) => `${v.file} ${v.item} ${v.field}:${v.rule}`).sort()
const messageOf = (rule, item) => report.violations.find((v) => v.rule === rule && v.item === item)?.message

describe('validateDataInputs — what a push cannot carry', () => {
  it('reports a field its schema lacks, and a body with no field, in every record file', () => {
    expect(findings()).toEqual([
      'records/member/ada.yml ada order:undeclared',
      'records/note/hello.md hello :body',
      'records/std/testimonial/claude.md claude logo:undeclared',
    ])
  })

  it("for a type the site's foundation defines: declare it, or remove it", () => {
    expect(messageOf('undeclared', 'ada')).toBe(
      'not a field of @/member, so a push cannot carry it, and a pull would drop it from the file. ' +
        'Declare it in the schema, or remove it.'
    )
    expect(messageOf('body', 'hello')).toMatch(/has no field for it .* Add one to the schema, or move the text into a field\.$/)
  })

  it('for a standard type: what it has, and a type of your own', () => {
    expect(messageOf('undeclared', 'claude')).toBe(
      'not a field of @std/testimonial, so a push cannot carry it, and a pull would drop it from the file. ' +
        '@std/testimonial is a standard type, and a site cannot add a field to it. It has quote, name, ' +
        'context, avatar, rating, date and url: move the value into one of those, remove it, or give these ' +
        'records a type of your own (`schemas/<name>.yml` in the foundation, the records in `records/<name>/`).'
    )
  })
})
