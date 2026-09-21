// ⛔ STEPS 1–5 WERE ALL READ-PATH. A restructure that lands only there leaves every
// `uniweb pull` writing the shape it replaced — the site builds from the new layout
// and is projected back into the old one, and nothing reports it because both files
// are individually well-formed.
//
// So this is the criterion the earlier steps could not prove: produce → project →
// produce, comparing the wire documents. A fixed point means the pull wrote files
// the producer reads back identically.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  buildRecordEntities,
  buildFolderEntity,
  recordsToProject,
  toDataSchemaDeclaration,
} from '../src/uwx/index.js'

// The AUTHORING schema, as a foundation's `dist/meta/schema.json` carries it.
const ARTICLE_SCHEMA = {
  name: 'article',
  brief: true,
  fields: { title: { type: 'string' }, body: { type: 'text', format: 'markdown' } },
}
const SCHEMA_JSON = { dataSchemas: { '@/article': ARTICLE_SCHEMA } }

// ⛔ THE DECLARATION IS LOWERED THE SAME WAY THE PRODUCER LOWERS IT, not written
// by hand. A hand-made one drifts from what the sync lane actually resolved — the
// first draft of this fixture declared `body` unlocalized while the producer had
// wrapped it per-locale, and the round trip "failed" on the fixture rather than on
// the code.
const ARTICLE_DECL = toDataSchemaDeclaration(ARTICLE_SCHEMA, { name: '@acme/article' })
const resolveDeclaration = (name) => (name === '@acme/article' ? ARTICLE_DECL : null)

let ROOT
const w = (root) => (rel, body) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

// A site whose folder has BOTH shapes: a record at the top and a labelled branch.
// A flat-only fixture would pass for a projector that could not write a branch.
// ⭐ `hello` needs no line: every record in `records/` sits at the top of the folder
// unless `records/folder.yml` places it (ruled 2026-09-21).
const BACKEND = 'http://backend.test'

const FOLDER_YML = [
  '- folder: archive',
  '  label: The Archive',
  '  records:',
  '    - article/older.md',
  '',
].join('\n')

const seed = (dir) => {
  const write = w(dir)
  write('site/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
  write('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  write('site/records/article/hello.md', '---\n$uuid: U1\ntitle: Hello\n---\n\nBody one.\n')
  write('site/records/article/older.md', '---\n$uuid: U2\ntitle: Older\n---\n\nBody two.\n')
  write('site/records/folder.yml', FOLDER_YML)
  write('fdn/dist/meta/schema.json', SCHEMA_JSON)
  // ⭐ The backend has already minted U1 and U2 — this is a RE-push. The file holds
  // the records' own ids; the map says what this backend calls them (identity, since
  // it is the backend that minted them). Without it the wire carries no uuids, which
  // is correct for a backend that has never seen these records, and is not what a
  // round trip against the one that stores them looks like.
  write('site/sync.json', {
    version: 1,
    backends: { [BACKEND]: { site: { org: 'acme' }, records: { U1: 'U1', U2: 'U2' } } }
  })
  return join(dir, 'site')
}

const produce = async (siteRoot) => {
  const col = await buildRecordEntities(siteRoot, { org: '@acme', backend: BACKEND })
  const folder = buildFolderEntity({
    recordEntities: col.entities,
    folderNodes: col.folder.nodes,
    declared: col.sendFolder === true,
  })
  return { col, folder }
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'records-rt-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('push → pull → push is a fixed point', () => {
  it('reproduces the same folder and record documents through a projection', async () => {
    const src = seed(ROOT)
    const first = await produce(src)

    // CONTROL — the producer really did carry both shapes, so a fixed point below
    // is about round-tripping them rather than about there being nothing to lose.
    expect(first.folder.document.contents).toHaveLength(2)
    // the branch's handle is `name`; its display text rides as a localized map
    expect(first.folder.document.contents[0].name).toBe('archive')
    expect(first.folder.document.contents[0].label).toEqual({ en: 'The Archive' })
    expect(first.folder.document.contents[1].name).toBe('hello')
    expect(first.col.entities.map((e) => e.id)).toEqual(['article/hello', 'article/older'])

    // Project into a FRESH site — no records/, no folder.yml — the way a clone does.
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/sync.json', { version: 1, backends: { [BACKEND]: { site: { org: 'acme' } } } })
    writeDest('dest/package.json', { name: 'dest', dependencies: { '@acme/base': 'file:../fdn' } })

    const report = recordsToProject({
      folderDoc: first.folder.document,
      recordDocs: first.col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.warnings).toEqual([])
    expect(report.records).toBe('updated')

    // ⭐ The pull wrote the NEW files, in the new layout.
    expect(existsSync(join(dest, 'records', 'folder.yml'))).toBe(true)
    // ⭐ `records/article/`, not `records/acme/article/`. The producer resolves
    // `@/article` to `@acme/article` before it ships; the pull undoes that against
    // the site's own `$org`, or the next build reads a different schema.
    expect(existsSync(join(dest, 'records', 'article', 'hello.md'))).toBe(true)
    expect(existsSync(join(dest, 'collections'))).toBe(false)

    const second = await produce(dest)
    expect(second.folder.document).toEqual(first.folder.document)
    expect(second.col.entities.map((e) => e.document)).toEqual(
      first.col.entities.map((e) => e.document)
    )
  })

  it('the projected folder.yml is the folder\'s ORGANIZATION, in the shape an author writes', async () => {
    const src = seed(ROOT)
    const { col, folder } = await produce(src)
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/sync.json', { version: 1, backends: { [BACKEND]: { site: { org: 'acme' } } } })
    writeDest('dest/package.json', { name: 'dest', dependencies: { '@acme/base': 'file:../fdn' } })
    recordsToProject({
      folderDoc: folder.document,
      recordDocs: col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })

    // Only the sub-folder: the record at the top needs no line.
    expect(yaml.load(readFileSync(join(dest, 'records', 'folder.yml'), 'utf8'))).toEqual([
      { folder: 'archive', label: 'The Archive', records: ['article/older.md'] },
    ])
  })

  // ⭐ folder.yml CARRIES ONLY SUB-FOLDERS NOW, and no state of it removes a record,
  // so a pull mirrors the backend's organization — including having none.
  it('a pull that carried no folder leaves folder.yml untouched', async () => {
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\n')
    writeDest('dest/records/folder.yml', '- folder: kept\n  records:\n    - article/kept.md\n')
    const report = recordsToProject({
      folderDoc: null,
      recordDocs: [],
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.records).toBe('skipped')
    expect(readFileSync(join(dest, 'records', 'folder.yml'), 'utf8')).toBe('- folder: kept\n  records:\n    - article/kept.md\n')
  })

  it('a folder with no sub-folders REMOVES a local folder.yml — it could only describe ones the backend no longer has', async () => {
    const src = seed(ROOT)
    const flat = await produce(src)
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/sync.json', { version: 1, backends: { [BACKEND]: { site: { org: 'acme' } } } })
    writeDest('dest/records/folder.yml', '- folder: stale\n  records:\n    - article/hello.md\n')
    const report = recordsToProject({
      // the backend's folder, flattened: both records at the top
      folderDoc: { contents: flat.folder.document.contents.flatMap((n) => (n.kind === 'branch' ? n.$children : [n])) },
      recordDocs: flat.col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.records).toBe('removed')
    expect(existsSync(join(dest, 'records', 'folder.yml'))).toBe(false)
    // CONTROL — the records themselves landed; only the organization went.
    expect(existsSync(join(dest, 'records', 'article', 'hello.md'))).toBe(true)
    expect(existsSync(join(dest, 'records', 'article', 'older.md'))).toBe(true)
  })

  it('CONTROL — with no local folder.yml, a flat folder writes none', async () => {
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\n')
    const report = recordsToProject({
      folderDoc: { contents: [] },
      recordDocs: [],
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.records).toBe('unchanged')
    expect(existsSync(join(dest, 'records', 'folder.yml'))).toBe(false)
  })

  it('a placed record that did not land is reported, and the file is left alone', async () => {
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\n')
    const kept = '- folder: archive\n  records:\n    - article/kept.md\n'
    writeDest('dest/records/folder.yml', kept)
    const report = recordsToProject({
      folderDoc: {
        contents: [
          {
            kind: 'branch',
            name: 'archive',
            $children: [{ kind: 'ref', name: 'ghost', entry: { model: '@acme/article', entity: 'U9' } }],
          },
        ],
      },
      recordDocs: [], // the record never arrived
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.records).toBe('skipped')
    expect(report.warnings.some((x) => x.includes('not written locally'))).toBe(true)
    // ⚠️ Writing the file without it would move the record to the top of the folder.
    expect(readFileSync(join(dest, 'records', 'folder.yml'), 'utf8')).toBe(kept)
  })

  it('a record at the top that did not land is reported too — the next push would drop it', async () => {
    const dest = join(ROOT, 'dest')
    w(ROOT)('dest/site.yml', 'name: T\n')
    const report = recordsToProject({
      folderDoc: { contents: [{ kind: 'ref', name: 'ghost', entry: { model: '@acme/article', entity: 'U9' } }] },
      recordDocs: [],
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND },
    })
    expect(report.warnings.some((x) => x.includes('"ghost"') && x.includes('remove it from the folder'))).toBe(true)
  })
})
