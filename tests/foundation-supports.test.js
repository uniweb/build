/**
 * `uniweb.supports` — a foundation's statement of which host services it is
 * BUILT AGAINST, from `package.json` to the registry wire.
 *
 * ## What is being pinned, and why each half needs a test
 *
 * The chain is `package.json::uniweb.supports` → `loadPackageJson` →
 * `schema.json::_self.supports` → `info.supports` on the register document,
 * stripped from the opaque schema blob on the way. Every arrow is a place the
 * key can be dropped with no error: the blob is shipped whole and uninspected,
 * so a key that fails to hoist simply travels somewhere nobody reads, and a key
 * that fails to strip travels twice and drifts.
 *
 * ## ⭐ THE THREE STATES ARE THE CONTRACT
 *
 * Absent, `[]` and `['search']` are three different answers — UNKNOWN, an
 * explicit NONE, and a set. Most of these tests exist to stop the first two
 * collapsing into each other, because every natural JavaScript idiom for
 * carrying this value (`if (x)`, `x || []`, `setIf`) collapses them, and the
 * collapse is invisible: an empty array and a missing key serialize to payloads
 * that both "look fine".
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPackageJson, buildSchema } from '../src/schema.js'
import { buildRegistryPackage } from '../src/uwx/registry-package.js'
import { foundationSchemaToEntity } from '../src/uwx/foundation-schema.js'

let dirs = []

function foundationDir(pkg) {
  const dir = mkdtempSync(join(tmpdir(), 'uw-supports-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'acme-foundation', version: '1.0.0', ...pkg }, null, 2)
  )
  mkdirSync(join(dir, 'sections'), { recursive: true })
  return dir
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('loadPackageJson — the three states', () => {
  it('omits the key entirely when nothing is declared (UNKNOWN)', async () => {
    const out = await loadPackageJson(foundationDir({}))
    expect('supports' in out).toBe(false)
  })

  it('keeps an empty array as an explicit NONE', async () => {
    const out = await loadPackageJson(foundationDir({ uniweb: { supports: [] } }))
    expect(out.supports).toEqual([])
  })

  it('carries declared names', async () => {
    const out = await loadPackageJson(
      foundationDir({ uniweb: { supports: ['search', 'submit'] } })
    )
    expect(out.supports).toEqual(['search', 'submit'])
  })

  it('sorts and de-duplicates so a re-export is byte-identical', async () => {
    const out = await loadPackageJson(
      foundationDir({ uniweb: { supports: ['submit', 'search', 'submit'] } })
    )
    expect(out.supports).toEqual(['search', 'submit'])
  })

  it('coexists with uniweb.id and uniweb.scope in the same block', async () => {
    const out = await loadPackageJson(
      foundationDir({ uniweb: { id: 'docs', scope: '@acme', supports: ['search'] } })
    )
    expect(out.name).toBe('docs')
    expect(out.supports).toEqual(['search'])
  })
})

describe('loadPackageJson — a malformed declaration reads as UNKNOWN, never as NONE', () => {
  it('ignores a non-array and leaves the key absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await loadPackageJson(foundationDir({ uniweb: { supports: 'search' } }))
    // ⛔ NOT `[]`. Dropping a malformed declaration to an explicit "none" would
    // turn a typo into a statement that this foundation honours nothing.
    expect('supports' in out).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops non-name entries but keeps the valid ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await loadPackageJson(
      foundationDir({ uniweb: { supports: ['search', '', null, 42, '  submit  '] } })
    )
    expect(out.supports).toEqual(['search', 'submit'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('buildSchema — the declaration reaches _self', () => {
  it('puts supports on _self when declared', async () => {
    const schema = await buildSchema(foundationDir({ uniweb: { supports: ['api'] } }))
    expect(schema._self.supports).toEqual(['api'])
  })

  it('leaves _self without the key when undeclared', async () => {
    const schema = await buildSchema(foundationDir({}))
    expect('supports' in schema._self).toBe(false)
  })
})

// ── the register wire ────────────────────────────────────────────────────────

function schemaJson(supports) {
  const self = { name: '@acme/marketing', version: '1.2.0', role: 'foundation', vars: {} }
  if (supports !== undefined) self.supports = supports
  return { _self: self, Hero: { name: 'Hero', path: 'sections/Hero' } }
}

describe('buildRegistryPackage — hoisted to info, stripped from the blob', () => {
  const foundation = (doc) => doc.entities.find((e) => e.model === '@uniweb/foundation-schema')

  it('hoists a declared set onto info', () => {
    const f = foundation(buildRegistryPackage({ schema: schemaJson(['search', 'submit']) }))
    expect(f.info.supports).toEqual(['search', 'submit'])
  })

  it('hoists an explicit NONE — [] is a statement, not an absence', () => {
    const f = foundation(buildRegistryPackage({ schema: schemaJson([]) }))
    expect(f.info.supports).toEqual([])
  })

  it('omits info.supports entirely when undeclared', () => {
    const f = foundation(buildRegistryPackage({ schema: schemaJson(undefined) }))
    expect('supports' in f.info).toBe(false)
  })

  it('strips it from the opaque schema blob, so the wire carries it once', () => {
    const f = foundation(buildRegistryPackage({ schema: schemaJson(['search']) }))
    expect(f.schema._self.supports).toBeUndefined()
    // the rest of _self still rides in the blob — this strips one key, not the object
    expect(f.schema._self.vars).toEqual({})
  })
})

describe('foundationSchemaToEntity — the other emitter agrees', () => {
  // Two emitters produce this entity. They drifting apart is exactly the class
  // of bug that makes a foundation's declaration depend on which code path
  // published it.
  const sectionData = (entity, name) => entity.items.find((i) => i.section === name).data

  it('hoists and strips identically to buildRegistryPackage', () => {
    const entity = foundationSchemaToEntity(schemaJson(['tracking']))
    expect(sectionData(entity, 'info').supports).toEqual(['tracking'])
    expect(sectionData(entity, 'schema').schema._self.supports).toBeUndefined()
  })

  it('omits the key when undeclared', () => {
    const entity = foundationSchemaToEntity(schemaJson(undefined))
    expect('supports' in sectionData(entity, 'info')).toBe(false)
  })
})
