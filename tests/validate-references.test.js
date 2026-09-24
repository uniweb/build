// ⭐ `uniweb validate` checks that a record's references name records — a push refuses
// one that does not, since it cannot send a uuid for it. A uuid is left alone: it may
// name a record the backend holds and this project does not.
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
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-refs-'))
  const foundationPath = join(root, 'foundation')
  const siteRoot = join(root, 'site')
  write(join(foundationPath, 'package.json'), JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }))
  write(join(foundationPath, 'main.js'), 'export default {}\n')
  write(join(foundationPath, 'schemas', 'speaker.yml'), 'name: speaker\nfields:\n  name: string\n')
  write(
    join(foundationPath, 'schemas', 'talk.yml'),
    "name: talk\nfields:\n  title: string\n  speaker: { ref: '@/speaker' }\n  panel: { ref: '@/speaker', many: true }\n"
  )
  write(join(siteRoot, 'site.yml'), 'name: fixture\nfoundation: foundation\n')
  write(join(siteRoot, 'theme.yml'), '')
  write(join(siteRoot, 'pages', 'home', 'page.yml'), 'title: Home\n')
  write(join(siteRoot, 'records', 'speaker', 'ada.yml'), 'name: Ada\n')
  // Named by its `slug:`, not its file's name.
  write(join(siteRoot, 'records', 'speaker', 'g.md'), '---\nslug: grace\nname: Grace\n---\n')
  write(join(siteRoot, 'records', 'talk', 'good.yml'), 'title: Good\nspeaker: ada\npanel: [ada, grace]\n')
  write(join(siteRoot, 'records', 'talk', 'bad.yml'), 'title: Bad\nspeaker: adaa\npanel: [ada, nobody]\n')
  write(join(siteRoot, 'records', 'talk', 'remote.yml'), 'title: Remote\nspeaker: 01a0d4fb-b326-7241-933b-cf05db69731d\n')
  report = await validateDataInputs({ siteRoot, foundationPath })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('validateDataInputs — references', () => {
  it('reports each reference that names no record, and nothing else', () => {
    expect(report.violations.map((v) => `${v.file} ${v.item} ${v.field}:${v.rule}`).sort()).toEqual([
      'records/talk/bad.yml bad panel[1]:ref',
      'records/talk/bad.yml bad speaker:ref',
    ])
  })

  it('says which record it looked for', () => {
    const v = report.violations.find((x) => x.field === 'speaker')
    expect(v.message).toBe('names "adaa", and no record of @/speaker is called that')
  })
})
