// ⭐ A RECORD MOVED TO ANOTHER DATA SCHEMA GOES UP AS A NEW RECORD, IN THE FOLDER ENTRY IT HAD.
//
// An entity keeps its data schema for life (backend `entity-sync-wire.md` §11.3). When a file
// keeps its `$uuid` but now sits under another schema than the one the backend holds it as
// (`sync.json` `types`, banked from the folder a push or pull hands back), the push sends:
// - the record as a new entity of the new schema: no `$uuid`, its `$id` for references;
// - its folder entry with its own `$uuid`, found by the entity it held, so a rename in the
//   same move does not lose it.
// The old entity is kept by the backend, in no folder.
// ⛔ Until 2026-11-04 the push sent the record with its `$uuid` and was refused
// (`type_changed`). The way round was to delete the line, which also lost the entry when the
// file was renamed: measured 2026-10-29 on uniweb.app, 13 records, every entry new, refused.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, collectFolderRecordTypes } from '../src/uwx/index.js'

const NOTE = { name: 'note', brief: true, fields: { title: { type: 'string' } } }
const MEMO = { name: 'memo', brief: true, fields: { title: { type: 'string' }, apiKey: { type: 'string' } } }
const BACKEND = 'http://backend.test'
const U = '01a0d4fb-0000-7000-8000-0000000000a1' // the record, as the backend holds it
const ENTRY = '01a0d4fb-0000-7000-8000-0000000000e1' // its folder entry

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const folderDoc = (pkg) => JSON.parse(readZip(pkg.records.buffer).get('entities/folder.json').toString('utf8'))
const entityDoc = (pkg, file) => JSON.parse(readZip(pkg.records.buffer).get(file).toString('utf8'))

// The site after the move: what was `records/note/a.yml` is now `records/memo/b.yml`, its `$uuid`
// kept. `types` says what the backend holds that uuid as; leave it out for a copy that never banked it.
function movedSite({ heldAs = '@acme/note', file = 'site/records/memo/b.yml', body = 'title: A\n' } = {}) {
  w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w(file, `$uuid: ${U}\n${body}`)
  w('fdn/package.json', { name: '@acme/base', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/base' }\n")
  w('fdn/dist/meta/schema.json', { _self: { name: '@acme/base', version: '1.0.0', role: 'foundation' }, dataSchemas: { '@/note': NOTE, '@/memo': MEMO } })
  w('site/sync.json', {
    version: 1,
    backends: {
      [BACKEND]: {
        site: { uuid: 'SITE' },
        records: { [U]: U },
        // As the last push or pull banked the folder: by the record it held, and by its old name.
        folders: { [`@${U}`]: ENTRY, a: ENTRY },
        ...(heldAs ? { types: { [U]: heldAs } } : {}),
      },
    },
  })
  return join(ROOT, 'site')
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'moved-schema-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a record whose file moved to another data schema', () => {
  it('⭐ goes up as a new record of the new schema, in the entry it had, though it was renamed', async () => {
    const siteDir = movedSite()
    const pkg = await emitSyncPackages(siteDir, { backend: BACKEND, folderItemUuids: { [`@${U}`]: ENTRY, a: ENTRY } })
    expect(pkg.refusals).toEqual([])
    const doc = entityDoc(pkg, 'entities/memo/b.json')
    expect(doc.$schema).toBe('@acme/memo')
    expect(doc.$uuid).toBeUndefined()
    expect(doc.$id).toBe('memo/b')
    expect(folderDoc(pkg).contents).toEqual([{ kind: 'ref', name: 'b', entry: { $ref: 'memo/b' }, $uuid: ENTRY }])
    const entry = pkg.records.index.find((e) => e.id === 'memo/b')
    expect(entry.moved).toEqual({ from: '@acme/note', to: '@acme/memo', uuid: U, secrets: [] })
    // The file keeps its own id: the back-fill maps it to the new entity's uuid.
    expect(entry.ownId).toBe(U)
  })

  it('names a field the file holds as `#ref`, a set secret the new record will not have', async () => {
    const siteDir = movedSite({ body: 'title: A\napiKey: "#ref"\n' })
    const pkg = await emitSyncPackages(siteDir, { backend: BACKEND, folderItemUuids: { [`@${U}`]: ENTRY } })
    expect(pkg.records.index.find((e) => e.id === 'memo/b').moved.secrets).toEqual(['apiKey'])
  })

  it('CONTROL: held under the schema it is in, it goes with its `$uuid`, and nothing moves', async () => {
    const siteDir = movedSite({ heldAs: '@acme/memo' })
    const pkg = await emitSyncPackages(siteDir, { backend: BACKEND, folderItemUuids: { [`@${U}`]: ENTRY } })
    expect(entityDoc(pkg, 'entities/memo/b.json').$uuid).toBe(U)
    expect(folderDoc(pkg).contents).toEqual([{ kind: 'ref', name: 'b', entry: { schema: '@acme/memo', entity: U }, $uuid: ENTRY }])
    expect(pkg.records.index.find((e) => e.id === 'memo/b').moved).toBeUndefined()
  })

  it('CONTROL: a copy that never banked the types sends it as before, with its `$uuid`', async () => {
    const siteDir = movedSite({ heldAs: null })
    const pkg = await emitSyncPackages(siteDir, { backend: BACKEND, folderItemUuids: { [`@${U}`]: ENTRY } })
    expect(entityDoc(pkg, 'entities/memo/b.json').$uuid).toBe(U)
    expect(pkg.records.index.find((e) => e.id === 'memo/b').moved).toBeUndefined()
  })
})

describe('a name that is not fully scoped', () => {
  it('⛔ never reads as a move: a foundation whose scope is unknown sends `@/memo`, not `@acme/memo`', async () => {
    const siteDir = movedSite({ heldAs: '@acme/memo' })
    rmSync(join(ROOT, 'fdn/main.js'))
    w('fdn/package.json', { type: 'module', main: './_entry.generated.js' })
    w('fdn/dist/meta/schema.json', { dataSchemas: { '@/note': NOTE, '@/memo': MEMO } })
    const pkg = await emitSyncPackages(siteDir, { backend: BACKEND, folderItemUuids: { [`@${U}`]: ENTRY } })
    const doc = entityDoc(pkg, 'entities/memo/b.json')
    expect(doc.$schema).toBe('@/memo')
    expect(doc.$uuid).toBe(U)
    expect(pkg.records.index.find((e) => e.id === 'memo/b').moved).toBeUndefined()
  })
})

describe('collectFolderRecordTypes — what a stored folder says each record is', () => {
  it('maps each ref entry’s entity to its schema, through branches, and skips links', () => {
    const doc = {
      contents: [
        { kind: 'ref', name: 'a', entry: { schema: '@acme/note', entity: 'R1' }, $uuid: 'E1' },
        { kind: 'branch', name: 'blog', $children: [{ kind: 'ref', name: 'p', entry: { schema: '@std/article', entity: 'R2' } }] },
        { kind: 'link', name: 'x', url: 'https://example.test/', $uuid: 'L1' },
        { kind: 'ref', name: 'new', entry: { $ref: 'note/new' } },
      ],
    }
    expect(collectFolderRecordTypes(doc)).toEqual({ R1: '@acme/note', R2: '@std/article' })
  })
})
