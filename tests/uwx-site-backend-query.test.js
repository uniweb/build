// A query over a type the site's own backend holds has no records in the site's files, by design:
// its members write them there. So a push says nothing about it when `blueprint.yml` opens it to
// visitors, and says what a visitor gets when it names it only for members.
//
// ⛔ Until 2026-11-24 every build and publish of such a site warned `query "events":
// records/event/ holds no records of @/event — nothing to push for it` (a kit trial, a club's
// events, all kept in its backend).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRecordEntities } from '../src/uwx/records.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let ROOT, SITE
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-site-backend-query-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const EVENT = validateAndNormalizeSchema({ name: 'event', fields: { title: { type: 'string' } } }, '@/event')

function makeSite(blueprint) {
  w('site/site.yml', 'name: T\nfoundation: fnd\nservices:\n  backend: true\n')
  w('site/queries.yml', "events:\n  schema: '@/event'\n")
  if (blueprint != null) w('site/blueprint.yml', blueprint)
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default {\n  name: '@acme/fnd',\n}\n")
  w('fdn/dist/meta/schema.json', { _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' }, dataSchemas: { '@/event': EVENT } })
}

const about = (warnings) => warnings.filter((m) => m.includes('query "events"'))

it('a type the blueprint opens to visitors: nothing said', async () => {
  makeSite("publicQueries:\n  '@/event': { whole: true }\n")
  const { warnings, refusals } = await buildRecordEntities(SITE)
  expect(refusals).toEqual([])
  expect(about(warnings)).toEqual([])
})

it('a type named only for members: says what a visitor gets, not "nothing to push"', async () => {
  makeSite("access:\n  '@/event': { add: open }\n")
  const { warnings } = await buildRecordEntities(SITE)
  expect(about(warnings)).toHaveLength(1)
  expect(about(warnings)[0]).toMatch(/held by this site's backend.*publicQueries doesn't open it/)
  expect(about(warnings)[0]).not.toMatch(/nothing to push/)
})

it('with no blueprint naming it, the site holds its records, and none is still worth saying', async () => {
  makeSite(null)
  const { warnings } = await buildRecordEntities(SITE)
  expect(about(warnings)[0]).toMatch(/holds no records of @\/event — nothing to push/)
})
