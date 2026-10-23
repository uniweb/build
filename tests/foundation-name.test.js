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
  checkRegistrationScope,
  splitFoundationName,
  FORBIDDEN_FOUNDATION_NAMES,
  RESERVED_SCOPES,
} from '../src/foundation-name.js'
import { readFoundationName, buildSchema } from '../src/schema.js'
import { buildRegistryPackage, buildSchemaOnlyPackage } from '../src/uwx/registry-package.js'
import { validateAndNormalizeSchema } from '../src/resolve-data-schema.js'

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

// ⛔ `@uniweb` names the framework's own packages and a system account on every Uniweb
// backend [Diego, 2026-10-23], so nothing registers under it — refused by the name rule,
// before a build or a backend gets the chance.
describe('⛔ the @uniweb scope is reserved', () => {
  it('refuses a foundation named under it, in any case, and says why', () => {
    expect([...RESERVED_SCOPES]).toEqual(['uniweb'])
    for (const name of ['@uniweb/marketing', '@Uniweb/marketing', '@UNIWEB/book']) {
      expect(checkFoundationName(name), name).toMatch(/is named under @uniweb, which is reserved/)
      expect(checkFoundationName(name), name).toMatch(/the Uniweb framework's own packages/)
    }
  })

  it('refuses the scope itself, in each spelling register reads', () => {
    for (const scope of ['@uniweb', 'uniweb', '@UniWeb', '@uniweb/x']) {
      expect(checkRegistrationScope(scope), scope).toMatch(/^@uniweb is reserved: /)
    }
  })

  it('CONTROL — other scopes pass, the standard one and look-alikes included', () => {
    for (const scope of ['@acme', 'acme', '@std', '@uniweb-fans', '@my-uniweb', null, undefined, '']) {
      expect(checkRegistrationScope(scope), String(scope)).toBeNull()
    }
    for (const name of ['@std/docs', '@uniweb-fans/marketing', 'uniweb', 'uniweb-book']) {
      expect(checkFoundationName(name), name).toBeNull()
    }
  })

  it('the registry packages refuse it too, whoever builds them', () => {
    const schema = (name) => ({ _self: { name, version: '0.1.0' } })
    expect(() => buildRegistryPackage({ schema: schema('@uniweb/marketing') })).toThrow(/reserved/)
    // a bare name given the scope at build time is the same name
    expect(() => buildRegistryPackage({ schema: schema('marketing'), scope: '@uniweb' })).toThrow(/reserved/)
    const schemas = {
      '@/person': validateAndNormalizeSchema({ fields: { name: { type: 'string' } } }, '@/person'),
    }
    expect(() => buildSchemaOnlyPackage({ schemas, scope: '@uniweb' })).toThrow(/reserved/)
    expect(buildSchemaOnlyPackage({ schemas, scope: '@std' }).entities.length).toBe(1)
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
