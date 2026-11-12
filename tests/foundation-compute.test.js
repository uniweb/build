/**
 * ⭐ Compute functions (`foundation/compute.js`, `foundation/library-compute.js`): one plain-JS file
 * per name in `compute/`, shipped as written. The build refuses what would stop a file standing
 * alone, warns of a function that writes outside itself, keeps each file's exports in `_compute`,
 * and `register` sends one `@uniweb/vendor-schema` artifact per file with its bytes' sha256 and size.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildComputeMap, checkComputeSource, ownComputeFiles, computeFileDigest } from '../src/foundation/compute.js'
import { resolveLibraryCompute } from '../src/foundation/library-compute.js'
import { workspaceComputeFiles } from '../src/foundation/shared-types.js'
import { isSchemasPackage } from '../src/utils/classify-package.js'
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

const GRADER = `const PASS = 0.5
export function grade(input) {
  const key = new Map(input.key.map((k) => [k.question, k.correct]))
  let points = 0
  for (const a of input.answers) if (key.get(a.question) === a.chosen) points += 1
  return { points, max: input.key.length }
}
export const eligible = (input) => ({ eligible: input.grades.every((g) => g.points / g.max >= PASS) })
`

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'compute-'))
  w('pnpm-workspace.yaml', "packages:\n  - '*'\n")
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a compute file — what the build refuses', () => {
  it('takes a file of named functions, and lists them sorted', async () => {
    expect(await checkComputeSource(GRADER)).toEqual({ exports: ['eligible', 'grade'], problems: [], warnings: [] })
    const listed = await checkComputeSource('function a() {}\nconst b = function () {}\nexport { a, b as bee }\n')
    expect(listed.exports).toEqual(['a', 'bee'])
  })

  it('refuses imports, re-exports, a default export and an export that is not a function', async () => {
    const { problems } = await checkComputeSource(
      "import x from 'y'\nexport default function () {}\nexport const n = 3\nlet f = () => {}\nexport { f }\nexport class C {}\nexport * from 'q'\nexport { g } from 'h'\n"
    )
    expect(problems).toEqual([
      expect.stringMatching(/^imports `y`: a compute file has no imports/),
      expect.stringMatching(/^has a default export/),
      expect.stringMatching(/^exports `n`, which is not a function/),
      expect.stringMatching(/^exports `f`, which is not a function the file defines/),
      expect.stringMatching(/^exports a class/),
      expect.stringMatching(/^re-exports `q`/),
      expect.stringMatching(/^re-exports from `h`/),
    ])
  })

  it('refuses `import()`, a name that is not a JavaScript name, a file with no function, and one that does not parse', async () => {
    expect((await checkComputeSource("export async function f() { await import('x') }")).problems).toEqual([
      expect.stringMatching(/^calls `import\(\)`/),
    ])
    expect((await checkComputeSource('function f() {}\nexport { f as "x-y" }')).problems).toEqual([
      expect.stringMatching(/^exports `x-y`, which is not a JavaScript name/),
    ])
    expect((await checkComputeSource('const a = 1')).problems).toEqual([expect.stringMatching(/^exports no function/)])
    expect((await checkComputeSource('export function (')).problems).toEqual([expect.stringMatching(/^does not parse/)])
  })
})

describe('a compute file — the warning about a call that writes outside itself', () => {
  it('⭐ warns of each top-level binding a function writes to: assigned, counted, or changed by a method', async () => {
    const { warnings, problems } = await checkComputeSource(
      'const keys = {}\nlet count = 0\nconst cache = new Map()\nconst list = []\n' +
        'export function grade(input) {\n  keys[input.quiz] ??= input.key\n  count++\n  cache.set(input.a, 1)\n  Object.assign(list, input.b)\n  return {}\n}\n'
    )
    expect(problems).toEqual([])
    expect(warnings.map((x) => x.match(/`(\w+)`/)[1])).toEqual(['keys', 'count', 'cache', 'list'])
  })

  it('says nothing of a table built once at the top, nor of a name the function declares itself', async () => {
    const { warnings } = await checkComputeSource(
      'const TABLE = new Map()\nTABLE.set(1, 2)\nconst keys = {}\n' +
        'export function grade(keys, { cache }) {\n  keys.a = 1\n  cache.set(1, 2)\n  const out = {}\n  out.x = TABLE.get(1)\n  for (let i = 0; i < 2; i++) out.y = i\n  return out\n}\n'
    )
    expect(warnings).toEqual([])
  })
})

describe('a compute file — the warning about a name that isn\'t there when it runs', () => {
  it('⭐ warns of Node\'s globals and the network, which a test in Node lets pass', async () => {
    const { warnings, problems } = await checkComputeSource(
      'export async function grade(input) {\n  const r = await fetch(input.url)\n  return { at: process.env.X, b: Buffer.from(input.s) }\n}\n'
    )
    expect(problems).toEqual([])
    expect(warnings.map((x) => x.match(/`(\w+)`/)[1])).toEqual(['process', 'Buffer', 'fetch'])
    expect(warnings[2]).toMatch(/no network/)
  })

  it('says nothing of the same names as properties, labels or the file\'s own bindings', async () => {
    const { warnings } = await checkComputeSource(
      'const fetch = (x) => x\n' +
        'export function grade(input, { process }) {\n  const o = { Buffer: 1, require() {} }\n  o.module = input.global\n  class A { exports = 1 }\n  return { a: fetch(1), b: process, c: typeof setImmediate }\n}\n'
    )
    expect(warnings).toEqual([expect.stringMatching(/^uses `setImmediate`/)])
  })
})

describe('compute/ in a foundation and a library', () => {
  it('reads a package\'s own `.js` files, leaving out `_` names, into `{ "@/name": { exports } }`', async () => {
    const shop = foundation('shop', '@shop/storefront')
    w('shop/compute/courses.js', GRADER)
    w('shop/compute/_helper.js', 'export function h() {}')
    w('shop/compute/notes.md', '# no')
    expect(ownComputeFiles(shop).map((f) => f.name)).toEqual(['courses'])
    expect(await buildComputeMap(shop)).toEqual({ map: { '@/courses': { exports: ['eligible', 'grade'] } }, warnings: [] })
  })

  it('refuses a file it cannot register, naming it', async () => {
    const shop = foundation('shop', '@shop/storefront')
    w('shop/compute/bad.js', 'export default 1')
    await expect(buildComputeMap(shop)).rejects.toThrow(/src\/compute\/bad\.js has a default export/)
  })

  it('a library of compute files alone is a schemas package, found by its scope and name', async () => {
    const lib = library('grading', '@lib', { 'compute/grading.js': GRADER })
    expect(isSchemasPackage(lib)).toBe(true)
    const shop = foundation('shop', '@shop/storefront')
    expect(await workspaceComputeFiles('@lib/grading', shop)).toEqual([join(ROOT, 'grading/compute/grading.js')])
  })

  it('only a compute file makes one: a compute/ of JSON, or of `_` files, does not', () => {
    expect(isSchemasPackage(library('data-only', '@lib', { 'compute/table.json': '{}' }))).toBe(false)
    expect(isSchemasPackage(library('helpers-only', '@lib', { 'compute/_helper.js': 'export const x = 1\n' }))).toBe(false)
  })

  it('⭐ main.js `compute:` carries a library\'s files by full name, and refuses what it cannot', async () => {
    library('grading', '@lib', { 'compute/grading.js': GRADER, 'compute/broken.js': "import x from 'y'\nexport function f() {}" })
    const shop = foundation('shop', '@shop/storefront')
    const { map, warnings } = await resolveLibraryCompute(['@lib/grading', '@lib/elsewhere'], { srcDir: shop, ownScope: '@shop' })
    expect(map).toEqual({ '@lib/grading': { exports: ['eligible', 'grade'] }, '@lib/elsewhere': null })
    expect(warnings).toEqual([expect.stringMatching(/`@lib\/elsewhere`, which no package here defines/)])
    await expect(resolveLibraryCompute(['@/mine', '@shop/own', '@lib/broken'], { srcDir: shop, ownScope: '@shop' })).rejects.toThrow(
      /src\/compute\/, and is not listed[\s\S]*in the foundation's own scope[\s\S]*compute\/broken\.js \(for @lib\/broken\) imports `y`/
    )
    await expect(resolveLibraryCompute('@lib/grading', { srcDir: shop })).rejects.toThrow(/`compute` lists the library compute files/)
  })
})

describe('the register .uwx — literal, as agreed with the registry', () => {
  it('the sha256 and size are of the bytes as written', () => {
    w('lib/compute/grading.js', GRADER)
    expect(computeFileDigest(join(ROOT, 'lib/compute/grading.js'))).toEqual({
      sha256: createHash('sha256').update(GRADER).digest('hex'),
      size: Buffer.byteLength(GRADER),
    })
  })

  it('⭐ a foundation: one artifact per own file before the foundation, and refs for its own and its library ones', () => {
    const schema = {
      _self: { name: '@courses/school', version: '1.0.0' },
      _compute: { '@/courses': { exports: ['grade', 'eligible'] }, '@lib/grading': { exports: ['score'] } },
    }
    const doc = buildRegistryPackage({
      schema,
      vendors: { '@/courses': { exports: ['grade', 'eligible'], sha256: 'a'.repeat(64), size: 812 } },
    })
    expect(doc.entities.map((e) => e.model)).toEqual(['@uniweb/vendor-schema', '@uniweb/foundation-schema'])
    expect(doc.entities[0]).toEqual({
      model: '@uniweb/vendor-schema',
      name: '@courses/courses',
      exports: ['eligible', 'grade'],
      sha256: 'a'.repeat(64),
      size: 812,
    })
    const fnd = doc.entities[1]
    expect(fnd.vendors).toEqual({ refs: [{ name: '@courses/courses' }, { name: '@lib/grading' }] })
    expect(fnd.schema._compute).toBeUndefined()
    expect(fnd.schema._self.compute).toBeUndefined()
  })

  it('a foundation with none sends no `vendors` key', () => {
    const doc = buildRegistryPackage({ schema: { _self: { name: '@courses/school', version: '1.0.0' } } })
    expect('vendors' in doc.entities.at(-1)).toBe(false)
  })

  it('a library: its artifacts in the schemas-only package, which holds compute files alone too', () => {
    const doc = buildSchemaOnlyPackage({
      vendors: { '@/grading': { exports: ['score'], sha256: 'b'.repeat(64), size: 40 } },
      scope: '@lib',
    })
    expect(doc.entities).toEqual([
      { model: '@uniweb/vendor-schema', name: '@lib/grading', exports: ['score'], sha256: 'b'.repeat(64), size: 40 },
    ])
  })
})

describe('buildSchema — `_compute`', () => {
  it('⭐ holds its own files and the library ones main.js lists, and `_self` keeps no `compute`', async () => {
    const { buildSchema } = await import('../src/schema.js')
    library('grading', '@lib', { 'compute/grading.js': 'export function score(input) { return { s: 1 } }\n' })
    const shop = foundation('shop', '@shop/storefront')
    w('shop/main.js', "export default { name: '@shop/storefront', compute: ['@lib/grading'] }\n")
    w('shop/compute/courses.js', GRADER)
    const schema = await buildSchema(shop)
    expect(schema._compute).toEqual({ '@/courses': { exports: ['eligible', 'grade'] }, '@lib/grading': { exports: ['score'] } })
    expect(schema._self.compute).toBeUndefined()
  })
})
