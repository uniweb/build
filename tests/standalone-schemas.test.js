/**
 * Tests for the standalone (foundation-less) data-schema register inputs:
 *   - isSchemasPackage    — detect a schemas-only package (not a foundation/site)
 *   - collectStandaloneSchemas — enumerate + normalize a package's own schemas,
 *     keyed by self-ref ('@/<name>'), from module exports or a schemas/ dir.
 *
 * These feed `buildSchemaOnlyPackage` (see uwx-registry-package.test.js) to make
 * the foundation-less `.uwx` `uniweb register` submits for a schemas package.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isSchemasPackage } from '../src/utils/classify-package.js'
import { collectStandaloneSchemas } from '../src/resolve-data-schema.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uniweb-schemas-pkg-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// A package whose entry exports schemas (the @uniweb/schemas / @org/schemas shape).
async function makeExportsPackage(dir, { name = '@acme/schemas' } = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
  await writeFile(
    join(dir, 'index.js'),
    [
      "const widget = { name: 'widget', fields: { label: { type: 'string', required: true } } }",
      "const gadget = { name: 'gadget', fields: { body: { type: 'markdown' } } }",
      'export const schemas = { widget, gadget }',
      'export function getSchemaNames() { return Object.keys(schemas) }',
      'export function getSchema(n) { return schemas[n] }',
      'export default schemas',
    ].join('\n')
  )
}

// A package that is just a schemas/ folder of files (no schema-exporting index).
async function makeDirPackage(dir, { name = 'some-shared-schemas' } = {}) {
  await mkdir(join(dir, 'schemas'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }))
  await writeFile(join(dir, 'schemas', 'product.yml'), 'name: product\nfields:\n  title: { type: string, required: true }\n')
  await writeFile(join(dir, 'schemas', 'review.json'), JSON.stringify({ name: 'review', fields: { rating: { type: 'number' } } }))
}

describe('isSchemasPackage', () => {
  test('true for an @org/schemas package (name convention)', async () => {
    await makeExportsPackage(root, { name: '@acme/schemas' })
    expect(isSchemasPackage(root)).toBe(true)
  })

  test('true for @uniweb/schemas (the standards package → @std)', async () => {
    await makeExportsPackage(root, { name: '@uniweb/schemas' })
    expect(isSchemasPackage(root)).toBe(true)
  })

  test('true for a bare schemas/ directory of files (no matching name)', async () => {
    await makeDirPackage(root)
    expect(isSchemasPackage(root)).toBe(true)
  })

  test('false for a foundation (package.json main → _entry.generated.js)', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/marketing', main: './_entry.generated.js' }))
    expect(isSchemasPackage(root)).toBe(false)
  })

  test('false for a site (site.yml at root)', async () => {
    await writeFile(join(root, 'site.yml'), 'title: My site\n')
    expect(isSchemasPackage(root)).toBe(false)
  })

  test('false for an unrelated package (no name match, no schemas/ dir)', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'just-a-lib', main: 'index.js' }))
    expect(isSchemasPackage(root)).toBe(false)
  })
})

describe('collectStandaloneSchemas', () => {
  test('enumerates a package that exports schemas, keyed by @/<name>, normalized', async () => {
    await makeExportsPackage(root)
    const map = await collectStandaloneSchemas(root)
    expect(Object.keys(map).sort()).toEqual(['@/gadget', '@/widget'])
    // normalization ran: the 'markdown' alias folds to the canonical 'richtext' kind
    expect(map['@/gadget'].fields.body.type).toBe('richtext')
    expect(map['@/widget'].fields.label).toMatchObject({ type: 'string', required: true })
  })

  test('falls back to a schemas/ directory of files (yml + json), keyed by basename', async () => {
    await makeDirPackage(root)
    const map = await collectStandaloneSchemas(root)
    expect(Object.keys(map).sort()).toEqual(['@/product', '@/review'])
    expect(map['@/product'].fields.title).toMatchObject({ type: 'string', required: true })
    // 'number' alias folds to 'decimal'
    expect(map['@/review'].fields.rating.type).toBe('decimal')
  })

  test('module exports win over a schemas/ dir when both are present', async () => {
    await makeExportsPackage(root)
    await mkdir(join(root, 'schemas'), { recursive: true })
    await writeFile(join(root, 'schemas', 'ignored.yml'), 'name: ignored\nfields:\n  x: { type: string }\n')
    const map = await collectStandaloneSchemas(root)
    expect(Object.keys(map).sort()).toEqual(['@/gadget', '@/widget']) // dir not consulted
  })

  test('returns {} for a package with neither exports nor a schemas/ dir', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'empty', type: 'module' }))
    const map = await collectStandaloneSchemas(root)
    expect(map).toEqual({})
  })

  test('a malformed schema throws a clear, named error (validated before publish)', async () => {
    await mkdir(join(root, 'schemas'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/schemas', type: 'module' }))
    // neither fields nor sections → invalid
    await writeFile(join(root, 'schemas', 'broken.yml'), 'name: broken\ndescription: nope\n')
    await expect(collectStandaloneSchemas(root)).rejects.toThrow(/'@\/broken'.*'fields' or 'sections'/)
  })
})
