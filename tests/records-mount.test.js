/**
 * ⭐ Another site's records, mounted: `site.yml::paths`, `records/<type>: <the owner's directory>`.
 *
 * On a backend a site's folder holds references to entities, and one entity can be in several sites'
 * folders [Diego, 2026-11-08: "the same entities can be reference from more than one sites records
 * (folder of entity references)"]. So a site mounts the folder another site's records live in: the
 * build, `uniweb dev` and `validate` read them as its own, a push places a reference to each entity
 * the owner's push made, never a copy, and a pull leaves the owner's files as they are.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntityPool, resolveRecordMounts } from '../src/site/entity-pool.js'
import { processQueries } from '../src/site/query-processor.js'
import { emitSyncPackages, readZip, recordsToProject } from '../src/uwx/index.js'
import { updateBackendMap } from '../src/uwx/sync-store.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'

const BACKEND = 'http://backend.test'
const ADA = '0193f1a2-0000-7000-8000-00000000ada0'
const GRACE = '0193f1a2-0000-7000-8000-0000000097ac'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const MEMBER = validateAndNormalizeSchema({ name: 'member', fields: { name: { type: 'string' } } }, '@/member')
const ARTICLE = validateAndNormalizeSchema(
  { name: 'article', fields: { title: { type: 'string' }, author: { type: 'ref', ref: '@/member' } } },
  '@/article'
)
const MEMBER_DECLARATION = toDataSchemaDeclaration(MEMBER, { name: '@acme/member' })

// The owning site: its member records, pushed, so each file holds its id and the owner's sync.json
// what this backend holds it as.
function hub({ pushed = true } = {}) {
  w('hub/site/site.yml', 'name: Hub\nfoundation: fnd\n')
  w('hub/site/records/member/ada.md', `---\n${pushed ? `$uuid: ${ADA}\n` : ''}name: Ada\n---\n`)
  w('hub/site/records/member/grace.md', `---\n${pushed ? `$uuid: ${GRACE}\n` : ''}name: Grace\n---\n`)
  if (pushed) updateBackendMap(join(ROOT, 'hub/site'), BACKEND, 'records', { [ADA]: ADA, [GRACE]: GRACE })
}

// The site that mounts them, beside an article of its own that names one.
function press() {
  w('press/site/site.yml', 'name: Press\nfoundation: fnd\npaths:\n  records/member: ../../hub/site/records/member\n')
  w('press/site/package.json', { name: 'press-site', dependencies: { fnd: 'file:../fdn' } })
  w('press/site/queries.yml', "members:\n  schema: '@/member'\narticles:\n  schema: '@/article'\n")
  w('press/site/pages/home/page.yml', 'title: Home\n')
  w('press/site/records/article/launch.md', '---\ntitle: Launch\nauthor: ada\n---\n')
  w('press/fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('press/fdn/main.js', "export default { name: '@acme/fnd' }\n")
  // The source a build reads its data schemas from, and the built schema a push reads them from.
  w('press/fdn/schemas/member.yml', 'name: member\nfields:\n  name: string\n')
  w('press/fdn/schemas/article.yml', "name: article\nfields:\n  title: string\n  author: { type: ref, ref: '@/member' }\n")
  w('press/fdn/dist/meta/schema.json', {
    _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
    dataSchemas: { '@/member': MEMBER, '@/article': ARTICLE },
  })
  return join(ROOT, 'press/site')
}

async function pushed(site) {
  const pkg = await emitSyncPackages(site, { backend: BACKEND })
  const docs = [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
  return { pkg, docs, folder: docs.find((d) => d.$schema === '@uniweb/folder') }
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'records-mount-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('the mount', () => {
  it('⭐ the build reads the mounted records as the site\'s own, beside its own records', async () => {
    hub()
    const site = press()
    const pool = await readEntityPool(site)
    expect(pool.errors).toEqual([])
    const members = pool.entities.filter((e) => e.schema === '@/member')
    expect(members.map((e) => e.relPath)).toEqual(['records/member/ada.md', 'records/member/grace.md'])
    expect(members[0].mounted.from).toBe(join(ROOT, 'hub/site/records/member'))
    expect(members[0].mounted.owner).toBe(join(ROOT, 'hub/site'))
    const byQuery = await processQueries(site, { members: { schema: '@/member' } }, undefined, '/', { locale: 'en' })
    expect(byQuery.members.map((r) => r.name)).toEqual(['Ada', 'Grace'])
  })

  it('names one type, and a directory that is there', () => {
    hub()
    const site = press()
    expect(() => resolveRecordMounts(site, { 'records/a/b/c': '../x' })).toThrow(/names no type/)
    expect(() => resolveRecordMounts(site, { 'records/member': '../nowhere' })).toThrow(/not a directory/)
    expect(() => resolveRecordMounts(site, { 'records/uniweb/link': '../../hub/site/records/member' })).toThrow(/link or file records/)
  })

  it('the site\'s own folder at a mounted path holds nothing it reads, and says so', async () => {
    hub()
    const site = press()
    w('press/site/records/member/own.md', '---\nname: Own\n---\n')
    const pool = await readEntityPool(site)
    expect(pool.entities.filter((e) => e.schema === '@/member').map((e) => e.slug)).toEqual(['ada', 'grace'])
    expect(pool.errors.join('\n')).toMatch(/records\/member\/ is mounted from .* and holds 1 file\(s\) of its own/)
  })
})

describe('⭐ a push places the owner\'s entities by reference', () => {
  it('sends no copy of a mounted record, and places each by the uuid the owner\'s push was given', async () => {
    hub()
    const { pkg, docs, folder } = await pushed(press())
    expect(pkg.refusals).toEqual([])
    expect(docs.filter((d) => d.$schema === '@acme/member')).toEqual([])
    const leaves = folder.contents.filter((n) => n.kind === 'ref')
    expect(leaves).toEqual(
      expect.arrayContaining([
        { kind: 'ref', name: 'ada', entry: { schema: '@acme/member', entity: ADA } },
        { kind: 'ref', name: 'grace', entry: { schema: '@acme/member', entity: GRACE } },
      ])
    )
  })

  it('a record of the site\'s own naming a mounted one sends its uuid', async () => {
    hub()
    const { docs } = await pushed(press())
    const launch = docs.find((d) => d.$schema === '@acme/article')
    expect(JSON.stringify(launch)).toContain(ADA)
  })

  it('a mounted record its owner has not pushed is refused, saying to push the owner first', async () => {
    hub({ pushed: false })
    const { pkg } = await pushed(press())
    expect(pkg.refusals.join('\n')).toMatch(/records\/member\/ada\.md: mounted from .* has never been pushed\. Push that site first/)
  })

  it('CONTROL — the owner\'s files are not touched by the push', async () => {
    hub()
    const before = readFileSync(join(ROOT, 'hub/site/records/member/ada.md'), 'utf8')
    await pushed(press())
    expect(readFileSync(join(ROOT, 'hub/site/records/member/ada.md'), 'utf8')).toBe(before)
  })
})

describe('⭐ a pull leaves the owner\'s files to the owner', () => {
  it('writes nothing for a mounted record, and knows where it is', () => {
    hub()
    const site = press()
    const before = readFileSync(join(ROOT, 'hub/site/records/member/ada.md'), 'utf8')
    const report = recordsToProject({
      folderDoc: { contents: [{ kind: 'ref', name: 'ada', entry: { schema: '@acme/member', entity: ADA } }] },
      recordDocs: [{ $uuid: ADA, $schema: '@acme/member', brief: { name: { en: 'Ada (edited in the app)' } } }],
      siteRoot: site,
      opts: { backend: BACKEND, resolveDeclaration: () => MEMBER_DECLARATION, scope: '@acme' },
    })
    expect(report.skipped).toEqual([])
    expect(report.leftToOwner).toEqual([join(ROOT, 'hub/site/records/member/ada.md')])
    expect(readFileSync(join(ROOT, 'hub/site/records/member/ada.md'), 'utf8')).toBe(before)
    expect(existsSync(join(site, 'records/member/ada.md'))).toBe(false)
  })
})
