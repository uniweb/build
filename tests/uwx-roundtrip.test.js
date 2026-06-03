// The collection-sync fixpoint: a file → sync → back-fill cycle, run with NO
// backend (the mint is simulated from the emitter's index). Two guarantees:
//   pass 1 — a pristine authored file gains ONLY a `$uuid`;
//   pass 2 — a no-op re-sync is byte-identical (the cycle has a fixpoint).
// This is the oracle for "sync brings files into actual sync; re-sync with no
// changes changes nothing." See kb/framework/build/collection-sync-source-and-roundtrip.md.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { emitCollectionSyncPackage, backfillEntityUuids, readZip } from '../src/uwx/index.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

let root
let siteDir

const PRODUCT_YML = 'title: Widget X\nprice: 9.99\n' // already in canonical yaml.dump form
const ARTICLE_MD = '---\ntitle: Hello\n---\n\n# Welcome\n\nThe body.\n'
// array-form: many records in ONE file, each its own entity
const TAGS_YML = '- slug: a\n  name: Alpha\n- slug: b\n  name: Beta\n'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uwx-rt-'))
  siteDir = join(root, 'site')
  const foundationDir = join(root, 'foundation')
  mkdirSync(join(siteDir, 'collections', 'products'), { recursive: true })
  mkdirSync(join(siteDir, 'collections', 'articles'), { recursive: true })
  mkdirSync(join(siteDir, 'collections', 'tags'), { recursive: true })
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
      '  tags:',
      '    path: collections/tags',
      '    model: "@acme/tag"',
      '',
    ].join('\n')
  )
  writeFileSync(
    join(siteDir, 'package.json'),
    JSON.stringify({ name: 'site', dependencies: { foundation: 'file:../foundation' } })
  )
  writeFileSync(join(siteDir, 'collections', 'products', 'widget-x.yml'), PRODUCT_YML)
  writeFileSync(join(siteDir, 'collections', 'articles', 'hello.md'), ARTICLE_MD)
  writeFileSync(join(siteDir, 'collections', 'tags', 'all.yml'), TAGS_YML)

  const schema = {
    _self: { name: '@acme/marketing', version: '1.0.0', role: 'foundation' },
    dataSchemas: {
      '@/product': validateAndNormalizeSchema(
        { name: 'product', fields: { title: { type: 'string' }, price: { type: 'decimal' } } },
        '@/product'
      ),
      // a markdown `body` field — the markdown body's target (text + format: markdown)
      '@/article': validateAndNormalizeSchema(
        { name: 'article', fields: { title: { type: 'string' }, body: { type: 'markdown' } } },
        '@/article'
      ),
      '@/tag': validateAndNormalizeSchema(
        { name: 'tag', fields: { name: { type: 'string' } } },
        '@/tag'
      ),
    },
  }
  writeFileSync(join(foundationDir, 'dist', 'meta', 'schema.json'), JSON.stringify(schema))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

// One sync cycle, backend simulated. Build the package; for each submitted entity
// (entries order = index order), take the doc we sent, mint the entity `$uuid` +
// the brief record `$uuid`, and return it as `finalized[].document` correlated by
// `index` (the real response shape `{ index, uuid, changed, document }`). Then
// back-fill, which renders each document over its source file (variant A).
async function syncCycle() {
  const { buffer, index, warnings } = await emitCollectionSyncPackage(siteDir)
  const files = readZip(buffer)
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  const finalized = manifest.entries.map((entry, i) => {
    const doc = JSON.parse(files.get(entry.file).toString('utf8'))
    const briefKey = Object.keys(doc).find((k) => !k.startsWith('$'))
    const uuid = `uuid-${index[i].slug}`
    return {
      index: i,
      uuid,
      changed: true,
      document: {
        $uuid: uuid,
        $model: doc.$model,
        [briefKey]: { $uuid: `rec-${index[i].slug}`, ...doc[briefKey] },
      },
    }
  })
  const bf = backfillEntityUuids({ index, finalized })
  return { warnings, bf, finalized }
}

const ymlPath = () => join(siteDir, 'collections', 'products', 'widget-x.yml')
const mdPath = () => join(siteDir, 'collections', 'articles', 'hello.md')
const tagsPath = () => join(siteDir, 'collections', 'tags', 'all.yml')
const stripUuidLine = (text) => text.replace(/^\$uuid: .*\n/m, '')

describe('collection-sync fixpoint', () => {
  it('does not warn about unknown fields (frontmatter matches the data schema)', async () => {
    const { warnings } = await syncCycle()
    expect(warnings.filter((w) => /is not on/.test(w))).toEqual([])
  })

  it('pass 1: a pristine single-record file gains ONLY a $uuid (YAML and markdown)', async () => {
    const { bf } = await syncCycle()
    // products.yml + hello.md + the tags array file (one write) = 3
    expect(bf.updated).toHaveLength(3)

    const yml = readFileSync(ymlPath(), 'utf8')
    expect(yml).toMatch(/^\$uuid: uuid-widget-x\n/)
    expect(stripUuidLine(yml)).toBe(PRODUCT_YML) // nothing else changed

    const md = readFileSync(mdPath(), 'utf8')
    expect(md.startsWith('---\n$uuid: uuid-hello\n')).toBe(true)
    expect(stripUuidLine(md)).toBe(ARTICLE_MD) // body + frontmatter otherwise intact
  })

  it('pass 1: an array-form file gets one $uuid PER entry (each entry its own entity)', async () => {
    await syncCycle()
    const arr = yaml.load(readFileSync(tagsPath(), 'utf8'))
    expect(arr.map((e) => e.$uuid)).toEqual(['uuid-a', 'uuid-b'])
    // other data preserved per element
    expect(arr.map(({ $uuid, ...rest }) => rest)).toEqual([
      { slug: 'a', name: 'Alpha' },
      { slug: 'b', name: 'Beta' },
    ])
  })

  it('pass 2: a no-op re-sync is byte-identical (fixpoint reached, incl. array form)', async () => {
    await syncCycle() // pass 1 — adds $uuid
    const afterPass1 = {
      yml: readFileSync(ymlPath(), 'utf8'),
      md: readFileSync(mdPath(), 'utf8'),
      tags: readFileSync(tagsPath(), 'utf8'),
    }

    const { bf } = await syncCycle() // pass 2 — no edits
    expect(bf.updated).toHaveLength(0)
    expect(bf.unchanged).toHaveLength(3)
    expect(readFileSync(ymlPath(), 'utf8')).toBe(afterPass1.yml)
    expect(readFileSync(mdPath(), 'utf8')).toBe(afterPass1.md)
    expect(readFileSync(tagsPath(), 'utf8')).toBe(afterPass1.tags)
  })
})
