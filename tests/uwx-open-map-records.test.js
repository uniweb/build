/**
 * ⭐ AN OPEN MAP IN A RECORD — the author's map in the file, rows on the wire, the map again after a pull.
 *
 * `values:` declares a map whose keys are the author's (`measurements: { diameter: { value, unit } }`).
 * It lowers to rows keyed by `name` (`data-schema.js::lowerField`), so a push sends each key as its
 * row's `name`, and a pull writes the rows back as the map. ⛔ Until 2026-09-26 a push refused the map
 * as "a list of records", so no record holding one could be pushed at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { emitSyncPackages, readZip, recordsToProject, renderEntityDocument } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'
import { toDataSchemaDeclaration, isOpenMapSection, openMapFromRows } from '../src/uwx/data-schema.js'
import { computeHash } from '../src/i18n/hash.js'
import { extractRecordContent, buildLocalizedRecords } from '../src/i18n/records.js'

let ROOT, SITE
const BACKEND = 'http://backend.test'
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-open-map-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}

const SPECIMEN = validateAndNormalizeSchema(
  {
    name: 'specimen',
    sections: {
      brief: { brief: true, fields: { name: { type: 'string' } } },
      record: {
        fields: {
          measurements: {
            type: 'object',
            values: {
              type: 'object',
              fields: {
                value: { type: 'number' },
                unit: { type: 'string', translatable: false },
                note: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  '@/specimen'
)
const DECLARATION = toDataSchemaDeclaration(SPECIMEN, { name: '@acme/specimen' })
const MEASUREMENTS = DECLARATION.sections.record.fields.measurements

const FILE = `brief:
  name: Ammonite
record:
  measurements:
    diameter:
      value: 14.5
      unit: cm
      note: Across the widest whorl
    weight:
      value: 820.5
      unit: g
`

function makeSite(translations = {}) {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', "specimens:\n  schema: '@/specimen'\n")
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/records/specimen/ammonite.yml', FILE)
  if (Object.keys(translations).length) w('site/locales/records/es.json', translations)
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/dist/meta/schema.json', {
    _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
    dataSchemas: { '@/specimen': SPECIMEN },
  })
}

async function push() {
  const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
  expect(pkg.refusals).toEqual([])
  return [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
    .filter((d) => d.$schema === '@acme/specimen')
}

function pull(siteRoot, entities) {
  const recordDocs = entities.map((e) => ({ ...e, $uuid: `U-${e.$id.split('/').pop()}` }))
  return recordsToProject({
    folderDoc: {
      contents: recordDocs.map((d) => ({ kind: 'ref', name: d.$uuid.slice(2), entry: { schema: '@acme/specimen', entity: d.$uuid } })),
    },
    recordDocs,
    siteRoot,
    opts: { backend: BACKEND, resolveDeclaration: () => DECLARATION, scope: '@acme' },
  })
}

describe('the rule — an open map’s lowered section', () => {
  it('is recognized off the declaration alone', () => {
    expect(isOpenMapSection(MEASUREMENTS)).toBe(true)
  })

  it('CONTROL — a list of records keyed by nothing is not one', () => {
    const list = validateAndNormalizeSchema(
      { name: 'x', fields: { rows: { type: 'array', items: { type: 'object', fields: { name: { type: 'string' } } } } } },
      '@/x'
    )
    const rows = toDataSchemaDeclaration(list, { name: '@acme/x' }).sections.brief.fields.rows
    expect(rows.multiple).toBe(true)
    expect(isOpenMapSection(rows)).toBe(false)
  })

  it('rows that cannot be a map stay a list', () => {
    expect(openMapFromRows([{ name: 'a' }, { name: 'a' }])).toBe(null)
    expect(openMapFromRows([{ value: 1 }])).toBe(null)
  })
})

describe('a record holding an open map', () => {
  it('⭐ is pushed — each key as its row’s `name`, in the map’s order', async () => {
    makeSite()
    const [ammonite] = await push()
    expect(ammonite.record.measurements).toEqual([
      { name: 'diameter', value: 14.5, unit: 'cm', note: { en: 'Across the widest whorl' } },
      { name: 'weight', value: 820.5, unit: 'g' },
    ])
  })

  it('⭐ a pull writes the rows back as the map', async () => {
    makeSite()
    const [ammonite] = await push()
    const text = renderEntityDocument({ document: ammonite, declaration: DECLARATION, format: 'yml', sourceLocale: 'en' })
    expect(yaml.load(text).record.measurements).toEqual({
      diameter: { value: 14.5, unit: 'cm', note: 'Across the widest whorl' },
      weight: { value: 820.5, unit: 'g' },
    })
  })

  it('a pull into the author’s copy leaves the file as it was', async () => {
    makeSite()
    const report = pull(SITE, await push())
    expect(report.skipped).toEqual([])
    expect(readFileSync(join(SITE, 'records/specimen/ammonite.yml'), 'utf8')).toContain(
      'measurements:\n    diameter:\n      value: 14.5'
    )
  })

  it('a value inside the map is offered for translation, translated by the build, and pushed', async () => {
    const note = 'Across the widest whorl'
    const es = 'A lo ancho de la vuelta mayor'
    makeSite({ [computeHash(note)]: es })
    // The static build's side: the schema from the foundation's source, the record as compiled.
    w('fdn/schemas/specimen.yml', SPECIMEN_YML)
    w('site/public/data/specimens.json', [
      { slug: 'ammonite', name: 'Ammonite', record: yaml.load(FILE).record },
    ])
    const sources = Object.values((await extractRecordContent(SITE)).units).map((u) => u.source)
    expect(sources).toContain(note)
    const outputs = await buildLocalizedRecords(SITE, { locales: ['es'] })
    const [built] = JSON.parse(readFileSync(outputs.es.specimens, 'utf8'))
    expect(built.record.measurements.diameter.note).toBe(es)

    const [ammonite] = await push()
    expect(ammonite.record.measurements[0].note).toEqual({ en: note, es })
  })
})

const SPECIMEN_YML = `name: specimen
sections:
  brief:
    brief: true
    fields:
      name: { type: string }
  record:
    fields:
      measurements:
        type: object
        values:
          type: object
          fields:
            value: { type: number }
            unit: { type: string, translatable: false }
            note: { type: string }
`
