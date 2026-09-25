/**
 * ⭐ A REFERENCE NAMES ITS RECORD BY HANDLE IN A FILE, AND TRAVELS AS A UUID — OR, FOR A
 * RECORD THE SAME PUSH CREATES, AS `{ $ref: <its $id> }`.
 *
 * `speaker: ada` — the name of the speaker's record — is what an author writes and what a
 * pull writes back. A push sends the uuid THIS backend minted for that record (measured
 * 2026-09-24: `speaker: ada` is refused, "not a valid uuid"; a uuid it has not seen is
 * refused too, "neither in the package nor on the host"). A record it has not minted is
 * new, so it rides in the same package, and the reference names it there by `$id` — the
 * value form the backend resolves to the uuid it mints (2026-09-25). One push creates
 * both. ⛔ Until then such a referrer waited — sent without the reference, or held back —
 * and the CLI pushed again to complete it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { recordsToEntities, entityContentHash } from '../src/uwx/records.js'
import { renderEntityDocument } from '../src/uwx/backfill.js'
import { emitSyncPackages, readZip, recordsToProject } from '../src/uwx/index.js'

const SPEAKER = { name: '@acme/speaker', sections: { brief: { brief: true, fields: { name: { type: 'string' } } } } }
const talkDecl = ({ required = false, multiple = false } = {}) => ({
  name: '@acme/talk',
  sections: {
    brief: {
      brief: true,
      fields: {
        title: { type: 'string', localized: true },
        speaker: { type: 'entity_ref', model: '@acme/speaker', ...(required ? { required: true } : {}), ...(multiple ? { multiple: true } : {}) },
      },
    },
  },
})

// A resolver over a fixed table, the way `refResolver` answers.
const refs = (table) => ({
  resolve(model, value) {
    if (typeof value !== 'string') return { invalid: true }
    const answer = table[`${model} ${value}`]
    return answer ?? { missing: true }
  },
})

describe('recordsToEntities — what a reference sends', () => {
  it('sends the uuid the backend minted for the record the file names', () => {
    const { entities, refusals } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'opening', title: 'Opening', speaker: 'ada' }],
      declaration: talkDecl(),
      refs: refs({ '@acme/speaker ada': { uuid: 'U-ADA' } }),
    })
    expect(refusals).toEqual([])
    expect(entities[0].document.brief.speaker).toBe('U-ADA')
    expect(entities[0].namesNew).toBe(0)
  })

  it('names a record the backend has not minted by its $id — the record this push creates', () => {
    const { entities, refusals } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'opening', title: 'Opening', speaker: 'ada' }],
      declaration: talkDecl(),
      refs: refs({ '@acme/speaker ada': { ref: 'speaker/ada' } }),
    })
    expect(refusals).toEqual([])
    expect(entities[0].document.brief.speaker).toEqual({ $ref: 'speaker/ada' })
    expect(entities[0].namesNew).toBe(1)
  })

  it('a REQUIRED reference to a new record is sent, not missing — no refusal', () => {
    const { entities, refusals } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'opening', title: 'Opening', speaker: 'ada' }],
      declaration: talkDecl({ required: true }),
      refs: refs({ '@acme/speaker ada': { ref: 'speaker/ada' } }),
    })
    expect(refusals).toEqual([])
    expect(entities[0].document.brief.speaker).toEqual({ $ref: 'speaker/ada' })
  })

  it('CONTROL — a required reference that is simply absent is still refused', () => {
    const { refusals } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'opening', title: 'Opening' }],
      declaration: talkDecl({ required: true }),
      refs: refs({}),
    })
    expect(refusals[0]).toMatch(/requires "speaker"/)
  })

  it('refuses a name no record answers to, a name two answer to, and a value that is no name', () => {
    const run = (value, answer) =>
      recordsToEntities({
        label: 'talk',
        records: [{ slug: 'opening', speaker: value }],
        declaration: talkDecl(),
        refs: { resolve: () => answer },
      }).refusals
    expect(run('adaa', { missing: true })[0]).toMatch(/"speaker" names "adaa", and no record of @acme\/speaker is called that/)
    expect(run('ada', { ambiguous: true })[0]).toMatch(/more than one record of @acme\/speaker is called that/)
    expect(run(42, { invalid: true })[0]).toMatch(/"speaker" is a reference — write the name/)
  })

  it('a list of references sends each one — a uuid, or $ref for a new record', () => {
    const { entities } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'panel', speaker: ['ada', 'grace'] }],
      declaration: talkDecl({ multiple: true }),
      refs: refs({ '@acme/speaker ada': { uuid: 'U-ADA' }, '@acme/speaker grace': { ref: 'speaker/grace' } }),
    })
    expect(entities[0].document.brief.speaker).toEqual(['U-ADA', { $ref: 'speaker/grace' }])
    expect(entities[0].namesNew).toBe(1)
  })

  it('which new record a reference names is content — its hash moves with it', () => {
    const talk = (ref) =>
      recordsToEntities({
        label: 'talk',
        records: [{ slug: 'opening', title: 'Opening', speaker: 'ada' }],
        declaration: talkDecl(),
        refs: refs({ '@acme/speaker ada': ref }),
      }).entities[0].document
    const toAda = entityContentHash(talk({ ref: 'speaker/ada' }))
    expect(entityContentHash(talk({ ref: 'speaker/grace' }))).not.toBe(toAda)
    // CONTROL — the same reference hashes the same.
    expect(entityContentHash(talk({ ref: 'speaker/ada' }))).toBe(toAda)
  })

  it('without a resolver a reference is sent as written — a caller that only maps', () => {
    const { entities } = recordsToEntities({
      label: 'talk',
      records: [{ slug: 'opening', speaker: 'ada' }],
      declaration: talkDecl(),
    })
    expect(entities[0].document.brief.speaker).toBe('ada')
  })
})

// ── The package: one push carries a new record and every record naming it ─────────────

let ROOT, SITE
const ORIGIN = 'http://backend.test'
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
function site({ required = false, syncRecords = {} } = {}) {
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  // Its name carries its scope, which a site's `@/x` resolves into (`@acme/talk`).
  writeFileSync(join(fdn, 'package.json'), JSON.stringify({ name: '@acme/marketing', version: '1.0.0' }))
  w('site.yml', 'name: Acme\nfoundation: "@acme/marketing"\n')
  w('package.json', { name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } })
  w('pages/home/page.yml', 'title: Home\n')
  w('records/speaker/ada.yml', 'name: Ada\n')
  writeFileSync(
    join(fdn, 'dist', 'meta', 'schema.json'),
    JSON.stringify({
      _self: { name: '@acme/marketing', version: '1', role: 'foundation' },
      dataSchemas: {
        '@/speaker': { name: 'speaker', fields: { name: { type: 'string' } } },
        '@/talk': {
          name: 'talk',
          fields: { title: { type: 'string' }, speaker: { type: 'ref', ref: '@/speaker', ...(required ? { required: true } : {}) } },
        },
      },
    })
  )
  w('sync.json', { version: 1, backends: { [ORIGIN]: { records: syncRecords } } })
}
const entityIn = (pkg, id) => {
  const zip = readZip(pkg.records.buffer)
  for (const [name, buf] of zip) {
    if (!name.startsWith('entities/')) continue
    const doc = JSON.parse(buf.toString('utf8'))
    if (doc.$id === id) return doc
  }
  return null
}
const folderOf = (pkg) => JSON.parse(readZip(pkg.records.buffer).get('entities/folder.json').toString('utf8'))

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-refs-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

// Every `$ref` in a package, wherever it sits — a record's field or the folder's entries.
const refsIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => refsIn(n, out))
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') out.push(node.$ref)
    for (const v of Object.values(node)) refsIn(v, out)
  }
  return out
}
const packaged = (pkg) =>
  [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))

describe('emitSyncPackages — a reference to a record the same push creates', () => {
  it('sends the minted uuid once the backend has the record', async () => {
    site({ syncRecords: { 'OWN-ADA': 'MINT-ADA' } })
    w('records/speaker/ada.yml', '$uuid: OWN-ADA\nname: Ada\n')
    w('records/talk/opening.yml', 'title: Opening\nspeaker: ada\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(pkg.refusals).toEqual([])
    expect(entityIn(pkg, 'talk/opening').brief.speaker).toBe('MINT-ADA')
    expect(pkg.namesNew).toEqual([])
  })

  it('first push of both: ONE package — the speaker, and the talk naming it by $ref', async () => {
    site()
    w('records/talk/opening.yml', 'title: Opening\nspeaker: ada\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(entityIn(pkg, 'speaker/ada')).toBeTruthy()
    expect(entityIn(pkg, 'talk/opening').brief).toEqual({ title: { en: 'Opening' }, speaker: { $ref: 'speaker/ada' } })
    // The talk's hash, banked as sent, is not the next push's — the caller re-banks it.
    expect(pkg.namesNew).toEqual(['@acme/talk talk/opening'])
  })

  it('⭐ every $ref names an entity the same package carries', async () => {
    site({ required: true })
    w('records/speaker/grace.yml', 'name: Grace\n')
    w('records/talk/opening.yml', 'title: Opening\nspeaker: ada\n')
    w('records/talk/closing.yml', 'title: Closing\nspeaker: grace\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    const docs = packaged(pkg)
    const ids = new Set(docs.map((d) => d.$id).filter(Boolean))
    const named = refsIn(docs)
    // CONTROL — the folder's two entries per record and the two talks' speakers.
    expect(named.length).toBeGreaterThanOrEqual(6)
    expect(named.filter((r) => !ids.has(r))).toEqual([])
  })

  it('a REQUIRED reference to a new record goes in the same package, and the talk is placed', async () => {
    site({ required: true })
    w('records/talk/opening.yml', 'title: Opening\nspeaker: ada\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(pkg.refusals).toEqual([])
    expect(entityIn(pkg, 'talk/opening').brief.speaker).toEqual({ $ref: 'speaker/ada' })
    expect(JSON.stringify(folderOf(pkg))).toMatch(/talk\/opening/)
    expect(pkg.hashes).toHaveProperty(['@acme/talk talk/opening'])
  })

  it('a talk already on the backend that comes to name a new speaker is sent, $ref and all', async () => {
    site({ syncRecords: { 'OWN-TALK': 'MINT-TALK' } })
    w('records/talk/opening.yml', '$uuid: OWN-TALK\ntitle: Opening\nspeaker: ada\n')
    const pkg = await emitSyncPackages(SITE, {
      backend: ORIGIN,
      priorHashes: { '@acme/talk talk/opening': 'BANKED' },
    })
    const talk = entityIn(pkg, 'talk/opening')
    expect(talk.$uuid).toBe('MINT-TALK')
    expect(talk.brief.speaker).toEqual({ $ref: 'speaker/ada' })
    expect(entityIn(pkg, 'speaker/ada')).toBeTruthy()
    expect(pkg.hashes['@acme/talk talk/opening']).not.toBe('BANKED')
  })

  it('a name no record answers to is refused before anything is sent', async () => {
    site()
    w('records/talk/opening.yml', 'title: Opening\nspeaker: adaa\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(pkg.refusals[0]).toMatch(/talk\/opening: "speaker" names "adaa", and no record of @acme\/speaker is called that/)
  })

  it('a uuid the project does not hold is sent as it is — a record the backend has', async () => {
    site()
    w('records/talk/opening.yml', 'title: Opening\nspeaker: 01a0d4fb-b326-7241-933b-cf05db69731d\n')
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(entityIn(pkg, 'talk/opening').brief.speaker).toBe('01a0d4fb-b326-7241-933b-cf05db69731d')
  })
})

// ── Pull: a reference comes back as the name of its record ────────────────────────────

describe('a pulled reference is written as the name of the record it points at', () => {
  const doc = { $uuid: 'MINT-TALK', brief: { title: { en: 'Opening' }, speaker: 'MINT-ADA' } }

  it('renderEntityDocument writes the name refName answers, and a uuid it does not', () => {
    const named = renderEntityDocument({
      document: doc,
      declaration: talkDecl(),
      format: 'yaml',
      refName: (model, uuid) => (model === '@acme/speaker' && uuid === 'MINT-ADA' ? 'ada' : null),
    })
    expect(yaml.load(named).speaker).toBe('ada')
    const unknown = renderEntityDocument({ document: doc, declaration: talkDecl(), format: 'yaml', refName: () => null })
    expect(yaml.load(unknown).speaker).toBe('MINT-ADA')
  })

  it('recordsToProject names it from the folder the pull brought back', () => {
    site({ syncRecords: {} })
    const folderDoc = {
      contents: [
        { kind: 'ref', name: 'ada', entry: { schema: '@acme/speaker', entity: 'MINT-ADA' } },
        { kind: 'ref', name: 'opening', entry: { schema: '@acme/talk', entity: 'MINT-TALK' } },
      ],
    }
    const recordDocs = [
      { $uuid: 'MINT-ADA', $schema: '@acme/speaker', brief: { name: { en: 'Ada' } } },
      { $uuid: 'MINT-TALK', $schema: '@acme/talk', ...doc },
    ]
    const report = recordsToProject({
      folderDoc,
      recordDocs,
      siteRoot: SITE,
      opts: { resolveDeclaration: (n) => (n === '@acme/talk' ? talkDecl() : SPEAKER), scope: 'acme' },
    })
    expect(report.skipped).toEqual([])
    const talkFile = join(SITE, 'records/talk/opening.yml')
    expect(existsSync(talkFile)).toBe(true)
    expect(yaml.load(readFileSync(talkFile, 'utf8'))).toMatchObject({ title: 'Opening', speaker: 'ada' })
  })
})
