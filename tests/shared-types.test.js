/**
 * `typesDefinedTwice` (`src/foundation/shared-types.js`): the names two packages of one scope in a
 * workspace each define — two foundations, or a foundation and the scope's schemas package — with whether
 * the definitions agree. Any foundation may use another's registered type by its full name, so such a
 * name is a copy, which `uniweb doctor` points out.
 *
 * Measured 2026-11-08: one workspace of the 51 scanned had them, three foundations of one scope holding
 * copies of four types, all agreeing that day.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { typesDefinedTwice } from '../src/foundation/shared-types.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
beforeEach(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'shared-types-')))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const MEMBER = 'name: member\nfields:\n  name: { type: text }\n'
// A flat foundation named `name`, defining each schema given.
const foundation = (dir, name, schemas = {}) => {
  w(`${dir}/package.json`, JSON.stringify({ name: dir.replace(/\//g, '-'), main: './_entry.generated.js' }))
  w(`${dir}/main.js`, `export default { name: '${name}' }\n`)
  for (const [file, body] of Object.entries(schemas)) w(`${dir}/schemas/${file}`, body)
  return { dir: join(ROOT, dir), kind: 'foundation' }
}

describe('typesDefinedTwice', () => {
  it('⭐ two foundations of one scope defining one name: the type, both files, and that they agree', async () => {
    const a = foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const b = foundation('press', '@acme/press', { 'member.yml': MEMBER })
    expect(await typesDefinedTwice([a, b])).toEqual([
      { ref: '@acme/member', files: [join(ROOT, 'hub/schemas/member.yml'), join(ROOT, 'press/schemas/member.yml')], differ: false },
    ])
  })

  it('copies that say different things are said to', async () => {
    const a = foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const b = foundation('press', '@acme/press', { 'member.yml': MEMBER + '  role: { type: text }\n' })
    expect((await typesDefinedTwice([a, b]))[0]).toMatchObject({ ref: '@acme/member', differ: true })
  })

  it('a foundation and the scope\'s schemas package are two definitions too', async () => {
    const a = foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    w('schemas-pkg/package.json', JSON.stringify({ name: '@acme/schemas' }))
    w('schemas-pkg/schemas/member.yml', MEMBER)
    const found = await typesDefinedTwice([a, { dir: join(ROOT, 'schemas-pkg'), kind: 'schemas' }])
    expect(found.map((t) => t.ref)).toEqual(['@acme/member'])
  })

  it('a foundation whose name gives no scope yet is left out, until `register` writes one into its name', async () => {
    const a = foundation('hub', 'hub', { 'member.yml': MEMBER })
    const b = foundation('press', 'press', { 'member.yml': MEMBER })
    // Neither type has a full name to compare yet.
    expect(await typesDefinedTwice([a, b])).toEqual([])
    // Once `register` has written each one's scope, they are one type.
    const c = foundation('hub2', '@acme/hub', { 'member.yml': MEMBER })
    const d = foundation('press2', '@acme/press', { 'member.yml': MEMBER })
    expect((await typesDefinedTwice([c, d])).map((t) => t.ref)).toEqual(['@acme/member'])
  })

  it('CONTROL — one name in two scopes is two types, and one foundation\'s own types are one each', async () => {
    const a = foundation('hub', '@acme/hub', { 'member.yml': MEMBER, 'article.yml': 'name: article\nfields:\n  title: { type: text }\n' })
    const b = foundation('other', '@other/site', { 'member.yml': MEMBER })
    expect(await typesDefinedTwice([a, b, a])).toEqual([])
  })
})
