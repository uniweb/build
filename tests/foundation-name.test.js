// A foundation's NAME — one rule for the build, `register` and `push`: `main.js`'s
// `name`, else `package.json`'s. `src` and `foundation` name the folder, not the
// foundation, and are refused as one's name: every project in an org would otherwise
// register the same `@org/src`. `package.json::uniweb.id` is retired (2026-09-21), and
// so is `uniweb.scope` (2026-09-22) — the scope is part of the name, `@acme/marketing`.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  foundationNameOf,
  checkFoundationName,
  splitFoundationName,
  FORBIDDEN_FOUNDATION_NAMES,
} from '../src/foundation-name.js'
import { readFoundationName, buildSchema } from '../src/schema.js'
import { buildRegistryPackage } from '../src/uwx/registry-package.js'

const dirs = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A flat-layout foundation: package.json + main.js at the root. */
function foundation({ pkg = {}, main = 'export default {}\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uw-fname-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'src', version: '0.1.0', type: 'module', main: './_entry.generated.js', ...pkg })
  )
  if (main !== null) writeFileSync(join(dir, 'main.js'), main)
  mkdirSync(join(dir, 'sections'), { recursive: true })
  return dir
}

describe('the rule — main.js name, else package.json name', () => {
  it('main.js wins', () => {
    expect(foundationNameOf({ config: { name: 'marketing' }, pkg: { name: 'src' } })).toEqual({
      name: 'marketing',
      source: 'main.js',
    })
  })

  it('CONTROL — with no main.js name, the package name is the name', () => {
    expect(foundationNameOf({ config: {}, pkg: { name: '@acme/base' } })).toEqual({
      name: '@acme/base',
      source: 'package.json',
    })
  })

  it('the build and the reader agree, because both ask the rule', async () => {
    const dir = foundation({ main: "export default { name: 'marketing' }\n" })
    const read = await readFoundationName(dir)
    const schema = await buildSchema(dir)
    expect(read).toMatchObject({ name: 'marketing', source: 'main.js' })
    expect(schema._self.name).toBe(read.name)
  })
})

describe('⛔ src and foundation are not foundation names', () => {
  it('refuses both, bare or scoped', () => {
    expect([...FORBIDDEN_FOUNDATION_NAMES]).toEqual(['src', 'foundation'])
    for (const name of ['src', 'foundation', '@acme/src', '@acme/foundation']) {
      expect(checkFoundationName(name), name).toMatch(/names the folder, not the foundation/)
    }
  })

  it('CONTROL — a real name passes, bare or scoped', () => {
    for (const name of ['marketing', 'acme-docs', '@acme/marketing', 'src-kit']) {
      expect(checkFoundationName(name), name).toBeNull()
    }
  })

  it('refuses a name that is not one — a display title, a path, nothing', () => {
    expect(checkFoundationName('Marketing Template')).toMatch(/use lowercase letters, digits and hyphens/)
    expect(checkFoundationName('a/b')).toMatch(/is not a foundation name/)
    expect(checkFoundationName('')).toMatch(/has no name/)
    expect(checkFoundationName(undefined)).toMatch(/has no name/)
  })

  it('the registry package refuses them too, whoever builds it', () => {
    const schema = (name) => ({ _self: { name, version: '0.1.0' } })
    expect(() => buildRegistryPackage({ schema: schema('src'), scope: '@acme' })).toThrow(/names the folder/)
    expect(() => buildRegistryPackage({ schema: schema('Marketing Template'), scope: '@acme' })).toThrow(
      /lowercase letters/
    )
    const ok = buildRegistryPackage({ schema: schema('marketing'), scope: '@acme' })
    expect(ok.entities.find((e) => e.model === '@uniweb/foundation-schema').info.name).toBe('@acme/marketing')
  })
})

describe('splitFoundationName — the scope is half of the name', () => {
  it('splits a scoped name into its scope and the name within it', () => {
    expect(splitFoundationName('@acme/marketing')).toEqual({ scope: '@acme', bare: 'marketing' })
  })

  it('a bare name has no scope yet', () => {
    expect(splitFoundationName('marketing')).toEqual({ scope: null, bare: 'marketing' })
  })

  it('nothing to split is nothing', () => {
    expect(splitFoundationName('')).toEqual({ scope: null, bare: null })
    expect(splitFoundationName(undefined)).toEqual({ scope: null, bare: null })
  })
})

describe('readFoundationName', () => {
  it('⛔ refuses a leftover uniweb.id, naming the move', async () => {
    const dir = foundation({ pkg: { uniweb: { id: 'docs' } } })
    await expect(readFoundationName(dir)).rejects.toThrow("Move it there (name: 'docs')")
  })

  it('⛔ refuses a leftover uniweb.scope, naming the line that replaces it', async () => {
    // A leftover would register the name and the data schemas under two orgs.
    const dir = foundation({
      pkg: { uniweb: { scope: '@acme' } },
      main: "export default { name: 'marketing' }\n",
    })
    await expect(readFoundationName(dir)).rejects.toThrow("Move it there (name: '@acme/marketing')")
  })

  it('⛔ …and says it can simply go when main.js already scopes the name', async () => {
    const dir = foundation({
      pkg: { uniweb: { scope: 'acme' } },
      main: "export default { name: '@acme/marketing' }\n",
    })
    await expect(readFoundationName(dir)).rejects.toThrow(
      "main.js already names it '@acme/marketing', so remove uniweb.scope"
    )
  })

  it('reads a scoped name whole — the scope is part of it', async () => {
    const dir = foundation({ main: "export default { name: '@acme/marketing' }\n" })
    expect((await readFoundationName(dir)).name).toBe('@acme/marketing')
  })

  it('reads main.js again after it changes — the import is by content', async () => {
    // register can write a name into main.js while push, in one process, reads the
    // name before and after. Node caches a module by URL, so this read the first
    // content until the import was keyed by content.
    const dir = foundation()
    expect((await readFoundationName(dir)).name).toBe('src')
    writeFileSync(join(dir, 'main.js'), "export default { name: 'marketing' }\n")
    expect((await readFoundationName(dir)).name).toBe('marketing')
  })

  it('says where main.js is, even before it exists', async () => {
    const dir = foundation({ main: null })
    const read = await readFoundationName(dir)
    expect(read).toMatchObject({ name: 'src', source: 'package.json' })
    expect(read.mainFile).toBe(join(dir, 'main.js'))
  })
})
