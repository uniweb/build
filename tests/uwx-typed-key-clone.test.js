/**
 * ⭐ A CLONE KEEPS THE AUTHOR'S FORM OF A QUERY TYPED BY ITS DATA KEY — and can push it back.
 *
 * `team:` with no schema, a section type reading `data: { team: '@/member' }`: its records are
 * members, kept in `records/team/`. A push sends them as `@acme/member` and marks the query
 * `typed_by_data_key`. A clone has no foundation source to type the key with, so until 2026-09-26
 * it wrote `team: { schema: '@/member' }` and `records/member/`. Now the CLI keeps the registered
 * foundation's schema (`site/registered-foundation.js`), and the pull, reading the mark, writes
 * `team:` and `records/team/` — which the clone's own push types by that same kept schema.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { emitSyncPackages, readZip, declarationsToQueriesYml, recordsToProject } from '../src/uwx/index.js'
import { foundationSchemaJson } from '../src/site/queries-config.js'
import { writeRegisteredFoundation, registeredFoundationPath } from '../src/site/registered-foundation.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'

let CLONE
const BACKEND = 'http://backend.test'
const REF = '@acme/fnd@1.0.0'
beforeEach(() => {
  CLONE = join(mkdtempSync(join(tmpdir(), 'uwx-typed-clone-')), 'site')
  mkdirSync(CLONE, { recursive: true })
})
afterEach(() => rmSync(join(CLONE, '..'), { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(CLONE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}

const MEMBER = toDataSchemaDeclaration(
  validateAndNormalizeSchema({ name: 'member', fields: { name: { type: 'string' } } }, '@/member'),
  { name: '@acme/member' }
)

// The registered version, as the backend answers for it: section types with their `data:`, the key's
// type qualified, and no data schemas of its own.
const REPLY = { schema: { _self: {}, Team: { data: { team: '@acme/member' } } }, module_url: 'https://cdn.test/fnd/1.0.0/entry.js' }

function clone({ keep = true, queriesYml = null } = {}) {
  w('site.yml', `name: T\nfoundation: '${REF}'\n`)
  if (queriesYml !== null) w('queries.yml', queriesYml)
  if (keep) writeRegisteredFoundation(CLONE, REF, REPLY)
}

const pulledQueries = (queries) =>
  declarationsToQueriesYml({ document: { info: { foundation: REF }, queries }, siteRoot: CLONE })
const queriesYml = () => yaml.load(readFileSync(join(CLONE, 'queries.yml'), 'utf8'))

describe('the registered foundation a clone keeps', () => {
  it('is kept under `.uniweb/`, and read as the foundation’s schema', () => {
    clone()
    expect(registeredFoundationPath(CLONE, REF)).toBe(join(CLONE, '.uniweb', 'foundations', '@acme', 'fnd@1.0.0.json'))
    expect(foundationSchemaJson(CLONE, { foundation: REF })).toEqual(REPLY.schema)
  })

  it('CONTROL — none is kept for a local foundation', () => {
    expect(registeredFoundationPath(CLONE, 'src')).toBe(null)
  })
})

describe('a pull into a clone', () => {
  it('⭐ writes a marked query as the author did — `team:`, no schema', () => {
    clone()
    pulledQueries([{ name: 'team', schema: '@acme/member', typed_by_data_key: true }])
    expect(queriesYml().team).toEqual({})
  })

  it('CONTROL — an unmarked one’s schema was the author’s, and is written', () => {
    clone()
    pulledQueries([{ name: 'team', schema: '@acme/member' }])
    expect(queriesYml().team).toEqual({ schema: '@/member' })
  })

  it('CONTROL — with no registered version kept, the schema is written, so the clone can push it', () => {
    clone({ keep: false })
    pulledQueries([{ name: 'team', schema: '@acme/member', typed_by_data_key: true }])
    expect(queriesYml().team).toEqual({ schema: '@/member' })
  })

  it('⭐ places a member in the typed query’s folder — `records/team/`', () => {
    clone({ queriesYml: 'team: {}\n' })
    const report = recordsToProject({
      folderDoc: { contents: [{ kind: 'ref', name: 'lin', entry: { schema: '@acme/member', entity: 'U-LIN' } }] },
      recordDocs: [{ $uuid: 'U-LIN', $schema: '@acme/member', brief: { name: 'Lin' } }],
      siteRoot: CLONE,
      opts: { backend: BACKEND, resolveDeclaration: () => MEMBER, scope: '@acme' },
    })
    expect(report.skipped).toEqual([])
    expect(report.placed.map((p) => p.slice(CLONE.length + 1))).toEqual(['records/team/lin.yml'])
    expect(existsSync(join(CLONE, 'records/member'))).toBe(false)
  })
})

describe('the clone’s own push', () => {
  it('⭐ types `team` by the kept schema — members, and the query marked', async () => {
    clone({ queriesYml: 'team: {}\n' })
    w('pages/home/page.yml', 'title: Home\n')
    w('records/team/lin.yml', 'name: Lin\n')
    const pkg = await emitSyncPackages(CLONE, {
      backend: BACKEND,
      resolveModel: async (name) => (name === '@acme/member' ? MEMBER : null),
      queryFields: ['name', 'schema', 'typed_by_data_key'],
    })
    expect(pkg.refusals).toEqual([])
    const lin = [...readZip(pkg.records.buffer)]
      .filter(([n]) => n.startsWith('entities/'))
      .map(([, b]) => JSON.parse(b.toString('utf8')))
      .find((d) => d.$id === 'team/lin')
    expect(lin.$schema).toBe('@acme/member')
    const doc = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(doc.queries.find((q) => q.name === 'team')).toMatchObject({ schema: '@acme/member', typed_by_data_key: true })
  })
})

describe('a clone of a foundation in `@std`, keeping its registered version', () => {
  it('⭐ places a record of the foundation’s own schema by its name, and a standard one by its scope', () => {
    w('site.yml', "name: T\nfoundation: '@std/lab@1.0.0'\n")
    writeRegisteredFoundation(CLONE, '@std/lab@1.0.0', { schema: { _self: {}, Grid: { data: {} } } })
    const EXHIBIT = toDataSchemaDeclaration(
      validateAndNormalizeSchema({ name: 'exhibit', fields: { title: { type: 'string' } } }, '@/exhibit'),
      { name: '@std/exhibit' }
    )
    const PERSON = toDataSchemaDeclaration(
      validateAndNormalizeSchema({ name: 'person', fields: { name: { type: 'string' } } }, '@/person'),
      { name: '@std/person' }
    )
    const report = recordsToProject({
      folderDoc: {
        contents: [
          { kind: 'ref', name: 'deep-time', entry: { schema: '@std/exhibit', entity: 'U-1' } },
          { kind: 'ref', name: 'ines', entry: { schema: '@std/person', entity: 'U-2' } },
        ],
      },
      recordDocs: [
        { $uuid: 'U-1', $schema: '@std/exhibit', brief: { title: 'Deep time' } },
        { $uuid: 'U-2', $schema: '@std/person', brief: { name: 'Ines' } },
      ],
      siteRoot: CLONE,
      opts: { backend: BACKEND, resolveDeclaration: (n) => (n === '@std/exhibit' ? EXHIBIT : PERSON), scope: '@std' },
    })
    expect(report.skipped).toEqual([])
    expect(report.placed.map((p) => p.slice(CLONE.length + 1)).sort()).toEqual([
      'records/exhibit/deep-time.yml',
      'records/std/person/ines.yml',
    ])
  })
})
