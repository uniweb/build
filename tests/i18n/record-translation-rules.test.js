// A record translates by the rules a page does, and as its data schema says — so the static build
// renders what a push carries.
//
// ⛔ Two ways it did not, until 2026-09-26:
//  - a record's rich text was translated text node by text node, while its units are keyed by the
//    whole paragraph — so a paragraph holding a link or an emphasis never matched its translation;
//  - a section-model data schema (every standard one, and a foundation's own) was never read, so a
//    field it marks `translatable: false` — `@std/article`'s `tags` — was extracted and translated by
//    the build, while a push, which reads the schema, carried none.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { extractRecordContent, buildLocalizedRecords } from '../../src/i18n/records.js'
import { computeHash } from '../../src/i18n/hash.js'

let ROOT
beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'record-rules-')) })
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const texts = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'text') out.push(node.text)
    for (const [k, v] of Object.entries(node)) if (k !== 'attrs' && v && typeof v === 'object') texts(v, out)
  }
  return out.join('')
}

describe('a record’s rich text', () => {
  it('⭐ a paragraph holding a link and an emphasis translates as a whole, keeping both', async () => {
    const content = markdownToProseMirror('Read [this](/x) **now**.')
    w('site.yml', 'name: T\n')
    w('queries.yml', "notes:\n  schema: '@/note'\n")
    w('public/data/notes.json', [{ slug: 'a', title: 'A', content }])
    w('locales/records/es.json', { [computeHash('Read this now.')]: 'Lee [esto](/x) **ahora**.' })

    const manifest = await extractRecordContent(ROOT)
    expect(Object.values(manifest.units).map((u) => u.source)).toContain('Read this now.')

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const paragraph = JSON.parse(readFileSync(outputs.es.notes, 'utf8'))[0].content.content[0]
    expect(texts(paragraph)).toBe('Lee esto ahora.')
    const marks = paragraph.content.flatMap((n) => (n.marks || []).map((m) => m.type))
    expect(marks).toEqual(expect.arrayContaining(['link', 'bold']))
  })
})

describe('a record’s data schema decides what is prose', () => {
  const site = () => {
    w('site.yml', 'name: T\n')
    w('queries.yml', "articles:\n  schema: '@std/article'\n")
    w('public/data/articles.json', [{ slug: 'a', title: 'Hello', tags: ['research', 'climate'] }])
    w('locales/records/es.json', {
      [computeHash('Hello')]: 'Hola',
      [computeHash('research')]: 'investigacion',
      [computeHash('climate')]: 'clima',
    })
  }

  it('⭐ a `translatable: false` field is neither extracted nor translated', async () => {
    site()
    const sources = Object.values((await extractRecordContent(ROOT)).units).map((u) => u.source)
    expect(sources).toContain('Hello')
    expect(sources).not.toContain('research')

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const record = JSON.parse(readFileSync(outputs.es.articles, 'utf8'))[0]
    expect(record.title).toBe('Hola')
    expect(record.tags).toEqual(['research', 'climate'])
  })

  // A query named for a data key the foundation types — `team:`, no `schema:`, and a section type
  // declaring `data: { team: '@/member' }` — holds records of that type, and a push sends them as
  // its entities (`uwx/data-key-types.js`). ⛔ Until 2026-09-26 no schema was read for them here.
  it('⭐ so does the type of the data key a query is named for', async () => {
    w('site.yml', 'name: T\nfoundation: fnd\n')
    w('package.json', { name: 'site', dependencies: { fnd: 'file:./fdn' } })
    w('queries.yml', 'team: {}\n')
    w('public/data/team.json', [{ slug: 'wei', name: 'Wei Zhang', role: 'Director' }])
    w('locales/records/es.json', { [computeHash('Wei Zhang')]: 'Wei Zhang (es)', [computeHash('Director')]: 'Directora' })
    w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
    w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
    w('fdn/schemas/member.yml', 'name: member\nfields:\n  name: { type: string, translatable: false }\n  role: { type: string }\n')
    w('fdn/dist/meta/schema.json', { _self: { name: '@acme/fnd' }, Team: { data: { team: '@/member' } } })

    const sources = Object.values((await extractRecordContent(ROOT)).units).map((u) => u.source)
    expect(sources).toEqual(['Director'])

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const record = JSON.parse(readFileSync(outputs.es.team, 'utf8'))[0]
    expect(record).toMatchObject({ name: 'Wei Zhang', role: 'Directora' })
  })
})
