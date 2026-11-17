// ⭐ `max_length` on a rich-text field counts the characters a reader sees (2026-11-17), and
// `uniweb validate` counts a record's markdown as the push reads it — into the document it sends.
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
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-rich-length-'))
  const foundationPath = join(root, 'foundation')
  const siteRoot = join(root, 'site')
  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), 'export default {}\n')
  // The body is the rich text: 12 characters at most, as a reader sees them.
  write(join(foundationPath, 'schemas', 'interest.yml'), 'name: interest\nfields:\n  title: { type: string, required: true }\n  summary: { type: richtext, max_length: 12 }\n')
  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'index.md'), '# Home\n')
  // "CO2 and m2." is 11 characters a reader sees, though its markdown is 25 long.
  write(join(siteRoot, 'records', 'interest', 'fits.md'), '---\ntitle: Fits\n---\n\n**CO[2]{sub}** and m[2]{sup}.\n')
  // Two paragraphs of 7 and 6, and the new paragraph between them: 14.
  write(join(siteRoot, 'records', 'interest', 'long.md'), '---\ntitle: Long\n---\n\nCarbon,\n\nwater.\n')
  report = await validateDataInputs({ siteRoot, foundationPath })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("a rich text's max_length, in uniweb validate", () => {
  it('⭐ counts what a reader sees, not the markdown: formatting counts nothing, a new paragraph one', () => {
    expect(report.violations.map((v) => `${v.file.split('/').pop()} ${v.field}:${v.rule}`)).toEqual(['long.md summary:max_length'])
    expect(report.violations[0].message).toMatch(/14 characters — at most 12/)
  })
})
