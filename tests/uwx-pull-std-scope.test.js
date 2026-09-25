/**
 * ⛔ UNDER A FOUNDATION IN `@std`, A STANDARD SCHEMA IS NOT THE FOUNDATION'S OWN.
 *
 * A push qualifies a foundation's own `@/specimen` into its scope, `@std/specimen` — and a
 * site on the same foundation that uses the STANDARD `@std/person` ships that as `@std/person`
 * too. The pull used to invert every `@std/x` into `@/x`, so the standard schema came back as
 * the foundation's own: a clone put `@std/person` records in `records/person/` and rewrote the
 * query to `@/person`, and a pull into a working copy wrote them again beside the author's
 * `records/std/person/` — after which each reference to a person named two records and the
 * next push was refused (measured 2026-09-25, on a template whose records name `@std/person`). Every template is
 * a foundation in `@std`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { declarationsToQueriesYml, recordsToProject, emitSyncPackages } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let ROOT, SITE
const BACKEND = 'http://backend.test'
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-pull-std-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const read = (rel) => readFileSync(join(SITE, rel), 'utf8')

const SPECIMEN = validateAndNormalizeSchema({ name: 'specimen', fields: { name: { type: 'string' } } }, '@/specimen')
const PERSON = validateAndNormalizeSchema({ name: 'person', fields: { name: { type: 'string' } } }, '@std/person')
const declaration = (name) => ({ name, sections: { brief: { brief: true, fields: { name: { type: 'string' } } } } })

// A site whose foundation is `@std/lab`: in the project (`local`, built — its declarations
// hold its own `@/specimen` and the standard `@std/person` it references, as a build writes
// them), or named by a registry ref, as a clone's is.
function makeSite({ local = true, scope = 'std' } = {}) {
  if (local) {
    w('site/site.yml', 'name: Lab\nfoundation: fnd\n')
    w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
    w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
    w('fdn/main.js', `export default { name: '@${scope}/lab' }\n`)
    w('fdn/dist/meta/schema.json', {
      _self: { name: `@${scope}/lab`, version: '1.0.0', role: 'foundation' },
      dataSchemas: { '@/specimen': SPECIMEN, '@std/person': PERSON },
    })
  } else {
    w('site/site.yml', `name: Lab\nfoundation: "@${scope}/lab@1.0.0"\n`)
  }
  w('site/pages/home/page.yml', 'title: Home\n')
}

// The documents a pull takes: the folder naming each record, and the records.
const pulled = (records) => ({
  folderDoc: {
    contents: records.map(({ slug, model, uuid }) => ({ kind: 'ref', name: slug, entry: { schema: model, entity: uuid } })),
  },
  recordDocs: records.map(({ model, uuid, name }) => ({ $uuid: uuid, $schema: model, brief: { name } })),
})
const project = (records, scope = '@std') =>
  recordsToProject({
    ...pulled(records),
    siteRoot: SITE,
    opts: { backend: BACKEND, resolveDeclaration: (name) => declaration(name), scope },
  })

describe('a pulled query keeps a standard schema’s scope', () => {
  const document = {
    info: { foundation: '@std/lab@1.0.0' },
    queries: [
      { name: 'specimens', schema: '@std/specimen' },
      { name: 'people', schema: '@std/person' },
    ],
  }

  it('in a working copy — the foundation’s declarations say which schemas are its own', () => {
    makeSite()
    declarationsToQueriesYml({ document, siteRoot: SITE })
    const q = yaml.load(read('queries.yml'))
    expect(q.specimens.schema).toBe('@/specimen')
    expect(q.people.schema).toBe('@std/person')
  })

  it('in a clone — with no declarations here, a standard schema is not the foundation’s', () => {
    makeSite({ local: false })
    declarationsToQueriesYml({ document, siteRoot: SITE })
    const q = yaml.load(read('queries.yml'))
    expect(q.specimens.schema).toBe('@/specimen')
    expect(q.people.schema).toBe('@std/person')
  })
})

describe('a pulled record lands where the author keeps it', () => {
  const RECORDS = [
    { slug: 'ammonite', model: '@std/specimen', uuid: 'U-AMMONITE', name: 'Ammonite' },
    { slug: 'ines', model: '@std/person', uuid: 'U-INES', name: 'Ines' },
  ]

  it('in a clone — a standard schema’s records go under its scope, the foundation’s own under its name', () => {
    makeSite({ local: false })
    const report = project(RECORDS)
    expect(report.skipped).toEqual([])
    expect(existsSync(join(SITE, 'records/specimen/ammonite.yml'))).toBe(true)
    expect(existsSync(join(SITE, 'records/std/person/ines.yml'))).toBe(true)
    expect(existsSync(join(SITE, 'records/person'))).toBe(false)
  })

  it('⛔ in a working copy — into the author’s own file, never a second one beside it', () => {
    makeSite()
    w('site/records/std/person/ines.yml', '$uuid: U-INES\nname: Ines\n')
    w('site/records/specimen/ammonite.yml', '$uuid: U-AMMONITE\nname: Ammonite\n')
    const report = project(RECORDS.map((r) => ({ ...r, name: `${r.name}, renamed` })))
    expect(report.placed).toEqual([])
    expect(yaml.load(read('records/std/person/ines.yml')).name).toBe('Ines, renamed')
    expect(existsSync(join(SITE, 'records/person'))).toBe(false)
  })

  it('a record already kept in another folder that reads as its Model is written back there', () => {
    // The foundation is not in the project, so nothing says `@acme/article` is not its own:
    // the derived folder is `records/article/`. The author keeps the record under
    // `records/acme/article/`, which reads as the same Model — so it is written there.
    makeSite({ local: false, scope: 'acme' })
    w('site/records/acme/article/hello.yml', '$uuid: U-HELLO\nname: Hello\n')
    const report = project([{ slug: 'hello', model: '@acme/article', uuid: 'U-HELLO', name: 'Hello again' }], '@acme')
    expect(report.placed).toEqual([])
    expect(yaml.load(read('records/acme/article/hello.yml')).name).toBe('Hello again')
    expect(existsSync(join(SITE, 'records/article'))).toBe(false)
  })

  it('CONTROL — a new record of the foundation’s own schema is placed under its name', () => {
    makeSite()
    const report = project([{ slug: 'belemnite', model: '@std/specimen', uuid: 'U-BEL', name: 'Belemnite' }])
    expect(report.placed.map((p) => p.slice(SITE.length + 1))).toEqual(['records/specimen/belemnite.yml'])
  })
})

describe('a push refuses one record kept in two files', () => {
  it('names both, whatever folder each reads as', async () => {
    makeSite()
    // What an earlier pull left: the author's file, and a copy in the folder that also reads as
    // `@std/person` under a foundation in `@std`.
    w('site/records/std/person/ines.yml', '$uuid: U-INES\nname: Ines\n')
    w('site/records/person/ines.yml', '$uuid: U-INES\nname: Ines\n')
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    const hit = pkg.refusals.find((r) => /holds the same record as/.test(r))
    expect(hit).toMatch(/records\/(std\/)?person\/ines\.yml: holds the same record as records\/(std\/)?person\/ines\.yml/)
    expect(hit).toMatch(/\$uuid: U-INES/)
  })

  it('CONTROL — two records with their own ids are not refused for it', async () => {
    makeSite()
    w('site/records/std/person/ines.yml', '$uuid: U-INES\nname: Ines\n')
    w('site/records/std/person/sam.yml', '$uuid: U-SAM\nname: Sam\n')
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    expect(pkg.refusals.filter((r) => /holds the same record as/.test(r))).toEqual([])
  })
})
