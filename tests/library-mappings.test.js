/**
 * ⭐ A library's mappings, carried by a foundation that names them in its main.js
 * (`foundation/library-mappings.js`): found as a library's types are, checked as a foundation's own
 * mappings are, kept in `_mappings` under their full names, and named — never registered — in the
 * foundation's `mappings` refs. Its library registers them (`buildSchemaOnlyPackage`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLibraryMappings } from '../src/foundation/library-mappings.js'
import { workspaceMappingFiles } from '../src/foundation/shared-types.js'
import { isSchemasPackage } from '../src/utils/classify-package.js'
import { buildMappingMap } from '../src/foundation/mappings.js'
import { buildRegistryPackage, buildSchemaOnlyPackage } from '../src/uwx/registry-package.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const foundation = (dir, name) => {
  w(`${dir}/package.json`, { name: dir, main: './_entry.generated.js' })
  w(`${dir}/main.js`, `export default { name: '${name}' }\n`)
  return join(ROOT, dir)
}
const library = (dir, scope, files) => {
  w(`${dir}/package.json`, { name: `@x/${dir}`, uniweb: { scope } })
  for (const [file, body] of Object.entries(files)) w(`${dir}/${file}`, body)
  return join(ROOT, dir)
}
const VEHICLE = 'name: vehicle\nfields:\n  title: { type: string }\n'
const TO_META = "label: Meta catalog\nmodel: '@/vehicle'\ndirection: out\nkeys_from: '@/inventory'\nfields:\n  - { title: listing.title }\n"
const INVENTORY = "model: '@/vehicle'\ndirection: in\n"

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'library-mappings-'))
  w('pnpm-workspace.yaml', "packages:\n  - '*'\n")
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a library of mappings', () => {
  it('is a schemas package with mappings/ alone, as with schemas/', () => {
    const lib = library('dealer', '@acme', { 'mappings/to-meta.yml': TO_META })
    expect(isSchemasPackage(lib)).toBe(true)
  })

  it('is found by its scope and name, as a library type is', async () => {
    library('dealer', '@acme', { 'schemas/vehicle.yml': VEHICLE, 'mappings/to-meta.yml': TO_META })
    const shop = foundation('shop', '@shop/storefront')
    expect(await workspaceMappingFiles('@acme/to-meta', shop)).toEqual([join(ROOT, 'dealer/mappings/to-meta.yml')])
    expect(await workspaceMappingFiles('@other/to-meta', shop)).toEqual([])
  })
})

describe("main.js `mappings:` — the library mappings a foundation carries", () => {
  it('⭐ each, read from its library, with every name in it in full', async () => {
    library('dealer', '@acme', { 'schemas/vehicle.yml': VEHICLE, 'mappings/to-meta.yml': TO_META, 'mappings/inventory.yml': INVENTORY })
    const shop = foundation('shop', '@shop/storefront')
    const { map, warnings } = await resolveLibraryMappings(['@acme/to-meta'], { srcDir: shop, ownScope: '@shop' })
    expect(warnings).toEqual([])
    expect(map).toEqual({
      '@acme/to-meta': {
        label: 'Meta catalog',
        model: '@acme/vehicle',
        direction: 'out',
        keys_from: '@acme/inventory',
        fields: [{ title: 'listing.title' }],
      },
    })
  })

  it('refuses what it cannot carry, naming each', async () => {
    library('dealer', '@acme', { 'schemas/vehicle.yml': VEHICLE, 'mappings/broken.yml': "model: '@/nope'\n" })
    library('copy', '@acme', { 'mappings/twice.yml': INVENTORY })
    library('copy2', '@acme', { 'mappings/twice.yml': INVENTORY })
    const shop = foundation('shop', '@shop/storefront')
    const err = await resolveLibraryMappings(['@/mine', '@shop/own', 'nope', '@acme/twice', '@acme/broken'], {
      srcDir: shop,
      ownScope: '@shop',
    }).catch((e) => e)
    expect(err.message).toMatch(/`@\/mine`: a mapping of the foundation's own is a file in src\/mappings\//)
    expect(err.message).toMatch(/`@shop\/own`, in the foundation's own scope/)
    expect(err.message).toMatch(/`nope`, which is not a mapping's full name/)
    expect(err.message).toMatch(/`@acme\/twice`, which 2 packages define/)
    expect(err.message).toMatch(/mappings\/broken\.yml \(for @acme\/broken\): `model` is `@\/nope`, which is not one of the foundation's types/)
    await expect(resolveLibraryMappings('@acme/x', { srcDir: shop })).rejects.toThrow(/`mappings` lists the library mappings/)
  })

  it('one no package here defines only warns: the registry judges it', async () => {
    const shop = foundation('shop', '@shop/storefront')
    const { map, warnings } = await resolveLibraryMappings(['@elsewhere/feed'], { srcDir: shop, ownScope: '@shop' })
    expect(map).toEqual({ '@elsewhere/feed': null })
    expect(warnings).toEqual([expect.stringMatching(/no package here defines.*registered under @elsewhere/)])
  })
})

describe('on the wire', () => {
  const schema = {
    _self: { name: '@shop/storefront', version: '1.0.0' },
    _mappings: {
      '@/own': { model: '@acme/vehicle', direction: 'out' },
      '@acme/to-meta': { model: '@acme/vehicle', direction: 'out' },
      '@elsewhere/feed': null,
    },
  }

  it("⭐ the foundation names a library's mapping in its refs and registers none of it", () => {
    const doc = buildRegistryPackage({ schema, exportedAt: '2026-11-11T00:00:00Z' })
    expect(doc.entities.filter((e) => e.model === '@uniweb/mapping-schema').map((e) => e.name)).toEqual(['@shop/own'])
    expect(doc.entities.at(-1).mappings).toEqual({
      refs: [{ name: '@acme/to-meta' }, { name: '@elsewhere/feed' }, { name: '@shop/own' }],
    })
  })

  it('a library registers its mappings after its types, with no foundation — mappings alone too', async () => {
    const lib = library('dealer', '@acme', { 'mappings/to-meta.yml': TO_META, 'mappings/inventory.yml': INVENTORY })
    const mappings = await buildMappingMap(lib, { ownTypes: ['@/vehicle'], shownIn: 'mappings' })
    const doc = buildSchemaOnlyPackage({ schemas: {}, mappings, scope: '@acme', exportedAt: '2026-11-11T00:00:00Z' })
    expect(doc.entities.map((e) => [e.model, e.name])).toEqual([
      ['@uniweb/mapping-schema', '@acme/inventory'],
      ['@uniweb/mapping-schema', '@acme/to-meta'],
    ])
    expect(doc.entities[1].rules).toMatchObject({ model: '@acme/vehicle', keys_from: '@acme/inventory' })
  })
})
