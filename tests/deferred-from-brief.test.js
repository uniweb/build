// `deferred:` is derived from a collection's data schema, not written by hand.
//
// A schema's brief section already states what a record's summary is — the card,
// the row, the thing a list shows. Everything else is wanted only when one record
// is the focus, which is exactly what `deferred:` says. An author with a schema
// should not have to say it twice, in a second vocabulary, with nothing checking
// the two against each other.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveQueriesConfig } from '../src/site/queries-config.js'
import { collectSiteContent } from '../src/site/content-collector.js'
import { processQueries, writeQueryFiles } from '../src/site/query-processor.js'

let ROOT
let SITE

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const SCHEMA = {
  sections: {
    card: { kind: 'single', brief: true, fields: { title: { type: 'string' }, date: { type: 'date' } } },
    body: {
      kind: 'single',
      fields: { content: { type: 'json', format: 'prosemirror' }, footnotes: { type: 'string' } },
    },
  },
}

// The same schema as its foundation's source holds it — what the static build delivers
// records by (`resolveRecordSchemas`), where the derivation reads the built map above.
const SOURCE = [
  'name: article',
  'sections:',
  '  card: { brief: true, fields: { title: string, date: date } }',
  '  body: { fields: { content: richtext, footnotes: string } }',
  '',
].join('\n')

const setup = ({ siteCollections, schemas = { '@/article': SCHEMA }, foundation = true } = {}) => {
  w('site/site.yml', `name: T\nfoundation: "@acme/base"\nqueries:\n${siteCollections}`)
  w('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  w('site/records/article/hi.md', '---\ncard:\n  title: Hi\n  date: 2026-01-01\n---\n\nBody text.\n')
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  if (foundation) {
    w('fdn/dist/meta/schema.json', { dataSchemas: schemas })
    w('fdn/src/schemas/article.yml', SOURCE)
  }
}

const declared = async () =>
  (await resolveQueriesConfig(SITE)).declarations.articles

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'deferred-brief-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const WITH_SCHEMA = '  articles:\n    schema: "@/article"\n'

describe('deriving deferred from the brief', () => {
  it('defers every section but the brief, by the name a delivered record holds it under', async () => {
    setup({ siteCollections: WITH_SCHEMA })
    expect((await declared()).deferred).toEqual(['body'])
  })

  it('never overrides an author-declared deferred', async () => {
    setup({ siteCollections: WITH_SCHEMA + '    deferred: [footnotes]\n' })
    expect((await declared()).deferred).toEqual(['footnotes'])
  })

  it('stays silent when the schema states no brief', async () => {
    // A root list (`@std/nav`) is the ordinary case: no lean shape is stated, so
    // records stay whole. Deferring everything would empty the cascade.
    setup({
      siteCollections: WITH_SCHEMA,
      schemas: { '@/article': { sections: { items: { kind: 'multi', fields: { a: {} } } } } },
    })
    expect((await declared()).deferred).toBeUndefined()
  })

  it('stays silent when the schema is not in the foundation map', async () => {
    // `dist/meta/schema.json` carries the schemas COMPONENTS reference, so a
    // collection whose schema no component binds is simply not there — the same
    // soft-skip the sync lane already applies.
    setup({ siteCollections: WITH_SCHEMA, schemas: { '@/other': SCHEMA } })
    expect((await declared()).deferred).toBeUndefined()
  })

  it('stays silent when the foundation is unbuilt or not local', async () => {
    setup({ siteCollections: WITH_SCHEMA, foundation: false })
    expect((await declared()).deferred).toBeUndefined()
  })

  it('stays silent for a collection with no schema at all — the control', async () => {
    // Without this, a bug that deferred unconditionally would pass every
    // assertion above while emptying the cascade of untyped collections.
    setup({ siteCollections: '  articles:\n' })
    expect((await declared()).deferred).toBeUndefined()
  })
})

describe('what the derived split actually emits', () => {
  const build = async () => {
    const site = await collectSiteContent(SITE, {})
    const cols = await processQueries(SITE, site.config.queries, null, '/')
    await writeQueryFiles(SITE, cols, site.config.queries)
    return {
      cascade: JSON.parse(readFileSync(join(SITE, 'public/data/articles.json'), 'utf8')),
      recordPath: join(SITE, 'public/data/articles/hi.json'),
    }
  }

  it('strips the non-brief sections from the cascade and writes the full record', async () => {
    setup({ siteCollections: WITH_SCHEMA })
    const { cascade, recordPath } = await build()
    expect('body' in cascade[0]).toBe(false)
    expect('content' in cascade[0]).toBe(false)
    expect(existsSync(recordPath)).toBe(true)
    // The markdown body is delivered in the schema's content body field.
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).body.content.type).toBe('doc')
  })

  it('keeps the build-derived keys, with no reserved list to maintain', async () => {
    // The split is computed from the SCHEMA, never from a record — so `slug`,
    // `path`, `excerpt`, `image` and `$name` are not sections, and are never
    // stripped. Nothing has to enumerate them.
    setup({ siteCollections: WITH_SCHEMA })
    const { cascade } = await build()
    for (const key of ['slug', 'excerpt', 'image', 'path', '$name']) {
      expect(key in cascade[0]).toBe(true)
    }
    // The brief's fields at the top, as delivered.
    expect(cascade[0].title).toBe('Hi')
    expect('card' in cascade[0]).toBe(false)
  })
})
