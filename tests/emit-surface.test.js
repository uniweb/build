import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const SURFACE = join(PKG, 'src/uwx/emit-surface.json')

/**
 * `src/uwx/emit-surface.json` states which site.yml keys this package emits
 * into which Section. A consumer that stores the document must declare every
 * key we can emit — a key in an undeclared Section is refused WHOLE — so the
 * file is published and a consumer depends on it.
 *
 * ⛔ The failure mode is SILENT INCOMPLETENESS, not a crash: a generator that
 * stops seeing an emit writes a shorter file, and a short list reads exactly
 * like a correct one. That is how the fixture-derived `wire.json` reached 6 of
 * 19 `settings` keys without anything going red.
 *
 * These are the drift half. The coverage half — that this file is a SUPERSET
 * of a real document's keys — is `_contracts/emit-surface-covers-the-wire.test.js`,
 * because it needs a fixture from outside this package.
 */
describe('emit-surface.json cannot drift from the producer', () => {
  it('is exactly what the generator produces right now', () => {
    // Exits 1 and prints the remedy when the checked-in file is stale.
    execFileSync('node', [join(PKG, 'scripts/gen-emit-surface.mjs'), '--check'], {
      cwd: PKG,
      stdio: 'pipe'
    })
  })

  const surface = JSON.parse(readFileSync(SURFACE, 'utf8'))

  it('declares a kind for every Section, and only known kinds', () => {
    const kinds = new Set(Object.keys(surface.kinds))
    expect(kinds).toEqual(new Set(['closed', 'passthrough', 'records']))
    for (const [name, section] of Object.entries(surface.sections)) {
      expect(kinds.has(section.kind), `${name} has an unknown kind`).toBe(true)
    }
  })

  it('gives every closed Section a non-empty key set', () => {
    // A closed Section with no keys is the silent-truncation shape: it says
    // "this Section carries nothing", which a consumer would believe.
    const closed = Object.entries(surface.sections).filter(
      ([, s]) => s.kind === 'closed'
    )
    expect(closed.length).toBeGreaterThan(0)
    for (const [name, s] of closed) {
      expect(Object.keys(s.keys).length, `${name} is closed but empty`).toBeGreaterThan(0)
    }
  })

  it('⛔ never declares keys for a passthrough Section', () => {
    // `services` / `secrets` copy author keys verbatim. Publishing a key list
    // for one would invite a consumer to assert a closed set we cannot honour.
    for (const [name, s] of Object.entries(surface.sections)) {
      if (s.kind !== 'passthrough') continue
      expect(s.keys, `${name} is passthrough and must publish no key list`).toBeUndefined()
    }
  })

  it('keeps the two Sections a consumer ratchets against', () => {
    // Not a value assertion — a rename here is a breaking change for a stored
    // document, so it should fail loudly rather than regenerate quietly.
    expect(surface.sections.info?.kind).toBe('closed')
    expect(surface.sections.settings?.kind).toBe('closed')
  })
})
