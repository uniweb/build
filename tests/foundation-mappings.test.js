/**
 * A foundation's `src/mappings/` (`src/foundation/mappings.js`): the folder is the declaration, and
 * the build refuses only what cannot register — the rules themselves are the backend's to judge.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMappingMap, ownMappingFiles } from '../src/foundation/mappings.js'

let SRC
beforeEach(() => {
  SRC = mkdtempSync(join(tmpdir(), 'uw-mappings-'))
  mkdirSync(join(SRC, 'mappings'))
})
afterEach(() => rmSync(SRC, { recursive: true, force: true }))
const w = (file, body) => writeFileSync(join(SRC, 'mappings', file), body)

describe('src/mappings/', () => {
  it('one mapping per file, named by the file; `_` files and other extensions left out', async () => {
    w('vehicle-to-meta.yml', "model: '@/vehicle'\ndirection: out\nfields: [{ title: listing.title }]\n")
    w('lead.json', JSON.stringify({ model: '@std/person' }))
    w('_draft.yml', "model: '@/vehicle'\n")
    w('notes.md', 'x')
    expect(ownMappingFiles(SRC).map((f) => f.name)).toEqual(['lead', 'vehicle-to-meta'])
    const map = await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] })
    expect(Object.keys(map)).toEqual(['@/lead', '@/vehicle-to-meta'])
    expect(map['@/vehicle-to-meta']).toEqual({ model: '@/vehicle', direction: 'out', fields: [{ title: 'listing.title' }] })
  })

  it('no folder, no mappings', async () => {
    rmSync(join(SRC, 'mappings'), { recursive: true })
    expect(await buildMappingMap(SRC)).toEqual({})
  })

  it('keys it does not know are left to the backend', async () => {
    w('a.yml', "model: '@/vehicle'\nsomething_new: 1\n")
    expect(await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] })).toEqual({ '@/a': { model: '@/vehicle', something_new: 1 } })
  })

  it('refuses a missing model, an own type it does not define, and a keys_from naming no mapping of its own', async () => {
    w('a.yml', 'direction: out\n')
    w('b.yml', "model: '@/nope'\n")
    w('c.yml', "model: '@/vehicle'\nkeys_from: '@/missing'\n")
    w('d.yml', 'model: vehicle\n')
    const err = await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] }).catch((e) => e)
    expect(err.message).toMatch(/a\.yml: `model` is missing/)
    expect(err.message).toMatch(/b\.yml: `model` is `@\/nope`, which is not one of the foundation's types/)
    expect(err.message).toMatch(/c\.yml: `keys_from` is `@\/missing`, which is not one of the foundation's mappings/)
    expect(err.message).toMatch(/d\.yml: `model` names no type/)
  })

  it("checks a reverse `follow` line's `model` as it checks `model`; the rest of `follow` is the backend's", async () => {
    w('a.yml', "model: '@/vehicle'\nfollow:\n  - { quiz: { field: identity.quiz_ref } }\n  - { key: { model: '@/vehicle', field: identity.quiz, names: quiz } }\n  - { std: { model: '@std/person', field: identity.x } }\n")
    expect(Object.keys(await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] }))).toEqual(['@/a'])
    w('b.yml', "model: '@/vehicle'\nfollow:\n  - { key: { model: '@/nope', field: identity.quiz } }\n  - { k2: { model: nope, field: x } }\n")
    const err = await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] }).catch((e) => e)
    expect(err.message).toMatch(/b\.yml: `follow\[0\]\.key\.model` is `@\/nope`, which is not one of the foundation's types/)
    expect(err.message).toMatch(/b\.yml: `follow\[1\]\.k2\.model` names no type/)
  })

  it('a keys_from naming another of its mappings is taken', async () => {
    w('a.yml', "model: '@/vehicle'\n")
    w('b.yml', "model: '@/vehicle'\nkeys_from: '@/a'\n")
    expect(Object.keys(await buildMappingMap(SRC, { ownTypes: ['@/vehicle'] }))).toEqual(['@/a', '@/b'])
  })
})
