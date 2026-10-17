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
// The scope in the foundation's name, `@acme/base` — what a record's `@/article`
// resolves into on push, and what a pull undoes. Stated, as `uniweb pull` states it
// (it resolves the scope up front); this fixture's foundation has no `main.js` to read
// it from. ⛔ Not the site owner's org, which pull read from sync.json until 2026-09-22.
const SCOPE = '@acme'

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
  const col = await buildRecordEntities(siteRoot, { scope: SCOPE, backend: BACKEND })
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
    })
    expect(report.warnings).toEqual([])
    expect(report.records).toBe('updated')

    // ⭐ The pull wrote the NEW files, in the new layout.
    expect(existsSync(join(dest, 'records', 'folder.yml'))).toBe(true)
    // ⭐ `records/article/`, not `records/acme/article/`. The producer resolves
    // `@/article` to `@acme/article` before it ships; the pull undoes that against
    // the foundation's scope, or the next build reads a different schema.
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
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
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
    })
    expect(report.warnings.some((x) => x.includes('"ghost"') && x.includes('remove it from the folder'))).toBe(true)
  })
})

// ⭐ A DEVELOPER'S PATTERN IS KEPT WHILE IT SAYS WHAT THE FOLDER SAYS. Measured 2026-10-17 on a
// published CLI: a pull after an author edited one record wrote `member/*.md` as the files there at
// that moment, and a record added afterwards was pushed outside it — to the top of the folder — while
// the file went on saying nothing about it.
describe('a folder.yml written with a pattern', () => {
  const PATTERN_YML = [
    '# what the archive holds',
    '- folder: archive',
    '  label: The Archive',
    '  records:',
    '    - article/*.md',
    '',
  ].join('\n')
  const seedPattern = () => {
    const site = seed(ROOT)
    w(ROOT)('site/records/folder.yml', PATTERN_YML)
    return site
  }
  const pull = (site, folder, recordDocs) =>
    recordsToProject({ folderDoc: folder, recordDocs, siteRoot: site, opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE } })
  const namesIn = (folder) => folder.document.contents[0].$children.map((n) => n.name)

  it('⭐ is left as written by a pull whose folder places what it places', async () => {
    const site = seedPattern()
    const { col, folder } = await produce(site)
    // CONTROL — the pattern placed both records in the archive.
    expect(namesIn(folder)).toEqual(['hello', 'older'])
    const report = pull(site, folder.document, col.entities.map((e) => e.document))
    expect(report.records).toBe('unchanged')
    expect(readFileSync(join(site, 'records', 'folder.yml'), 'utf8')).toBe(PATTERN_YML)
  })

  it('⭐ …so it places a record added after the pull', async () => {
    const site = seedPattern()
    const { col, folder } = await produce(site)
    pull(site, folder.document, col.entities.map((e) => e.document))
    w(ROOT)('site/records/article/newer.md', '---\ntitle: Newer\n---\n\nBody three.\n')
    expect(namesIn((await produce(site)).folder)).toEqual(['hello', 'newer', 'older'])
  })

  it('a record added and not pushed yet is no difference: the backend does not hold it', async () => {
    const site = seedPattern()
    const { col, folder } = await produce(site)
    w(ROOT)('site/records/article/newer.md', '---\ntitle: Newer\n---\n\nBody three.\n')
    expect(pull(site, folder.document, col.entities.map((e) => e.document)).records).toBe('unchanged')
    expect(readFileSync(join(site, 'records', 'folder.yml'), 'utf8')).toBe(PATTERN_YML)
  })

  it('CONTROL — a record the folder no longer places there is written as the folder places it', async () => {
    const site = seedPattern()
    const { col, folder } = await produce(site)
    // An author moved `hello` out of the archive, to the top of the folder.
    const [archive] = folder.document.contents
    const hello = archive.$children.find((n) => n.name === 'hello')
    const moved = { contents: [{ ...archive, $children: archive.$children.filter((n) => n !== hello) }, hello] }
    expect(pull(site, moved, col.entities.map((e) => e.document)).records).toBe('updated')
    expect(yaml.load(readFileSync(join(site, 'records', 'folder.yml'), 'utf8'))).toEqual([
      { folder: 'archive', label: 'The Archive', records: ['article/older.md'] },
    ])
  })

  it('an edited record keeps a blank line after its front matter, and ends with a newline', async () => {
    const site = seedPattern()
    const { col, folder } = await produce(site)
    // CONTROL — a push sends the body as the file holds it, its newlines included, so a round
    // trip through the CLI alone could never have lost them.
    const hello = col.entities.find((e) => e.id === 'article/hello').document
    expect(hello.brief.body).toEqual({ en: '\nBody one.\n' })
    // The author edited `hello` in the app, which saves a body without them.
    const edited = JSON.parse(JSON.stringify(hello).replace('"\\nBody one.\\n"', '"Body one, edited."'))
    const docs = col.entities.map((e) => (e.id === 'article/hello' ? edited : e.document))
    pull(site, folder.document, docs)
    expect(readFileSync(join(site, 'records', 'article', 'hello.md'), 'utf8')).toBe(
      '---\n$uuid: U1\ntitle: Hello\n---\n\nBody one, edited.\n'
    )
  })
})

// ⭐ A DRAFT ROUND-TRIPS. `draft: true` goes out as the entity's `$disabled: true` and
// comes back as `draft: true`, so push → pull → push stays a fixed point with one in it.
describe('a draft survives the round trip', () => {
  const freshDest = () => {
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/sync.json', { version: 1, backends: { [BACKEND]: { site: { org: 'acme' } } } })
    writeDest('dest/package.json', { name: 'dest', dependencies: { '@acme/base': 'file:../fdn' } })
    return join(ROOT, 'dest')
  }

  it('push → pull → push keeps it a draft', async () => {
    const src = seed(ROOT)
    w(ROOT)('site/records/article/hello.md', '---\n$uuid: U1\ntitle: Hello\ndraft: true\n---\n\nBody one.\n')
    const first = await produce(src)
    const byId = (p) => Object.fromEntries(p.col.entities.map((e) => [e.id, e.document]))
    expect(byId(first)['article/hello'].$disabled).toBe(true)
    // CONTROL — the other record is not a draft, and carries no key
    expect(byId(first)['article/older']).not.toHaveProperty('$disabled')

    const dest = freshDest()
    recordsToProject({
      folderDoc: first.folder.document,
      recordDocs: first.col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
    })
    expect(readFileSync(join(dest, 'records', 'article', 'hello.md'), 'utf8')).toContain('draft: true')
    expect(readFileSync(join(dest, 'records', 'article', 'older.md'), 'utf8')).not.toContain('draft')

    const second = await produce(dest)
    expect(second.col.entities.map((e) => e.document)).toEqual(first.col.entities.map((e) => e.document))
  })

  // An absent key means enabled, so a pull that finds a record re-enabled on the backend
  // must drop the local line — kept, the next push would disable it again.
  it('a record re-enabled on the backend comes back without its `draft:` line', async () => {
    const src = seed(ROOT)
    const { col, folder } = await produce(src) // the backend's copy: enabled
    w(ROOT)('site/records/article/hello.md', '---\n$uuid: U1\ntitle: Hello\ndraft: true\n---\n\nBody one.\n')
    recordsToProject({
      folderDoc: folder.document,
      recordDocs: col.entities.map((e) => e.document),
      siteRoot: src,
      opts: { resolveDeclaration, backend: BACKEND, scope: SCOPE },
    })
    expect(readFileSync(join(src, 'records', 'article', 'hello.md'), 'utf8')).not.toContain('draft')
  })
})
