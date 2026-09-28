/**
 * File records — `@uniweb/file` (2026-09-28).
 *
 * The file itself is the record: any file placed in `records/uniweb/file/` is a record named by its
 * stem, its label and tags on its `records/folder.yml` entry. Its value is an asset —
 * `{ url, name, mime, size, preview? }` on every lane — and on the wire it is a folder entry of kind
 * `file`, never an entity: the push writes an upload key where the URL goes, uploads the file through
 * the media lane, and its second emit swaps the key for the serve URL and stamps the asset's identity.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { readEntityPool } from '../src/site/entity-pool.js'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'
import { recordsToProject } from '../src/uwx/records-project.js'
import { bankedFileUuids, filesToPull } from '../src/uwx/file-records.js'
import { linkRecordRefusal } from '../src/uwx/link-records.js'

let ROOT, SITE
const w = (rel, body) => {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}
const read = (rel) => readFileSync(join(SITE, rel), 'utf8')
const folderOf = (pkg) => JSON.parse(readZip(pkg.records.buffer).get('entities/folder.json').toString('utf8'))

let log, warn
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'file-records-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  writeFileSync(join(fdn, 'dist', 'meta', 'schema.json'), JSON.stringify({ _self: { name: '@acme/marketing', version: '1' } }))
  w('site.yml', 'name: Acme\nfoundation: "@acme/marketing"\n')
  w('package.json', { name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } })
  w('queries.yml', 'downloads:\n  schema: "@uniweb/file"\n')
  w('records/uniweb/file/brochure.pdf', '%PDF-1.4 not really')
  w('records/uniweb/file/price-list.xlsx', 'xlsx bytes')
  w('records/uniweb/file/notes.yml', 'this: is a file, not a record’s data\n')
  w('records/folder.yml', '- path: uniweb/file/brochure.pdf\n  label: { en: Brochure, fr: Brochure (fr) }\n  tags: [print]\n')
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('the file itself is the record', () => {
  it('any file in records/uniweb/file/ is one, named by its stem — nothing in it is read', async () => {
    const pool = await readEntityPool(SITE)
    expect(pool.entities.filter((e) => e.fileRecord).map((e) => [e.slug, e.schema])).toEqual([
      ['brochure', '@uniweb/file'],
      ['notes', '@uniweb/file'],
      ['price-list', '@uniweb/file'],
    ])
  })

  it('two files of one stem are not both records — the second is reported', async () => {
    w('records/uniweb/file/brochure.docx', 'docx bytes')
    const pool = await readEntityPool(SITE)
    expect(pool.entities.filter((e) => e.slug === 'brochure')).toHaveLength(1)
    expect(pool.errors.join('\n')).toMatch(/a file record is named by its file, and brochure\.docx is named "brochure" too/)
  })

  it('CONTROL — a file of another type elsewhere in records/ is still no record', async () => {
    w('records/article/cover.png', 'png bytes')
    const pool = await readEntityPool(SITE)
    expect(pool.entities.some((e) => e.file === 'cover.png')).toBe(false)
  })
})

describe('a static build delivers each as an asset', () => {
  it('`{ url, name, mime, size }`, the file published under records/, its label and tags beside it', async () => {
    const queries = { downloads: { schema: '@uniweb/file' } }
    await writeQueryFiles(SITE, await processQueries(SITE, queries, undefined, '/', { locale: 'en' }), queries)
    const list = JSON.parse(read('public/data/downloads.json')).map(({ $branch: _b, ...r }) => r)
    expect(list[0]).toEqual({
      file: { url: '/records/uniweb/file/brochure.pdf', name: 'brochure.pdf', mime: 'application/pdf', size: 19 },
      $name: 'brochure',
      $tags: ['print'],
      $label: 'Brochure',
    })
    expect(list[2].file).toMatchObject({ url: '/records/uniweb/file/price-list.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    expect(existsSync(join(SITE, 'public/records/uniweb/file/price-list.xlsx'))).toBe(true)
    expect(JSON.parse(read('public/data/downloads/brochure.json')).brief.file.url).toBe('/records/uniweb/file/brochure.pdf')
  })
})

describe('a push sends each as a folder entry of kind `file`, its value an asset', () => {
  it('first with an upload key where the URL goes, and the files it uploads', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.refusals).toEqual([])
    expect(pkg.records.models).not.toContain('@uniweb/file')
    const [brochure] = folderOf(pkg).contents
    expect(brochure).toEqual({
      kind: 'file',
      name: 'brochure',
      file: { url: 'records/uniweb/file/brochure.pdf', name: 'brochure.pdf', mime: 'application/pdf', size: 19 },
      label: { en: 'Brochure', fr: 'Brochure (fr)' },
      tags: ['print'],
    })
    expect(pkg.localFiles.map((f) => [f.ref, f.contentType])).toEqual([
      ['records/uniweb/file/brochure.pdf', 'application/pdf'],
      ['records/uniweb/file/notes.yml', 'application/yaml'],
      ['records/uniweb/file/price-list.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ])
    expect(pkg.localFiles[0].path).toBe(join(SITE, 'records/uniweb/file/brochure.pdf'))
  })

  it('then, uploaded, with the serve URL and the asset’s identity beside it — under the uuid this backend holds it by', async () => {
    w('sync.json', { backends: { 'http://b': { files: { 'uniweb/file/brochure.pdf': 'THEIRS-1' } } } })
    const pkg = await emitSyncPackages(SITE, {
      backend: 'http://b',
      assetRewrite: { 'records/uniweb/file/brochure.pdf': 'https://cdn.example/a1/base.pdf' },
      assetIds: { 'records/uniweb/file/brochure.pdf': { id: 'a1', ext: 'pdf' } },
    })
    const [brochure] = folderOf(pkg).contents
    expect(brochure.$uuid).toBe('THEIRS-1')
    expect(brochure.file).toEqual({
      url: 'https://cdn.example/a1/base.pdf',
      assetId: 'a1',
      assetExt: 'pdf',
      name: 'brochure.pdf',
      mime: 'application/pdf',
      size: 19,
    })
  })

  it('a query over file records is not schema-less, and names @uniweb/file', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.schemaless).toEqual([])
    const site = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(site.queries.find((q) => q.name === 'downloads').schema).toBe('@uniweb/file')
  })
})

describe('identity, banked by the file’s path', () => {
  it('each entry’s uuid, matched by name', () => {
    const files = [{ slug: 'brochure', poolPath: 'uniweb/file/brochure.pdf' }, { slug: 'notes', poolPath: 'uniweb/file/notes.yml' }]
    const folderDoc = { contents: [{ kind: 'branch', name: 'docs', $children: [{ kind: 'file', name: 'brochure', $uuid: 'F1', file: {} }] }] }
    expect(bankedFileUuids({ files, folderDoc })).toEqual({ 'uniweb/file/brochure.pdf': 'F1' })
  })
})

describe('a pull places each file entry and says what to fetch', () => {
  const entry = (over = {}) => ({
    kind: 'file',
    name: 'annual-report',
    $uuid: 'F9',
    label: { en: 'Annual report' },
    file: { url: 'https://cdn.example/a9/base.pdf', assetId: 'a9', assetExt: 'pdf', name: 'annual-report.pdf', mime: 'application/pdf', size: 1000 },
    ...over,
  })

  it('a file it does not hold lands in records/uniweb/file/<its name>, placed by folder.yml, and is fetched', () => {
    rmSync(join(SITE, 'records'), { recursive: true, force: true })
    const out = recordsToProject({ folderDoc: { contents: [entry()] }, recordDocs: [], siteRoot: SITE, opts: { resolveDeclaration: () => null, backend: 'http://b' } })
    expect(out.warnings).toEqual([])
    expect(out.fileDownloads).toEqual([
      { url: 'https://cdn.example/a9/base.pdf', path: join(SITE, 'records/uniweb/file/annual-report.pdf'), poolPath: 'uniweb/file/annual-report.pdf', ref: 'records/uniweb/file/annual-report.pdf', assetId: 'a9', assetExt: 'pdf' },
    ])
    expect(yaml.load(read('records/folder.yml'))).toEqual([{ path: 'uniweb/file/annual-report.pdf', label: 'Annual report' }])
    expect(JSON.parse(read('sync.json')).backends['http://b'].files).toEqual({ 'uniweb/file/annual-report.pdf': 'F9' })
  })

  it('one it holds, as the same asset, is not fetched again; a changed asset is', () => {
    w('records/uniweb/file/report.pdf', 'bytes')
    const fileMap = { 'uniweb/file/report.pdf': 'F9' }
    const same = filesToPull({ folderDoc: { contents: [entry()] }, recordsRoot: join(SITE, 'records'), fileMap, assetMap: { 'records/uniweb/file/report.pdf': { id: 'a9' } } })
    expect(same.downloads).toEqual([])
    expect(same.pathByUuid.get('F9')).toBe('uniweb/file/report.pdf')
    const moved = filesToPull({ folderDoc: { contents: [entry()] }, recordsRoot: join(SITE, 'records'), fileMap, assetMap: { 'records/uniweb/file/report.pdf': { id: 'OLD' } } })
    expect(moved.downloads.map((d) => d.poolPath)).toEqual(['uniweb/file/report.pdf'])
  })

  it('⛔ a file of that name holding another record is not written over', () => {
    w('records/uniweb/file/annual-report.pdf', 'someone else’s bytes')
    const out = filesToPull({ folderDoc: { contents: [entry()] }, recordsRoot: join(SITE, 'records'), fileMap: {} })
    expect(out.downloads).toEqual([])
    expect(out.warnings.join('\n')).toMatch(/holds another file than the folder's "annual-report"/)
  })
})

describe('a link’s url is absolute — a backend refuses any other (2026-09-28)', () => {
  it('a relative path or a mailto: is refused before anything is sent', () => {
    expect(linkRecordRefusal({ data: { url: '/about' } }, 'x.yml')).toMatch(/a link's `url` is absolute/)
    expect(linkRecordRefusal({ data: { url: 'mailto:ada@example.com' } }, 'x.yml')).toMatch(/is absolute/)
    expect(linkRecordRefusal({ data: { url: 'example.com' } }, 'x.yml')).toMatch(/is absolute/)
  })
  it('CONTROL — scheme://… passes', () => {
    expect(linkRecordRefusal({ data: { url: 'https://example.com/a' } }, 'x.yml')).toBeNull()
    expect(linkRecordRefusal({ data: { url: 'ftp://files.example/x' } }, 'x.yml')).toBeNull()
  })
})
