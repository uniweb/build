import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDataSchemaMap } from '../src/resolve-data-schema.js'

// schemas.config.js alias routing: a foundation maps a scope to a directory of
// bare schema files anywhere on disk — no package, no install, no node_modules.
// Each test uses a fresh temp dir so the dynamically-imported config isn't
// shared via Node's ESM module cache.

function makeFixture(configBody, { extFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uniweb-alias-'))
  const fnd = join(root, 'foundation')
  mkdirSync(fnd, { recursive: true })
  // type: module so the .js config imports as ESM (real foundations are ESM-only).
  writeFileSync(join(fnd, 'package.json'), JSON.stringify({ name: 'fnd', type: 'module', main: './_entry.generated.js' }))
  writeFileSync(join(fnd, 'schemas.config.js'), configBody)
  const ext = join(root, 'ext-schemas')
  mkdirSync(ext, { recursive: true })
  for (const [name, body] of Object.entries(extFiles)) writeFileSync(join(ext, name), body)
  return { root, fnd, ext, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const PERSON_YML = ['name: person', 'fields:', '  name: { type: string, required: true }', '  email: { type: email }'].join('\n')
const PROJECT_YML = ['name: project', 'fields:', '  title: { type: string, required: true }', "  lead: { type: ref, ref: '@agency/person' }"].join('\n')

describe('schemas.config.js alias routing', () => {
  it('resolves a scope to a bare folder of schema files (no package)', async () => {
    const fx = makeFixture("export default { '@agency': '../ext-schemas' }", {
      extFiles: { 'person.yml': PERSON_YML },
    })
    try {
      const map = await buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })
      expect(map['@agency/person'].fields.name).toEqual({ type: 'string', required: true })
      // email lowered to string + format by the normalizer (proves it ran)
      expect(map['@agency/person'].fields.email).toEqual({ type: 'string', format: 'email' })
    } finally {
      fx.cleanup()
    }
  })

  it('closes over transitive refs through the same alias', async () => {
    const fx = makeFixture("export default { '@agency': '../ext-schemas' }", {
      extFiles: { 'person.yml': PERSON_YML, 'project.yml': PROJECT_YML },
    })
    try {
      const map = await buildDataSchemaMap(['@agency/project'], { srcDir: fx.fnd })
      // project resolved via alias; its ref:'@agency/person' pulled in via the same alias.
      expect(Object.keys(map).sort()).toEqual(['@agency/person', '@agency/project'])
    } finally {
      fx.cleanup()
    }
  })

  it('resolves an absolute alias path as-is', async () => {
    const fx = makeFixture("export default {}", { extFiles: { 'person.yml': PERSON_YML } })
    try {
      // Rewrite the config to an absolute path to the ext dir.
      writeFileSync(join(fx.fnd, 'schemas.config.js'), `export default { '@agency': ${JSON.stringify(fx.ext)} }`)
      const map = await buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })
      expect(map['@agency/person']).toBeTruthy()
    } finally {
      fx.cleanup()
    }
  })

  it('skips a scope whose value is null/undefined (e.g. unset env var)', async () => {
    // '@agency' aliased, '@brand' left undefined → @brand falls back to the
    // package convention and errors (no @brand/schemas installed here).
    const fx = makeFixture("export default { '@agency': '../ext-schemas', '@brand': process.env.DEFINITELY_UNSET }", {
      extFiles: { 'person.yml': PERSON_YML },
    })
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).resolves.toBeTruthy()
      await expect(buildDataSchemaMap(['@brand/badge'], { srcDir: fx.fnd })).rejects.toThrow(/@brand\/schemas.*not installed/)
    } finally {
      fx.cleanup()
    }
  })

  it('errors clearly when an aliased schema file is missing', async () => {
    const fx = makeFixture("export default { '@agency': '../ext-schemas' }", { extFiles: {} })
    try {
      await expect(buildDataSchemaMap(['@agency/ghost'], { srcDir: fx.fnd })).rejects.toThrow(/not found in the directory.*schemas\.config\.js/)
    } finally {
      fx.cleanup()
    }
  })

  it('rejects a malformed config (non-object export)', async () => {
    const fx = makeFixture("export default 'nope'", { extFiles: { 'person.yml': PERSON_YML } })
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(/must default-export a map/)
    } finally {
      fx.cleanup()
    }
  })

  it('rejects an invalid alias key', async () => {
    const fx = makeFixture("export default { 'agency': '../ext-schemas' }", { extFiles: { 'person.yml': PERSON_YML } })
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(/must be a scope like '@agency'/)
    } finally {
      fx.cleanup()
    }
  })

  it('does nothing when no schemas.config.js is present (package convention only)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uniweb-alias-'))
    const fnd = join(root, 'foundation')
    mkdirSync(fnd, { recursive: true })
    writeFileSync(join(fnd, 'package.json'), JSON.stringify({ name: 'fnd', type: 'module' }))
    try {
      // @org/x with no alias and no package → the usual "not installed" error.
      await expect(buildDataSchemaMap(['@org/x'], { srcDir: fnd })).rejects.toThrow(/@org\/schemas.*not installed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// A per-schema key ('@scope/name' → a FILE) overrides ONE schema, winning over
// the scope directory and the package. The explicit alternative to symlinking a
// file into a routed folder or forking a whole scope.
const OVERRIDE_PERSON = ['name: person', 'fields:', '  name: { type: string }', '  local_only: { type: bool }'].join('\n')

describe('schemas.config.js per-schema file aliases', () => {
  it('resolves a single schema to an exact file', async () => {
    const fx = makeFixture("export default { '@agency/person': './person-local.yml' }")
    try {
      writeFileSync(join(fx.fnd, 'person-local.yml'), OVERRIDE_PERSON)
      const map = await buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })
      expect(map['@agency/person'].fields.local_only).toEqual({ type: 'bool' })
    } finally {
      fx.cleanup()
    }
  })

  it('appends a known extension when the value omits one', async () => {
    const fx = makeFixture("export default { '@agency/person': './person-local' }")
    try {
      writeFileSync(join(fx.fnd, 'person-local.yml'), OVERRIDE_PERSON)
      const map = await buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })
      expect(map['@agency/person'].fields.local_only).toBeTruthy()
    } finally {
      fx.cleanup()
    }
  })

  it('a per-schema file wins over the scope directory for that one name', async () => {
    // '@agency' routes person+project to the shared folder; '@agency/person' swaps
    // in a local file. person comes from the override; project from the directory,
    // and project's ref:'@agency/person' resolves to the override too (same map).
    const fx = makeFixture(
      "export default { '@agency': '../ext-schemas', '@agency/person': './person-local.yml' }",
      { extFiles: { 'person.yml': PERSON_YML, 'project.yml': PROJECT_YML } }
    )
    try {
      writeFileSync(join(fx.fnd, 'person-local.yml'), OVERRIDE_PERSON)
      const map = await buildDataSchemaMap(['@agency/project'], { srcDir: fx.fnd })
      expect(Object.keys(map).sort()).toEqual(['@agency/person', '@agency/project'])
      // override person has local_only and does NOT have the directory's email field
      expect(map['@agency/person'].fields.local_only).toBeTruthy()
      expect(map['@agency/person'].fields.email).toBeUndefined()
    } finally {
      fx.cleanup()
    }
  })

  it('errors clearly when the aliased file is missing', async () => {
    const fx = makeFixture("export default { '@agency/person': './nope.yml' }")
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(
        /aliased to '.*nope\.yml'.*no schema file exists there/
      )
    } finally {
      fx.cleanup()
    }
  })

  it('errors when the aliased value is a directory, not a file', async () => {
    const fx = makeFixture("export default { '@agency/person': '../ext-schemas' }", {
      extFiles: { 'person.yml': PERSON_YML },
    })
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(/no schema file exists there/)
    } finally {
      fx.cleanup()
    }
  })

  it("rejects the reserved '@uniweb' scope as an alias key", async () => {
    const fx = makeFixture("export default { '@uniweb/person': './p.yml' }")
    try {
      await expect(buildDataSchemaMap(['@std/person'], { srcDir: fx.fnd })).rejects.toThrow(/'@uniweb' is reserved/)
    } finally {
      fx.cleanup()
    }
  })

  it("rejects '@/name' self keys and multi-segment names", async () => {
    const self = makeFixture("export default { '@/person': './p.yml' }")
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: self.fnd })).rejects.toThrow(/not '@\/…'/)
    } finally {
      self.cleanup()
    }
    const deep = makeFixture("export default { '@agency/a/b': './p.yml' }")
    try {
      await expect(buildDataSchemaMap(['@agency/x'], { srcDir: deep.fnd })).rejects.toThrow(/a single schema name/)
    } finally {
      deep.cleanup()
    }
  })
})

describe('routed-scope not-found diagnostic', () => {
  // When a routed scope is missing a schema AND the '@org/schemas' package is also
  // installed, the error explains that a routed scope never falls back to it.
  function withPackage(configBody) {
    const fx = makeFixture(configBody)
    const pkgDir = join(fx.fnd, 'node_modules', '@agency', 'schemas')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@agency/schemas', type: 'module', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const schemas = {}\n')
    return fx
  }

  it('notes that a routed scope does not fall back to an installed package', async () => {
    const fx = withPackage("export default { '@agency': '../ext-schemas' }")
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(
        /does not fall back to it/
      )
    } finally {
      fx.cleanup()
    }
  })

  it('omits the note when no package is installed', async () => {
    const fx = makeFixture("export default { '@agency': '../ext-schemas' }")
    try {
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.toThrow(/Expected one of/)
      await expect(buildDataSchemaMap(['@agency/person'], { srcDir: fx.fnd })).rejects.not.toThrow(/fall back/)
    } finally {
      fx.cleanup()
    }
  })
})
