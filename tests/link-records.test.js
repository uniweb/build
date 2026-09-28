/**
 * Link records — `@uniweb/link` (2026-09-28).
 *
 * A file in `records/uniweb/link/` holding a `url` is a record like any other on the file side —
 * placed by `records/folder.yml`, which gives its label and tags, and compiled by a static build.
 * On the wire it is a folder entry of kind `link`, holding its data, never an entity: a push sends
 * `{ kind: 'link', name, url, label?, tags? }` under the uuid the backend holds it by, and a pull
 * writes each link entry back as its file.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'
import { recordsToProject } from '../src/uwx/records-project.js'
import { stampFolderItemUuids } from '../src/uwx/folder.js'
import { backfillLinkUuids, linkRecordRefusal } from '../src/uwx/link-records.js'

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
  ROOT = mkdtempSync(join(tmpdir(), 'link-records-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  writeFileSync(join(fdn, 'dist', 'meta', 'schema.json'), JSON.stringify({ _self: { name: '@acme/marketing', version: '1' } }))
  w('site.yml', 'name: Acme\nfoundation: "@acme/marketing"\n')
  w('package.json', { name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } })
  w('queries.yml', 'videos:\n  schema: "@uniweb/link"\n')
  w('records/uniweb/link/launch-video.yml', 'url: https://www.youtube.com/watch?v=abc\n')
  w('records/uniweb/link/tour.json', { url: 'https://vimeo.com/1' })
  w(
    'records/folder.yml',
    '- folder: media\n  label: Media\n  records:\n' +
      '    - path: uniweb/link/launch-video.yml\n      label: { en: Launch video, fr: Vidéo de lancement }\n      tags: [media]\n' +
      '    - uniweb/link/tour.json\n'
  )
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a static build compiles link records like any record', () => {
  it('as briefs in the list and whole in each record’s own file — the shape a records service answers', async () => {
    const queries = { videos: { schema: '@uniweb/link' } }
    await writeQueryFiles(SITE, await processQueries(SITE, queries, undefined, '/', { locale: 'en' }), queries)
    const list = JSON.parse(read('public/data/videos.json'))
    expect(list.map(({ $branch: _b, ...r }) => r)).toEqual([
      { url: 'https://www.youtube.com/watch?v=abc', $name: 'launch-video', $tags: ['media'], $label: 'Launch video' },
      { url: 'https://vimeo.com/1', $name: 'tour' },
    ])
    expect(JSON.parse(read('public/data/videos/launch-video.json'))).toEqual({
      $name: 'launch-video',
      brief: { url: 'https://www.youtube.com/watch?v=abc' },
      $tags: ['media'],
      $label: 'Launch video',
    })
  })
})

describe('a push sends each link as a folder entry, never an entity', () => {
  it('the folder carries `{ kind: link, name, url }` with its label and tags; no entity of @uniweb/link rides', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.refusals).toEqual([])
    expect(pkg.records.models).not.toContain('@uniweb/link')
    expect(pkg.records.index).toEqual([{ kind: 'folder' }])
    const [media] = folderOf(pkg).contents
    expect(media).toMatchObject({ kind: 'branch', name: 'media', label: { en: 'Media' } })
    expect(media.$children).toEqual([
      { kind: 'link', name: 'launch-video', url: 'https://www.youtube.com/watch?v=abc', label: { en: 'Launch video', fr: 'Vidéo de lancement' }, tags: ['media'] },
      { kind: 'link', name: 'tour', url: 'https://vimeo.com/1' },
    ])
    // The caller banks each link's uuid from the folder the backend returns.
    expect(pkg.records.links.map((l) => [l.slug, l.ownId, l.uuid])).toEqual([['launch-video', null, null], ['tour', null, null]])
  })

  it('a link this backend holds goes under its uuid, mapped from the file’s own id', async () => {
    w('records/uniweb/link/launch-video.yml', '$uuid: OWN-1\nurl: https://www.youtube.com/watch?v=abc\n')
    w('sync.json', { backends: { 'http://b': { records: { 'OWN-1': 'THEIRS-1' } } } })
    const pkg = await emitSyncPackages(SITE, { backend: 'http://b' })
    const [media] = folderOf(pkg).contents
    expect(media.$children[0]).toMatchObject({ kind: 'link', name: 'launch-video', $uuid: 'THEIRS-1' })
    expect(media.$children[1]).not.toHaveProperty('$uuid')
  })

  it('a query over link records is not schema-less, and names @uniweb/link', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.schemaless).toEqual([])
    const site = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(site.queries.find((q) => q.name === 'videos').schema).toBe('@uniweb/link')
  })

  it('a site whose only records are links still sends its folder', async () => {
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.records).toBeTruthy()
    expect(folderOf(pkg).contents).toHaveLength(1)
  })
})

describe('what a link record may not say', () => {
  const refused = async (file, body) => {
    w(file, body)
    return (await emitSyncPackages(SITE)).refusals.join('\n')
  }
  it('a label or tags — they are its folder entry’s', async () => {
    expect(await refused('records/uniweb/link/tour.json', { url: 'https://vimeo.com/1', label: 'Tour' })).toMatch(/`label:` is its folder entry's/)
  })
  it('a draft — a link cannot be kept off a published site yet', async () => {
    expect(await refused('records/uniweb/link/tour.json', { url: 'https://vimeo.com/1', draft: true })).toMatch(/a draft link is not sent/)
  })
  it('anything but its url', async () => {
    expect(await refused('records/uniweb/link/tour.json', { url: 'https://vimeo.com/1', title: 'Tour' })).toMatch(/holds its `url` and nothing else — not `title:`/)
  })
  it('no url', async () => {
    expect(await refused('records/uniweb/link/tour.json', {})).toMatch(/needs a `url`/)
  })
  it('a body', () => {
    expect(linkRecordRefusal({ data: { url: 'x' }, body: 'Some text' }, 'x.md')).toMatch(/has no body/)
  })
  it('two files of one name', async () => {
    w('records/uniweb/link/tour.yml', 'url: https://vimeo.com/2\n')
    expect((await emitSyncPackages(SITE)).refusals.join('\n')).toMatch(/a link named "tour" is also/)
  })
})

describe('the uuid a backend gives a link is banked as a record’s', () => {
  it('into a file with no own id — the first backend it reaches — and mapped where it has one', () => {
    const file = join(SITE, 'records/uniweb/link/tour.json')
    const folderDoc = {
      contents: [
        { kind: 'branch', name: 'media', $uuid: 'B1', $children: [
          { kind: 'link', name: 'launch-video', url: 'x', $uuid: 'THEIRS-1' },
          { kind: 'link', name: 'tour', url: 'y', $uuid: 'THEIRS-2' },
        ] },
      ],
    }
    const links = [
      { slug: 'launch-video', ownId: 'OWN-1', sourceFile: join(SITE, 'records/uniweb/link/launch-video.yml') },
      { slug: 'tour', ownId: null, sourceFile: file },
    ]
    const out = backfillLinkUuids({ links, folderDoc })
    expect(out.mapped).toEqual({ 'OWN-1': 'THEIRS-1', 'THEIRS-2': 'THEIRS-2' })
    expect(out.updated).toEqual([file])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ $uuid: 'THEIRS-2', url: 'https://vimeo.com/1' })
  })

  it('a banked placement is never stamped over a link’s own uuid', () => {
    const doc = { contents: [{ kind: 'link', name: 'tour', url: 'y', $uuid: 'THEIRS-2' }, { kind: 'branch', name: 'media', $children: [] }] }
    stampFolderItemUuids(doc, { tour: 'OLD', media: 'THEIRS-2' })
    expect(doc.contents[0].$uuid).toBe('THEIRS-2')
    // …and no other item takes it
    expect(doc.contents[1].$uuid).toBeUndefined()
  })
})

describe('a pull writes each link entry back as its file', () => {
  const folderDoc = {
    contents: [
      { kind: 'branch', name: 'media', label: { en: 'Media' }, $children: [
        { kind: 'link', name: 'launch-video', url: 'https://www.youtube.com/watch?v=abc', $uuid: 'T1', label: { en: 'Launch video', fr: 'Vidéo de lancement' }, tags: ['media'] },
      ] },
      { kind: 'link', name: 'press-kit', url: 'https://example.com/press', $uuid: 'T2', label: { en: 'Press kit' } },
    ],
  }
  const pull = (doc = folderDoc) =>
    recordsToProject({ folderDoc: doc, recordDocs: [], siteRoot: SITE, opts: { resolveDeclaration: () => null, backend: 'http://b' } })

  it('a link it does not hold becomes a file in records/uniweb/link/, placed by folder.yml', () => {
    rmSync(join(SITE, 'records'), { recursive: true, force: true })
    const out = pull()
    expect(out.warnings).toEqual([])
    expect(yaml.load(read('records/uniweb/link/launch-video.yml'))).toEqual({ $uuid: 'T1', url: 'https://www.youtube.com/watch?v=abc' })
    expect(yaml.load(read('records/uniweb/link/press-kit.yml'))).toEqual({ $uuid: 'T2', url: 'https://example.com/press' })
    expect(yaml.load(read('records/folder.yml'))).toEqual([
      { folder: 'media', label: 'Media', records: [
        { path: 'uniweb/link/launch-video.yml', tags: ['media'], label: { en: 'Launch video', fr: 'Vidéo de lancement' } },
      ] },
      { path: 'uniweb/link/press-kit.yml', label: 'Press kit' },
    ])
    // ⛔ Not the warning a pull gave until 2026-09-28: "a push from here would remove it".
    expect(out.warnings.join('\n')).not.toMatch(/would remove it/)
    // …and each link's identity is mapped for this backend
    expect(JSON.parse(read('sync.json')).backends['http://b'].records).toMatchObject({ T1: 'T1', T2: 'T2' })
  })

  it('a link it holds is found by its own id, and only its url is rewritten', () => {
    rmSync(join(SITE, 'records'), { recursive: true, force: true })
    w('records/uniweb/link/my-video.json', { $uuid: 'OWN', url: 'https://old.example' })
    w('sync.json', { backends: { 'http://b': { records: { OWN: 'T1' } } } })
    pull()
    expect(JSON.parse(read('records/uniweb/link/my-video.json'))).toEqual({ $uuid: 'OWN', url: 'https://www.youtube.com/watch?v=abc' })
    expect(existsSync(join(SITE, 'records/uniweb/link/launch-video.yml'))).toBe(false)
    expect(read('records/folder.yml')).toContain('uniweb/link/my-video.json')
  })

  it('⛔ a file of that name holding another link is not written over', () => {
    rmSync(join(SITE, 'records'), { recursive: true, force: true })
    w('records/uniweb/link/press-kit.yml', '$uuid: SOMEONE-ELSE\nurl: https://other.example\n')
    const out = pull()
    expect(out.warnings.join('\n')).toMatch(/holds another link than the folder's "press-kit"/)
    expect(yaml.load(read('records/uniweb/link/press-kit.yml')).url).toBe('https://other.example')
  })
})

describe('round trip', () => {
  it('what a push sends, a pull writes back as the same files', async () => {
    const pkg = await emitSyncPackages(SITE)
    const sent = folderOf(pkg)
    // The backend gives each entry its uuid, and the push banks it into the files.
    let n = 0
    const stamp = (nodes) => nodes.forEach((node) => { node.$uuid = `U${++n}`; if (node.$children) stamp(node.$children) })
    stamp(sent.contents)
    backfillLinkUuids({ links: pkg.records.links, folderDoc: sent })
    const before = {
      video: read('records/uniweb/link/launch-video.yml'),
      tour: read('records/uniweb/link/tour.json'),
      folder: yaml.load(read('records/folder.yml')),
    }
    recordsToProject({ folderDoc: sent, recordDocs: [], siteRoot: SITE, opts: { resolveDeclaration: () => null } })
    expect(read('records/uniweb/link/launch-video.yml')).toBe(before.video)
    expect(read('records/uniweb/link/tour.json')).toBe(before.tour)
    expect(yaml.load(read('records/folder.yml'))).toEqual(before.folder)
  })
})
