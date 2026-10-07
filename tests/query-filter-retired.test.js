// ⛔ `filter:` IS RETIRED — 2026-10-06 [Diego]: "it should not be supported. We don't need to keep
// legacy concepts around." It was the string predicate `where:` replaced.
//
// On a query it was worse than unsupported: carried into `config.queries` and applied nowhere, so a
// query that said `filter: "role == lead"` compiled every record with nothing said (measured
// 2026-10-06). A fetch's `filter:` is refused in `data-fetcher.test.js`.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveQueriesConfig, toConfigQueries } from '../src/site/queries-config.js'
import { processQueries } from '../src/site/query-processor.js'
import { siteProjectToDocument } from '../src/uwx/index.js'

let ROOT, SITE

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'query-filter-retired-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const write = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

function makeSite({ queriesYml = '', siteQueries = '' } = {}) {
  write('site/site.yml', `name: T\nfoundation: "@acme/base"\n${siteQueries}`)
  write('site/package.json', { name: 'site', dependencies: { '@acme/base': 'file:../fdn' } })
  if (queriesYml) write('site/queries.yml', queriesYml)
  write('site/records/person/ada.yml', 'name: Ada\nrole: lead\n')
  write('site/records/person/bo.yml', 'name: Bo\nrole: member\n')
  write('fdn/dist/meta/schema.json', { dataSchemas: {} })
}

describe('`filter:` on a query is retired', () => {
  it('⛔ a query in queries.yml that says `filter:` stops the build, naming `where:`', async () => {
    makeSite({ queriesYml: 'people:\n  schema: "@/person"\n  filter: "role == lead"\n' })
    await expect(resolveQueriesConfig(SITE)).rejects.toThrow(
      /query "people": `filter:` is retired\. Write the predicate as `where:`/
    )
  })

  it('⛔ …and so does one under site.yml `queries:`', async () => {
    makeSite({ siteQueries: 'queries:\n  people:\n    schema: "@/person"\n    filter: "role == lead"\n' })
    await expect(resolveQueriesConfig(SITE)).rejects.toThrow(/`filter:` is retired/)
  })

  it('⛔ a push stops on it too — the sync lane resolves queries by the same rule', async () => {
    makeSite({ queriesYml: 'people:\n  schema: "@/person"\n  filter: "role == lead"\n' })
    await expect(siteProjectToDocument(SITE)).rejects.toThrow(/`filter:` is retired/)
  })

  it('⛔ a raw query config handed to processQueries is refused as well', async () => {
    makeSite()
    await expect(
      processQueries(SITE, { people: { schema: '@/person', filter: 'role == lead' } }, null, '/', { dataSchemas: {} })
    ).rejects.toThrow(/queries\.people: `filter:` is retired/)
  })

  it('CONTROL — the same predicate written as `where:` resolves and selects', async () => {
    makeSite({ queriesYml: 'people:\n  schema: "@/person"\n  where: { role: lead }\n' })
    const { declarations } = await resolveQueriesConfig(SITE)
    const out = await processQueries(SITE, toConfigQueries(declarations), null, '/', { dataSchemas: {} })
    expect(out.people.map((r) => r.$name)).toEqual(['ada'])
  })
})
