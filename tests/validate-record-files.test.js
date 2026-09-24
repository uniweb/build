// ⭐ Every record in the records directory is checked against the data schema its
// folder names — the set a push sends, whether or not a section reads it. Until
// 2026-09-24 only records a section's binding reached were checked, and a
// sections-form schema was not checked at all.
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
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-records-'))
  foundationPath = join(root, 'foundation')
  siteRoot = join(root, 'site')

  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), 'export default {}\n')
  write(join(foundationPath, 'schemas', 'member.yml'), 'name: member\nfields:\n  name: { type: string, required: true }\n  joined: { type: date }\n')
  // A brief plus a list — the way an app stores a course. No section binds it.
  write(
    join(foundationPath, 'schemas', 'course.yml'),
    'name: course\nsections:\n  identity:\n    brief: true\n    fields:\n      title: { type: string, required: true }\n  modules:\n    many: true\n    fields:\n      title: { type: string, required: true }\n'
  )
  // A markdown body is the value of the content body field, as a push sends it.
  write(join(foundationPath, 'schemas', 'note.yml'), 'name: note\nfields:\n  title: { type: string, required: true }\n  text: { type: markdown, required: true }\n')
  // A body in a section other than the brief — `@std/article`'s layout.
  write(
    join(foundationPath, 'schemas', 'post.yml'),
    'name: post\nsections:\n  card:\n    brief: true\n    fields:\n      title: { type: string, required: true }\n  body:\n    fields:\n      content: { type: richtext }\n'
  )
  write(join(foundationPath, 'sections', 'Team', 'meta.js'), "export default { title: 'Team', data: { members: '@/member' } }\n")

  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\nqueries:\n  members:\n    schema: "@/member"\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'team', 'page.yml'), 'title: Team\n')
  write(join(siteRoot, 'pages', 'team', 'team.md'), '---\ntype: Team\nquery: members\n---\n\n# Team\n')
  write(join(siteRoot, 'records', 'member', 'ada.yml'), 'name: Ada\njoined: 2021-03-15\n')
  write(join(siteRoot, 'records', 'member', 'bob.yml'), 'name: Bob\njoined: March 2021\n')
  write(join(siteRoot, 'records', 'course', 'rust.yml'), 'identity:\n  title: Rust 101\nmodules:\n  - title: Basics\n  - {}\n')
  write(join(siteRoot, 'records', 'course', 'go.yml'), 'modules: []\n')
  // Written in the retired flat form: `title` belongs under `identity:`.
  write(join(siteRoot, 'records', 'course', 'flat.yml'), 'title: Rust 102\n')
  write(join(siteRoot, 'records', 'note', 'hello.md'), '---\ntitle: Hello\n---\n\nThe text.\n')
  write(join(siteRoot, 'records', 'note', 'empty.md'), '---\ntitle: Empty\n---\n')
  // The body lands in `body.content`, where the file holds it — never at the top.
  write(join(siteRoot, 'records', 'post', 'hello.md'), '---\ncard:\n  title: Hello\n---\n\nThe body.\n')
  write(join(siteRoot, 'records', 'post', 'untitled.md'), '---\ncard: {}\n---\n\nThe body.\n')

  report = await validateDataInputs({ siteRoot, foundationPath })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const found = () => report.violations.map((v) => `${v.file} ${v.item} ${v.field}:${v.rule}`).sort()

describe('validateDataInputs — every record file', () => {
  it('checks records no section reads, in either sections-form shape, and a bound record once', () => {
    expect(found()).toEqual(
      [
        `${queryDataUrl('members')} bob joined:format`,
        'records/course/flat.yml flat title:section',
        'records/course/flat.yml flat identity.title:required',
        'records/course/go.yml go identity.title:required',
        'records/course/rust.yml rust modules[1].title:required',
        'records/note/empty.md empty text:required',
        'records/post/untitled.md untitled card.title:required',
      ].sort()
    )
  })

  it('does not defer a sections-form schema', () => {
    expect(report.deferred).toEqual([])
  })

  it('counts each record once', () => {
    // 2 members (by their section) + 3 courses + 2 notes + 2 posts (by their files).
    expect(report.summary.records).toBe(9)
    expect(report.summary.schemas).toBe(4)
  })
})
