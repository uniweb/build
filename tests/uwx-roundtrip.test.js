// The collection-sync fixpoint: a file → sync → back-fill cycle, run with NO
// backend (the mint is simulated from the emitter's index). Two guarantees:
//   pass 1 — a pristine authored file gains ONLY a `$uuid`;
//   pass 2 — a no-op re-sync is byte-identical (the cycle has a fixpoint).
// This is the oracle for "sync brings files into actual sync; re-sync with no
// changes changes nothing." See kb/framework/build/collection-sync-source-and-roundtrip.md.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitCollectionSyncPackage, backfillEntityUuids } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let root
let siteDir

const PRODUCT_YML = 'title: Widget X\nprice: 9.99\n' // already in canonical yaml.dump form
const ARTICLE_MD = '---\ntitle: Hello\n---\n\n# Welcome\n\nThe body.\n'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uwx-rt-'))
  siteDir = join(root, 'site')
  const foundationDir = join(root, 'foundation')
  mkdirSync(join(siteDir, 'collections', 'products'), { recursive: true })
  mkdirSync(join(siteDir, 'collections', 'articles'), { recursive: true })
  mkdirSync(join(foundationDir, 'dist', 'meta'), { recursive: true })

  writeFileSync(
    join(siteDir, 'site.yml'),
    [
      'name: Test',
      'foundation: "@acme/marketing"',
      'collections:',
      '  products:',
      '    path: collections/products',
      '    model: "@acme/product"',
      '  articles:',
      '    path: collections/articles',
      '    model: "@acme/article"',
      '',
    ].join('\n')
  )
  writeFileSync(
    join(siteDir, 'package.json'),
    JSON.stringify({ name: 'site', dependencies: { foundation: 'file:../foundation' } })
  )
  writeFileSync(join(siteDir, 'collections', 'products', 'widget-x.yml'), PRODUCT_YML)
  writeFileSync(join(siteDir, 'collections', 'articles', 'hello.md'), ARTICLE_MD)

  const schema = {
    _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
    dataSchemas: {
      '@/product': validateAndNormalizeSchema(
        { name: 'product', fields: { title: { type: 'string' }, price: { type: 'decimal' } } },
        '@/product'
      ),
      // a richtext `body` field — the markdown body's target
      '@/article': validateAndNormalizeSchema(
        { name: 'article', fields: { title: { type: 'string' }, body: { type: 'richtext' } } },
        '@/article'
      ),
    },
  }
  writeFileSync(join(foundationDir, 'dist', 'meta', 'schema.json'), JSON.stringify(schema))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

// One sync cycle, backend simulated: build the package, mint a deterministic
// uuid per record from the index, back-fill into the source files.
async function syncCycle() {
  const { index, warnings } = await emitCollectionSyncPackage(siteDir)
  const finalized = index.map((e) => ({ $id: e.id, $model: e.model, $uuid: `uuid-${e.slug}` }))
  const bf = backfillEntityUuids({ index, finalized })
  return { warnings, bf }
}

const ymlPath = () => join(siteDir, 'collections', 'products', 'widget-x.yml')
const mdPath = () => join(siteDir, 'collections', 'articles', 'hello.md')
const stripUuidLine = (text) => text.replace(/^\$uuid: .*\n/m, '')

describe('collection-sync fixpoint', () => {
  it('does not warn about unknown fields (frontmatter matches the data schema)', async () => {
    const { warnings } = await syncCycle()
    expect(warnings.filter((w) => /is not on/.test(w))).toEqual([])
  })

  it('pass 1: a pristine file gains ONLY a $uuid (YAML and markdown)', async () => {
    const { bf } = await syncCycle()
    expect(bf.updated).toHaveLength(2)

    const yml = readFileSync(ymlPath(), 'utf8')
    expect(yml).toMatch(/^\$uuid: uuid-widget-x\n/)
    expect(stripUuidLine(yml)).toBe(PRODUCT_YML) // nothing else changed

    const md = readFileSync(mdPath(), 'utf8')
    expect(md.startsWith('---\n$uuid: uuid-hello\n')).toBe(true)
    expect(stripUuidLine(md)).toBe(ARTICLE_MD) // body + frontmatter otherwise intact
  })

  it('pass 2: a no-op re-sync is byte-identical (fixpoint reached)', async () => {
    await syncCycle() // pass 1 — adds $uuid
    const afterPass1 = { yml: readFileSync(ymlPath(), 'utf8'), md: readFileSync(mdPath(), 'utf8') }

    const { bf } = await syncCycle() // pass 2 — no edits
    expect(bf.updated).toHaveLength(0)
    expect(bf.unchanged).toHaveLength(2)
    expect(readFileSync(ymlPath(), 'utf8')).toBe(afterPass1.yml)
    expect(readFileSync(mdPath(), 'utf8')).toBe(afterPass1.md)
  })
})
