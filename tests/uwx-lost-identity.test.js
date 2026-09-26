/**
 * ⛔ A RECORD THAT LOST ITS IDENTITY IS NOT UNCHANGED.
 *
 * A push writes each record's `$uuid` into its file. When the line is gone and the record is
 * otherwise as pushed, its hash still matches the banked one (`$uuid` is stripped from every
 * hash), so it was skipped as unchanged — while the folder named it by `$ref`, and the backend
 * refused a reference to a record the package does not carry (measured 2026-09-26). Sent, it
 * would be a second record. The push refuses it and says to pull, which writes it back.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let ROOT, SITE
const BACKEND = 'http://backend.test'
const U = '01a0d4fb-0000-7000-8000-0000000000a1'
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-lost-identity-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

function makeSite() {
  const NOTE = validateAndNormalizeSchema({ name: 'note', fields: { title: { type: 'string' } } }, '@/note')
  w('site/site.yml', 'name: T\nfoundation: fnd\n')
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/queries.yml', "notes:\n  schema: '@/note'\n")
  w('site/pages/home/page.yml', 'title: Home\n')
  w('site/records/note/a.yml', `$uuid: ${U}\ntitle: A note\n`)
  // As a push to this backend left it: the record's uuid mapped.
  w('site/sync.json', { version: 1, backends: { [BACKEND]: { site: { uuid: 'SITE' }, records: { [U]: U } } } })
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', "export default { name: '@acme/fnd' }\n")
  w('fdn/dist/meta/schema.json', { _self: { name: '@acme/fnd', version: '1.0.0', role: 'foundation' }, dataSchemas: { '@/note': NOTE } })
}

describe('a record whose `$uuid` is gone from its file', () => {
  it('⭐ is refused, pointing at a pull — not skipped, and not sent as a second record', async () => {
    makeSite()
    const banked = (await emitSyncPackages(SITE, { backend: BACKEND })).hashes
    w('site/records/note/a.yml', 'title: A note\n')

    const pkg = await emitSyncPackages(SITE, { backend: BACKEND, priorHashes: banked })
    expect(pkg.refusals).toEqual([
      'note/a: its `$uuid` is gone from its file, though it was pushed to this backend before — ' +
        'sent as it is, it would be a second record. Run `uniweb pull`, which writes it back, then push.',
    ])
  })

  it('CONTROL — with its `$uuid`, the unchanged record has nothing to send and nothing refused', async () => {
    makeSite()
    const banked = (await emitSyncPackages(SITE, { backend: BACKEND })).hashes
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND, priorHashes: banked })
    expect(pkg.refusals).toEqual([])
    expect(pkg.records).toBe(null)
  })
})
