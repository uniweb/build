// ⭐ WHAT A PUSH SENDS IS THE RECORDS DIRECTORY — every file in `records/` is a
// record, and every record is pushed (ruled 2026-09-21 [Diego]). `records/folder.yml`
// only sorts records into sub-folders. ⛔ Until 2026-09-21 it was the other way:
// what synced was exactly what `records.yml` listed.
//
// ⛔ `missing` IS STILL NOT `empty`, and both are pinned here — but the states
// belong to the DIRECTORY now. No records directory is inert: no folder is sent
// and the backend's is left alone. A directory holding no records sends an empty
// folder, which removes what is there. A test asserting only one of them would
// pass for an implementation that conflated the two.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, collectFolderItemUuids, stampFolderItemUuids, entityContentHash } from '../src/uwx/index.js'

const ARTICLE = {
  name: 'article',
  brief: true,
  fields: { title: { type: 'string' }, body: { type: 'text', format: 'markdown' } },
}
const NOTE = { name: 'note', brief: true, fields: { title: { type: 'string' } } }

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const site = ({ records = true, recordsYml = null, queries = '  articles:\n    schema: "@/article"\n' } = {}) => {
  w('site/site.yml', `name: T\nfoundation: "@acme/base"\n${queries ? `queries:\n${queries}` : ''}`)
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  if (records) {
    w('site/records/article/hello.md', '---\ntitle: Hello\n---\nBody.\n')
    w('site/records/article/world.md', '---\ntitle: World\n---\nBody2.\n')
  }
  w('fdn/dist/meta/schema.json', { dataSchemas: { '@/article': ARTICLE, '@/note': NOTE } })
  if (recordsYml !== null) w('site/records/folder.yml', recordsYml)
  return join(ROOT, 'site')
}
const folderDoc = (pkg) =>
  JSON.parse(readZip(pkg.records.buffer).get('entities/folder.json').toString('utf8'))
const sentIds = (pkg) => pkg.records.index.slice(1).map((e) => e.id)

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'sync-rule-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('no directory vs an empty one — ruled, and both pinned', () => {
  it('⭐ NO records directory is inert: no records lane at all', async () => {
    const pkg = await emitSyncPackages(site({ records: false }))
    // Not an empty folder — no folder. The backend's is left untouched, so a site
    // whose records live only there is not emptied by a push of its pages.
    expect(pkg.records).toBeNull()
  })

  it('⛔ a directory holding NO records is destructive: a folder that holds nothing', async () => {
    const root = site({ records: false })
    w('site/records/.gitkeep', '')
    const pkg = await emitSyncPackages(root)
    expect(pkg.records).toBeTruthy()
    const doc = folderDoc(pkg)
    expect(doc.$schema).toBe('@uniweb/folder')
    expect(doc.contents).toEqual([])
  })

  // ⛔ CONTROL. Without it, an emitter that never produced a records lane would
  // pass the first case, and one that always produced an empty folder the second.
  it('CONTROL — records in the directory are sent, with no folder.yml at all', async () => {
    const pkg = await emitSyncPackages(site())
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents.map((c) => c.entry?.$ref)).toEqual(['article/hello', 'article/world'])
    expect(sentIds(pkg)).toEqual(['article/hello', 'article/world'])
  })

  it('an empty folder.yml removes nothing — it only organizes', async () => {
    // ⛔ Until 2026-09-21 an empty records.yml was THE destructive state.
    const pkg = await emitSyncPackages(site({ recordsYml: '' }))
    expect(folderDoc(pkg).contents.map((c) => c.entry?.$ref)).toEqual(['article/hello', 'article/world'])
  })

  it('⛔ records whose schema resolves to nothing do not send an EMPTY folder', async () => {
    // Nobody emptied anything — the file side just has no records the backend can
    // hold. Sending an empty folder would remove the backend's for a state nobody
    // chose, so it is inert, like no directory.
    const root = site({ records: false, queries: '' })
    w('site/records/untyped/a.yml', 'title: A\n')
    const pkg = await emitSyncPackages(root)
    expect(pkg.records).toBeNull()
    expect(pkg.warnings.some((x) => x.includes('no data schema resolves') && x.includes('not pushed'))).toBe(true)
  })

  it('⛔ …nor a folder of EMPTY BRANCHES when folder.yml organizes those records', async () => {
    // The tree is not empty — folder.yml declares folders — but every record in it
    // resolved no schema, so each branch is empty. Sending it would replace the
    // backend's folder with empty branches. Measured on the `dynamic` template.
    const root = site({ records: false, queries: '', recordsYml: '- folder: field\n  records:\n    - untyped/a.yml\n' })
    w('site/records/untyped/a.yml', 'title: A\n')
    const pkg = await emitSyncPackages(root)
    expect(pkg.records).toBeNull()
  })
})

describe('every record is pushed — nothing lists them', () => {
  it('a record no query reads is pushed too', async () => {
    const root = site()
    w('site/records/note/memo.md', '---\ntitle: Memo\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(sentIds(pkg)).toContain('note/memo')
    // CONTROL — the queried records are there as well.
    expect(sentIds(pkg)).toEqual(expect.arrayContaining(['article/hello', 'article/world']))
  })

  it('a file whose name starts with `_` is not a record, so it is not pushed', async () => {
    const root = site()
    w('site/records/article/_draft.md', '---\ntitle: Not yet\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(sentIds(pkg)).toEqual(['article/hello', 'article/world'])
  })

  it('⛔ two queries over one schema push each record ONCE', async () => {
    // Measured before 2026-09-21: records were mapped once per query, the duplicate
    // check refused the push — "appears in more than one query".
    const pkg = await emitSyncPackages(
      site({ queries: '  articles:\n    schema: "@/article"\n  recent:\n    schema: "@/article"\n    limit: 1\n' })
    )
    expect(sentIds(pkg)).toEqual(['article/hello', 'article/world'])
  })

  it('folder.yml places a record in a sub-folder; every other record sits at the top', async () => {
    const pkg = await emitSyncPackages(
      site({ recordsYml: '- folder: archive\n  records:\n    - article/world.md\n' })
    )
    const contents = folderDoc(pkg).contents
    expect(contents.map((c) => [c.kind, c.name])).toEqual([['branch', 'archive'], ['ref', 'hello']])
    expect(contents[0].$children.map((c) => c.entry?.$ref)).toEqual(['article/world'])
  })

  it('⛔ a folder.yml that LISTS records at the top level is refused, naming why', async () => {
    await expect(emitSyncPackages(site({ recordsYml: '- article/*.md\n' }))).rejects.toThrow(
      /lists records at the top level/
    )
  })

  it('⛔ `sync:` on a query is refused — it would push what it meant to hold back', async () => {
    const root = site()
    w('site/queries.yml', 'articles:\n  schema: "@/article"\n  sync: false\n')
    await expect(emitSyncPackages(root)).rejects.toThrow(/`sync:` is retired/)
  })
})

// ⭐ TWO RECORDS OF DIFFERENT SCHEMAS MAY SHARE A NAME IN ONE FOLDER. A folder is the
// curator's organization, not a URL map; a slug is resolved by a query over one schema
// [Diego, 2026-09-21]. ⛔ A push refused this until the same day, on the premise that
// folder names were unique among siblings — the premise was wrong.
describe('two records with one name in one folder', () => {
  it('is an ordinary folder — both are pushed and placed', async () => {
    const root = site()
    w('site/records/note/hello.md', '---\ntitle: A note\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(sentIds(pkg)).toEqual(expect.arrayContaining(['article/hello', 'note/hello']))
    const names = folderDoc(pkg).contents.map((c) => c.name)
    expect(names.filter((n) => n === 'hello')).toHaveLength(2)
  })

  // ⛔ WHAT THE REFUSAL WAS STANDING IN FOR. Placement identity was banked by the `name`
  // chain alone, so both `hello` leaves would have been stamped with ONE uuid on the
  // next push. Each is banked by the record it references now.
  it('each keeps its own placement identity across a push', () => {
    const stored = {
      contents: [
        { kind: 'ref', name: 'hello', entry: { schema: '@acme/article', entity: 'R-A' }, $uuid: 'P-A' },
        { kind: 'ref', name: 'hello', entry: { schema: '@acme/note', entity: 'R-N' }, $uuid: 'P-N' },
        { kind: 'ref', name: 'world', entry: { schema: '@acme/article', entity: 'R-W' }, $uuid: 'P-W' },
      ],
    }
    const banked = collectFolderItemUuids(stored)
    // an ambiguous `hello` chain key is not banked — it would name either leaf
    expect(banked).not.toHaveProperty('hello')
    expect(banked).toMatchObject({ '@R-A': 'P-A', '@R-N': 'P-N', '@R-W': 'P-W', world: 'P-W' })

    // the next push's folder, in whatever order it is built
    const next = { contents: stored.contents.map(({ $uuid, ...leaf }) => leaf).reverse() }
    stampFolderItemUuids(next, banked)
    const byRecord = Object.fromEntries(next.contents.map((c) => [c.entry.entity, c.$uuid]))
    expect(byRecord).toEqual({ 'R-A': 'P-A', 'R-N': 'P-N', 'R-W': 'P-W' })
  })

  // ⛔ CONTROL — a map banked before record keys existed holds `name` chains only, and
  // a leaf whose name is unique still finds its uuid there.
  it('CONTROL — a name-chain map from before still stamps a uniquely named leaf', () => {
    const next = { contents: [{ kind: 'ref', name: 'world', entry: { schema: '@acme/article', entity: 'R-W' } }] }
    stampFolderItemUuids(next, { world: 'P-W' })
    expect(next.contents[0].$uuid).toBe('P-W')
  })

  it('no uuid is ever stamped on two items', () => {
    // a stale chain key could otherwise hand one row to two leaves
    const next = {
      contents: [
        { kind: 'ref', name: 'x', entry: { schema: '@acme/a', entity: 'R-1' } },
        { kind: 'ref', name: 'y', entry: { schema: '@acme/a', entity: 'R-2' } },
      ],
    }
    stampFolderItemUuids(next, { '@R-1': 'P-1', y: 'P-1' })
    expect(next.contents.map((c) => c.$uuid)).toEqual(['P-1', undefined])
  })
})
// ⭐ A FILE IS NOT ALWAYS ONE RECORD, and a record's id is not always its file's
// stem — the folder places the records a file PRODUCED.
describe('the folder references the records files produce', () => {
  it('a frontmatter slug is placed under that slug', async () => {
    // ⛔ Until 2026-09-21 the leaf named the FILE (`article/renamed`) while the
    // record was `article/custom`, and the placement was dropped with a warning.
    const root = site()
    w('site/records/article/renamed.md', '---\ntitle: R\nslug: custom\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(folderDoc(pkg).contents.map((c) => c.entry?.$ref)).toContain('article/custom')
    expect(pkg.warnings.some((x) => x.includes('no record entity was produced'))).toBe(false)
  })
})

// ⛔ THE REGRESSION THAT MADE `declared` A POSITIVE TEST. The folder's state has to
// ride out of the producer on EVERY path, because its ABSENCE reads as "a folder to
// send" to whoever asks. Measured once: a site with no queries returned early
// without a state, and a site with nothing to sync emitted an empty folder — one
// that would have removed everything on the far side.
describe('a site with nothing to sync never emits a removing folder', () => {
  it('no queries and no records directory → no records lane', async () => {
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
    w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
    const pkg = await emitSyncPackages(join(ROOT, 'site'))
    expect(pkg.records).toBeNull()
  })

  it('CONTROL — the same site WITH an empty records directory does emit one', async () => {
    w('site/site.yml', 'name: T\nfoundation: "@acme/base"\n')
    w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
    w('site/records/.gitkeep', '')
    const pkg = await emitSyncPackages(join(ROOT, 'site'))
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents).toEqual([])
  })
})

// ⭐ `draft: true` — a record in the folder that is not delivered. A backend holds that as
// the entity's disabled state, and the record entity document carries it as
// `$disabled: true`. Only `true` travels: an absent key means enabled [Diego, 2026-09-21].
// ⛔ Until 2026-09-21 a push refused a draft, because the state could not travel.
const docOf = (pkg, path) =>
  JSON.parse(readZip(pkg.records.buffer).get(`entities/${path}.json`).toString('utf8'))

describe('a draft record is pushed as a disabled entity', () => {
  it('⭐ the draft is sent with `$disabled: true`, and placed in the folder', async () => {
    const root = site()
    w('site/records/article/soon.md', '---\ntitle: Soon\ndraft: true\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(sentIds(pkg)).toContain('article/soon')
    expect(docOf(pkg, 'article/soon').$disabled).toBe(true)
    // `draft` is framework's word, never a Model field
    expect(docOf(pkg, 'article/soon').brief).not.toHaveProperty('draft')
    expect(folderDoc(pkg).contents.map((c) => c.entry?.$ref)).toContain('article/soon')
    expect(pkg.records.index.find((e) => e.id === 'article/soon').draft).toBe(true)
  })

  // ⛔ CONTROL — a record that is not a draft carries no key at all, not even `false`.
  it('CONTROL — a record that is not a draft carries no `$disabled`, even with `draft: false`', async () => {
    const root = site()
    w('site/records/article/kept.md', '---\ntitle: Kept\ndraft: false\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(docOf(pkg, 'article/kept')).not.toHaveProperty('$disabled')
    expect(docOf(pkg, 'article/hello')).not.toHaveProperty('$disabled')
    expect(pkg.records.index.find((e) => e.id === 'article/kept').draft).toBe(false)
    expect(pkg.warnings.some((x) => x.includes('"draft"'))).toBe(false)
  })

  // ⛔ "Send only changed" hashes a document without its `$`-sigils. `$disabled` is state,
  // not identity: stripped, a record drafted with nothing else changed would never be sent.
  it('drafting a record with nothing else changed changes what "send only changed" sees', async () => {
    const root = site()
    const before = entityContentHash(docOf(await emitSyncPackages(root), 'article/hello'))
    w('site/records/article/hello.md', '---\ntitle: Hello\ndraft: true\n---\nBody.\n')
    const after = entityContentHash(docOf(await emitSyncPackages(root), 'article/hello'))
    expect(after).not.toBe(before)
    // CONTROL — un-drafting it returns the hash it had
    w('site/records/article/hello.md', '---\ntitle: Hello\n---\nBody.\n')
    expect(entityContentHash(docOf(await emitSyncPackages(root), 'article/hello'))).toBe(before)
  })

  it('a draft inside a many-record file is disabled alone', async () => {
    const root = site()
    w('site/records/article/batch.yml', '- slug: one\n  title: One\n  draft: true\n- slug: two\n  title: Two\n')
    const pkg = await emitSyncPackages(root)
    expect(docOf(pkg, 'article/one').$disabled).toBe(true)
    expect(docOf(pkg, 'article/two')).not.toHaveProperty('$disabled')
  })

  // ⭐ One reason the push used to REFUSE rather than skip: a site whose records were all
  // drafts would have produced nothing, sent no folder, and left the backend's live.
  it('a site whose records are all drafts still sends its folder', async () => {
    const root = site({ records: false })
    w('site/records/article/soon.md', '---\ntitle: Soon\ndraft: true\n---\n')
    const pkg = await emitSyncPackages(root)
    expect(pkg.records).toBeTruthy()
    expect(folderDoc(pkg).contents.map((c) => c.entry?.$ref)).toEqual(['article/soon'])
  })

  it('⛔ `published: false` is refused on a push too, naming `draft: true`', async () => {
    const root = site()
    w('site/records/article/old.md', '---\ntitle: Old\npublished: false\n---\n')
    await expect(emitSyncPackages(root)).rejects.toThrow(/`published: false` is retired/)
  })

  it('⛔ a `draft:` that is not true or false is refused, naming the file', async () => {
    const root = site()
    w('site/records/article/odd.md', '---\ntitle: Odd\ndraft: soon\n---\n')
    await expect(emitSyncPackages(root)).rejects.toThrow(/records\/article\/odd\.md: `draft:` is true or false/)
  })
})
