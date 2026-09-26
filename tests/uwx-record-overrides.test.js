/**
 * ⭐ A RECORD TRANSLATION THAT READS DIFFERENTLY IN SOME RECORDS SURVIVES A PUSH AND A PULL.
 *
 * A record translation entry may be `{ default, overrides }`, an override keyed by the record's
 * identity — `<pool>/<handle>`, the key the records manifest lists as a unit's context — and the
 * static build renders each record by it. ⛔ Until 2026-09-26 a push sent a plain field's entry of
 * that form as its source alone, its default dropped too, and a pull kept whichever record it read
 * last — so a clone lost the default and every override.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, recordsToProject } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { toDataSchemaDeclaration } from '../src/uwx/data-schema.js'
import { computeHash } from '../src/i18n/hash.js'

let ROOT, SITE
const BACKEND = 'http://backend.test'
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-record-overrides-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}

const NOTE = validateAndNormalizeSchema(
  { name: 'note', sections: { brief: { brief: true, fields: { title: { type: 'string' } } }, body: { fields: { text: { type: 'richtext' } } } } },
  '@/note'
)
const DECLARATION = toDataSchemaDeclaration(NOTE, { name: '@acme/note' })

// Two notes that say the same thing; the translation of the second reads differently.
const TRANSLATIONS = {
  [computeHash('Learn more')]: { default: 'Más información', overrides: { 'note/b': 'Descubre más' } },
  [computeHash('Read on.')]: { default: 'Sigue leyendo.', overrides: { 'note/b': 'Lee más.' } },
}
function makeSite() {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', "notes:\n  schema: '@/note'\n")
  w('site/pages/home/page.yml', 'title: Home\n')
  for (const name of ['a', 'b']) w(`site/records/note/${name}.md`, '---\nbrief:\n  title: Learn more\n---\n\nRead on.\n')
  w('site/locales/records/es.json', TRANSLATIONS)
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/dist/meta/schema.json', { _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' }, dataSchemas: { '@/note': NOTE } })
}

const texts = (doc) => JSON.stringify(doc).match(/"text":"([^"]*)"/g).map((t) => t.slice(8, -1)).join(' ')

async function push() {
  const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
  expect(pkg.refusals).toEqual([])
  return [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
    .filter((d) => d.$schema === '@acme/note')
}

// What the backend hands back: each entity with the uuid it minted, and the folder naming them.
function pull(siteRoot, entities) {
  const recordDocs = entities.map((e) => ({ ...e, $uuid: `U-${e.$id.split('/').pop()}` }))
  return recordsToProject({
    folderDoc: { contents: recordDocs.map((d) => ({ kind: 'ref', name: d.$uuid.slice(2), entry: { schema: '@acme/note', entity: d.$uuid } })) },
    recordDocs,
    siteRoot,
    opts: { backend: BACKEND, resolveDeclaration: () => DECLARATION, scope: '@acme' },
  })
}

describe('a record translation that reads differently in some records', () => {
  it('⭐ a push sends each record as it renders — a plain field and a rich one', async () => {
    makeSite()
    const byName = Object.fromEntries((await push()).map((e) => [e.$id.split('/').pop(), e]))
    expect(byName.a.brief.title).toEqual({ en: 'Learn more', es: 'Más información' })
    expect(byName.b.brief.title).toEqual({ en: 'Learn more', es: 'Descubre más' })
    expect(texts(byName.a.body.text.es)).toBe('Sigue leyendo.')
    expect(texts(byName.b.body.text.es)).toBe('Lee más.')
  })

  it('⭐ a clone gets `{ default, overrides }` back, keyed by the record', async () => {
    makeSite()
    const entities = await push()
    const clone = join(ROOT, 'clone')
    mkdirSync(clone)
    writeFileSync(join(clone, 'site.yml'), 'name: T\n')
    expect(pull(clone, entities).skipped).toEqual([])
    expect(JSON.parse(readFileSync(join(clone, 'locales/records/es.json'), 'utf8'))).toEqual(TRANSLATIONS)
  })

  it('the author’s copy: the file is left as it was', async () => {
    makeSite()
    const before = readFileSync(join(SITE, 'locales/records/es.json'), 'utf8')
    const report = pull(SITE, await push())
    expect(report.skipped).toEqual([])
    expect(report.locales?.es ?? 'unchanged').toBe('unchanged')
    expect(readFileSync(join(SITE, 'locales/records/es.json'), 'utf8')).toBe(before)
  })
})
