/**
 * ⭐ A RECORD'S MARKDOWN BODY KEEPS ITS TRANSLATIONS THROUGH A PULL.
 *
 * A `.md` record's body fills its schema's content body field — here a markdown `text` field — and a
 * push sends each language of it. ⛔ Until 2026-09-26 a pull wrote the source language into the file's
 * body and dropped the rest: the body was assumed to be a ProseMirror field, whose translations are
 * captured elsewhere, so a markdown one's were captured nowhere. A clone rendered it in the source
 * language (measured on a fixture of reviews and author bios).
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
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-md-body-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}

const REVIEW = validateAndNormalizeSchema(
  {
    name: 'review',
    sections: {
      brief: { brief: true, fields: { headline: { type: 'string' } } },
      body: { fields: { text: { type: 'markdown' } } },
    },
  },
  '@/review'
)
const DECLARATION = toDataSchemaDeclaration(REVIEW, { name: '@acme/review' })

const BODY = 'It plays best read aloud, *alone*, late at night.'
const TRANSLATIONS = {
  [computeHash('A play for the mind')]: 'Una obra para la mente',
  [computeHash(BODY)]: 'Se disfruta más leída en voz alta, *a solas*, de noche.',
}

function makeSite() {
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', "reviews:\n  schema: '@/review'\n")
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/records/review/manfred.md', `---\nbrief:\n  headline: A play for the mind\n---\n\n${BODY}\n`)
  w('site/locales/records/es.json', TRANSLATIONS)
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/dist/meta/schema.json', {
    _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' },
    dataSchemas: { '@/review': REVIEW },
  })
}

async function push() {
  const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
  expect(pkg.refusals).toEqual([])
  return [...readZip(pkg.records.buffer)]
    .filter(([name]) => name.startsWith('entities/'))
    .map(([, buf]) => JSON.parse(buf.toString('utf8')))
    .filter((d) => d.$schema === '@acme/review')
}

// What the backend hands back: each entity with the uuid it minted, and the folder naming them.
function pull(siteRoot, entities) {
  const recordDocs = entities.map((e) => ({ ...e, $uuid: `U-${e.$id.split('/').pop()}` }))
  return recordsToProject({
    folderDoc: {
      contents: recordDocs.map((d) => ({ kind: 'ref', name: d.$uuid.slice(2), entry: { schema: '@acme/review', entity: d.$uuid } })),
    },
    recordDocs,
    siteRoot,
    opts: { backend: BACKEND, resolveDeclaration: () => DECLARATION, scope: '@acme' },
  })
}

describe('a record whose body is a markdown field', () => {
  it('the push sends its body in each language', async () => {
    makeSite()
    const [review] = await push()
    expect(review.body.text.es).toBe(TRANSLATIONS[computeHash(BODY)])
  })

  it('⭐ a clone keeps the body’s translation, beside the brief’s', async () => {
    makeSite()
    const entities = await push()
    const clone = join(ROOT, 'clone')
    mkdirSync(clone)
    writeFileSync(join(clone, 'site.yml'), 'name: T\n')
    expect(pull(clone, entities).skipped).toEqual([])
    expect(readFileSync(join(clone, 'records/review/manfred.md'), 'utf8')).toContain(BODY)
    expect(JSON.parse(readFileSync(join(clone, 'locales/records/es.json'), 'utf8'))).toEqual(TRANSLATIONS)
  })

  it('the author’s copy: the translations file is left as it was', async () => {
    makeSite()
    const before = readFileSync(join(SITE, 'locales/records/es.json'), 'utf8')
    const report = pull(SITE, await push())
    expect(report.skipped).toEqual([])
    expect(readFileSync(join(SITE, 'locales/records/es.json'), 'utf8')).toBe(before)
  })
})
