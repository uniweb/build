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

// A site whose folder has BOTH shapes: records at the root and a labelled branch.
// A flat-only fixture would pass for a projector that could not write a branch.
const RECORDS_YML = [
  '- article/hello.md',
  '- folder: archive',
  '  label: The Archive',
  '  records:',
  '    - article/older.md',
  '',
].join('\n')

const seed = (dir) => {
  const write = w(dir)
  write('site/site.yml', '$org: acme\nname: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
  write('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  write('site/entities/article/hello.md', '---\n$uuid: U1\ntitle: Hello\n---\n\nBody one.\n')
  write('site/entities/article/older.md', '---\n$uuid: U2\ntitle: Older\n---\n\nBody two.\n')
  write('site/records.yml', RECORDS_YML)
  write('fdn/dist/meta/schema.json', SCHEMA_JSON)
  return join(dir, 'site')
}

const produce = async (siteRoot) => {
  const col = await buildRecordEntities(siteRoot, { org: '@acme' })
  const folder = buildFolderEntity({
    recordEntities: col.entities,
    folderNodes: col.folder.nodes,
    declared: col.recordsState !== 'missing',
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
    expect(first.folder.document.contents[1].name).toBe('The Archive')
    expect(first.col.entities.map((e) => e.id)).toEqual(['article/hello', 'article/older'])

    // Project into a FRESH site — no entities/, no records.yml — the way a clone does.
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', '$org: acme\nname: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/package.json', { name: 'dest', dependencies: { '@acme/base': 'file:../fdn' } })

    const report = recordsToProject({
      folderDoc: first.folder.document,
      recordDocs: first.col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration },
    })
    expect(report.warnings).toEqual([])
    expect(report.records).toBe('updated')

    // ⭐ The pull wrote the NEW files, in the new layout.
    expect(existsSync(join(dest, 'records.yml'))).toBe(true)
    // ⭐ `entities/article/`, not `entities/acme/article/`. The producer resolves
    // `@/article` to `@acme/article` before it ships; the pull undoes that against
    // the site's own `$org`, or the next build reads a different schema.
    expect(existsSync(join(dest, 'entities', 'article', 'hello.md'))).toBe(true)
    expect(existsSync(join(dest, 'collections'))).toBe(false)

    const second = await produce(dest)
    expect(second.folder.document).toEqual(first.folder.document)
    expect(second.col.entities.map((e) => e.document)).toEqual(
      first.col.entities.map((e) => e.document)
    )
  })

  it('the projected records.yml is the folder, in the shape an author writes', async () => {
    const src = seed(ROOT)
    const { col, folder } = await produce(src)
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', '$org: acme\nname: T\nfoundation: "@acme/base"\nqueries:\n  articles:\n    schema: "@/article"\n')
    writeDest('dest/package.json', { name: 'dest', dependencies: { '@acme/base': 'file:../fdn' } })
    recordsToProject({
      folderDoc: folder.document,
      recordDocs: col.entities.map((e) => e.document),
      siteRoot: dest,
      opts: { resolveDeclaration },
    })

    expect(yaml.load(readFileSync(join(dest, 'records.yml'), 'utf8'))).toEqual([
      'article/hello.md',
      { folder: 'archive', label: 'The Archive', records: ['article/older.md'] },
    ])
  })

  // ⛔ AN EMPTY RESULT IS NOT WRITTEN. An empty `records.yml` REMOVES on the next
  // push, so a pull carrying no folder must leave the file alone rather than
  // author the destructive state on the author's behalf.
  it('a pull with no folder leaves records.yml untouched', async () => {
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\n')
    writeDest('dest/records.yml', '- article/kept.md\n')
    const report = recordsToProject({
      folderDoc: { contents: [] },
      recordDocs: [],
      siteRoot: dest,
      opts: { resolveDeclaration },
    })
    expect(report.records).toBe('skipped')
    expect(readFileSync(join(dest, 'records.yml'), 'utf8')).toBe('- article/kept.md\n')
  })

  it('a leaf whose record did not land is reported, and the file is left alone', async () => {
    const dest = join(ROOT, 'dest')
    const writeDest = w(ROOT)
    writeDest('dest/site.yml', 'name: T\n')
    writeDest('dest/records.yml', '- article/kept.md\n')
    const report = recordsToProject({
      folderDoc: {
        contents: [{ kind: 'ref', path_segment: 'ghost', entry: { model: '@acme/article', entity: 'U9' } }],
      },
      recordDocs: [], // the record never arrived
      siteRoot: dest,
      opts: { resolveDeclaration },
    })
    expect(report.records).toBe('skipped')
    expect(report.warnings.some((x) => x.includes('not written locally'))).toBe(true)
    // ⚠️ Writing the file without that leaf would quietly unpublish the record.
    expect(readFileSync(join(dest, 'records.yml'), 'utf8')).toBe('- article/kept.md\n')
  })
})
