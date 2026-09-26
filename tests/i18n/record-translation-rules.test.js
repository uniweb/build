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

// A site on a local foundation `fdn` defining these schemas, its records compiled as given.
function onFoundation(schemas) {
  w('site.yml', 'name: T\nfoundation: fnd\n')
  w('package.json', { name: 'site', dependencies: { fnd: 'file:./fdn' } })
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  for (const [name, yml] of Object.entries(schemas)) w(`fdn/schemas/${name}.yml`, yml)
}

describe('a record is translated by the model a push sends it as', () => {
  const BOOK = `name: book
sections:
  brief:
    brief: true
    fields:
      title: { type: string }
      format: { type: string, enum: [novel, novella] }
  contributors:
    many: true
    fields:
      role: { type: string, enum: [author, editor] }
      note: { type: string }
`
  const AUTHOR = `name: author
sections:
  brief:
    brief: true
    fields:
      name: { type: string }
  milestones:
    many: true
    fields:
      title: { type: string }
      book: { ref: '@/book' }
`
  const site = () => {
    onFoundation({ book: BOOK, author: AUTHOR })
    w('queries.yml', "books:\n  schema: '@/book'\nauthors:\n  schema: '@/author'\n")
    w('public/data/books.json', [
      { title: 'The Vampyre', format: 'novella', contributors: [{ role: 'author', note: 'Wrote it in a week' }], $name: 'the-vampyre' },
    ])
    w('public/data/authors.json', [
      { name: 'Polidori', milestones: [{ title: 'Printed in a magazine', book: { brief: { title: 'The Vampyre', format: 'novella' } } }], $name: 'polidori' },
    ])
    w('locales/records/es.json', {
      [computeHash('The Vampyre')]: 'El Vampiro',
      [computeHash('novella')]: 'novela corta',
      [computeHash('author')]: 'autor',
      [computeHash('Wrote it in a week')]: 'Lo escribió en una semana',
      [computeHash('Printed in a magazine')]: 'Impreso en una revista',
    })
  }

  // ⛔ Until 2026-09-26 a `multi` section's fields were not read from the schema, and a reference's
  // brief was walked as the referencing record's own text.
  it('⭐ a `multi` section’s enum is not prose; a reference’s brief makes no units of its own', async () => {
    site()
    const units = Object.values((await extractRecordContent(ROOT)).units)
    const sources = units.map((u) => u.source).sort()
    expect(sources).toEqual(['Polidori', 'Printed in a magazine', 'The Vampyre', 'Wrote it in a week'])
    expect(units.find((u) => u.source === 'The Vampyre').contexts).toEqual([{ record: 'book/the-vampyre' }])
  })

  it('⭐ a reference’s brief translates as the record it names does — its enum left as it is', async () => {
    site()
    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const book = JSON.parse(readFileSync(outputs.es.books, 'utf8'))[0]
    expect(book).toMatchObject({ title: 'El Vampiro', format: 'novella', contributors: [{ role: 'author', note: 'Lo escribió en una semana' }] })
    const author = JSON.parse(readFileSync(outputs.es.authors, 'utf8'))[0]
    expect(author.milestones[0]).toEqual({ title: 'Impreso en una revista', book: { brief: { title: 'El Vampiro', format: 'novella' } } })
  })
})

describe('an excerpt the build derives is derived in every language', () => {
  const POST = `name: post
sections:
  brief:
    brief: true
    fields:
      title: { type: string }
  content:
    fields:
      body: { type: markdown }
`
  const translations = {
    [computeHash('Flood')]: 'Inundación',
    [computeHash('The river rose in *the* night.')]: 'El río creció en *la* noche.',
    // A translation of the derived excerpt itself — which no push carries, so it must not apply.
    [computeHash('The river rose in the night.')]: 'NO',
  }

  it('⭐ a lean list’s and a whole record’s, from the translated body — and never a unit', async () => {
    onFoundation({ post: POST })
    w('queries.yml', "posts:\n  schema: '@/post'\n  deferred: [content]\n")
    w('public/data/posts.json', [{ title: 'Flood', excerpt: 'The river rose in the night.', $name: 'flood' }])
    w('public/data/posts/flood.json', { title: 'Flood', content: { body: 'The river rose in *the* night.' }, excerpt: 'The river rose in the night.', $name: 'flood' })
    w('locales/records/es.json', translations)

    const sources = Object.values((await extractRecordContent(ROOT)).units).map((u) => u.source).sort()
    expect(sources).toEqual(['Flood', 'The river rose in *the* night.'])

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    expect(JSON.parse(readFileSync(outputs.es.posts, 'utf8'))[0]).toMatchObject({ title: 'Inundación', excerpt: 'El río creció en la noche.' })
    const whole = JSON.parse(readFileSync(join(outputs.es.posts, '..', 'posts', 'flood.json'), 'utf8'))
    expect(whole).toMatchObject({ content: { body: 'El río creció en *la* noche.' }, excerpt: 'El río creció en la noche.' })
  })

  it('a record with no data schema: derived from its translated body; an authored one is translated (CONTROL)', async () => {
    w('site.yml', 'name: T\n')
    w('queries.yml', 'notes: {}\n')
    // A body's paragraphs are units, and its excerpt their text run together.
    const content = markdownToProseMirror('The river rose.\n\nEveryone was *safe*.')
    w('public/data/notes.json', [
      { title: 'Flood', excerpt: 'The river rose. Everyone was safe.', content, $name: 'flood' },
      { title: 'Flood', excerpt: 'Written by hand.', content, $name: 'by-hand' },
    ])
    w('locales/records/es.json', {
      [computeHash('Flood')]: 'Inundación',
      [computeHash('The river rose.')]: 'El río creció.',
      [computeHash('Everyone was safe.')]: 'Todos estaban *a salvo*.',
      [computeHash('The river rose. Everyone was safe.')]: 'NO',
      [computeHash('Written by hand.')]: 'Escrito a mano.',
    })

    const sources = Object.values((await extractRecordContent(ROOT)).units).map((u) => u.source).sort()
    expect(sources).toEqual(['Everyone was safe.', 'Flood', 'The river rose.', 'Written by hand.'])

    const outputs = await buildLocalizedRecords(ROOT, { locales: ['es'] })
    const [derived, authored] = JSON.parse(readFileSync(outputs.es.notes, 'utf8'))
    expect(derived.excerpt).toBe('El río creció. Todos estaban a salvo.')
    expect(authored.excerpt).toBe('Escrito a mano.')
  })
})
