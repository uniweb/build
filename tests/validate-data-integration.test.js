import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDataInputs } from '../src/validate-data.js'

// End-to-end over a real on-disk project: a foundation that binds a section's
// `projects` input to a foundation-local `@/project` schema, and a site whose
// file-based collection feeds it. Exercises the whole join the unit tests
// don't reach — schema discovery, content collection, collection compile, the
// unique-pair dedup, deferred classification, and the JSON-shipped-shape
// normalization — with no external schema packages.

let root
let siteRoot
let foundationPath

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-validate-'))
  foundationPath = join(root, 'foundation')
  siteRoot = join(root, 'site')

  // --- foundation (flat layout: srcDir === foundation root) ---
  mkdirSync(join(foundationPath, 'schemas'), { recursive: true })
  mkdirSync(join(foundationPath, 'sections', 'DataDump'), { recursive: true })
  // `type: module` is mandatory — `meta.js` is ESM, and without it the module
  // loader treats the `.js` as CommonJS and fails to import it (real
  // foundations are always ESM-only).
  writeFileSync(
    join(foundationPath, 'package.json'),
    JSON.stringify({ name: 'foundation', type: 'module', main: './_entry.generated.js' }, null, 2)
  )
  writeFileSync(join(foundationPath, 'main.js'), 'export default {}\n')
  writeFileSync(
    join(foundationPath, 'schemas', 'project.yml'),
    [
      'name: project',
      'fields:',
      '  name: { type: string, required: true }',
      '  status: { type: string, enum: [active, archived], default: active }',
      '  when: { type: date }',
      '  url: { type: url }',
      '',
    ].join('\n')
  )
  writeFileSync(
    join(foundationPath, 'sections', 'DataDump', 'meta.js'),
    "export default { title: 'Data Dump', data: { projects: '@/project' } }\n"
  )

  // --- site ---
  mkdirSync(join(siteRoot, 'collections', 'projects'), { recursive: true })
  mkdirSync(join(siteRoot, 'pages', 'data'), { recursive: true })
  writeFileSync(
    join(siteRoot, 'site.yml'),
    [
      'name: fixture',
      'foundation: foundation',
      'collections:',
      '  projects:',
      '    path: collections/projects',
      '',
    ].join('\n')
  )
  writeFileSync(join(siteRoot, 'theme.yml'), '')

  // atlas — conformant. `when` is a YAML date (parses to a Date object); it
  // ships as an ISO string in /data/*.json, so it must NOT trip the string/date
  // check. This guards the JSON-shipped-shape normalization.
  writeFileSync(
    join(siteRoot, 'collections', 'projects', 'atlas.yml'),
    ['name: Atlas', 'status: active', 'when: 2024-01-01', 'url: https://atlas.example.org', ''].join('\n')
  )
  // bad — missing required `name`, and `status` not in the enum.
  writeFileSync(
    join(siteRoot, 'collections', 'projects', 'bad.yml'),
    ['status: 42', ''].join('\n')
  )

  writeFileSync(join(siteRoot, 'pages', 'data', 'page.yml'), 'title: Data\n')
  // Two sections bind the same collection — tests the unique-pair dedup
  // (one pair, two users).
  writeFileSync(
    join(siteRoot, 'pages', 'data', '1-projects.md'),
    '---\ntype: DataDump\ndata: projects\n---\n\n# Projects\n'
  )
  writeFileSync(
    join(siteRoot, 'pages', 'data', '2-projects.md'),
    '---\ntype: DataDump\ndata: projects\n---\n\n# More Projects\n'
  )
  // A remote source — must be reported as deferred, never silently skipped.
  writeFileSync(
    join(siteRoot, 'pages', 'data', '3-live.md'),
    '---\ntype: DataDump\nfetch:\n  url: https://api.example.org/projects.json\n  schema: projects\n---\n\n# Live\n'
  )
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('validateDataInputs — end-to-end join', () => {
  let report

  beforeAll(async () => {
    report = await validateDataInputs({ siteRoot, foundationPath })
  })

  it('flags exactly the seeded violations on the bad record', () => {
    const onBad = report.violations.filter((v) => v.item === 'bad')
    expect(onBad).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name', rule: 'required', schema: '@/project', file: '/data/projects.json' }),
        expect.objectContaining({ field: 'status', rule: 'enum' }),
      ])
    )
    // Two violations, both on `bad`; the conformant record contributes none.
    expect(report.violations).toHaveLength(2)
    expect(report.violations.every((v) => v.item === 'bad')).toBe(true)
  })

  it('does not false-positive on a YAML date that ships as an ISO string', () => {
    // atlas.when is a Date in memory but a string in /data/projects.json.
    expect(report.violations.some((v) => v.item === 'atlas')).toBe(false)
  })

  it('dedups the collection into one pair with two section users', () => {
    // Both data:projects sections share the single (file, schema) pair.
    for (const v of report.violations) {
      expect(v.users.length).toBe(2)
      expect(v.users.map((u) => u.section)).toEqual(['DataDump', 'DataDump'])
    }
  })

  it('reports the remote source as deferred, not skipped', () => {
    expect(report.deferred).toEqual([
      expect.objectContaining({
        section: 'DataDump',
        key: 'projects',
        reason: 'remote url: source',
        url: 'https://api.example.org/projects.json',
      }),
    ])
  })

  it('summarizes records, schemas, violations, and deferred', () => {
    expect(report.summary).toEqual({ records: 2, schemas: 1, violations: 2, deferred: 1 })
    expect(report.setupErrors).toEqual([])
  })
})
