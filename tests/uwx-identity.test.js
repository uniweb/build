import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sidecarResolver, sidecarLookup } from '../src/uwx/index.js'

// The two id-sidecar resolvers, tested directly (decoupled from any mapper):
//   - sidecarResolver  : read-WRITE, MINTS on a new key, persists on flush().
//                        Used by the register lane (foundation-schema), where the
//                        producer owns identity.
//   - sidecarLookup    : read-ONLY, never mints, never writes. Used by the
//                        site-content SYNC lane, where the BACKEND mints and the
//                        verb records the returned $uuid into the sidecar.

let ROOT
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-id-'))
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('uwx/identity sidecarResolver (mint + persist + reuse)', () => {
  it('mints on a new key, reuses across resolvers, and persists on flush', () => {
    const path = join(ROOT, '.uniweb', 'uwx-ids.json')

    const r1 = sidecarResolver(path)
    const ent = r1.entity('site-content')
    const home = r1.item('page:id:home')
    const hero = r1.item('page:id:home::sec:hero')
    // Same key → same uuid within a run (idempotent lookup).
    expect(r1.item('page:id:home')).toBe(home)
    expect(ent).toMatch(/^[0-9a-f-]{36}$/)
    r1.flush()
    expect(existsSync(path)).toBe(true)

    // A fresh resolver over the same file reuses the stored uuids (no re-mint).
    const r2 = sidecarResolver(path)
    expect(r2.entity('site-content')).toBe(ent)
    expect(r2.item('page:id:home')).toBe(home)
    expect(r2.item('page:id:home::sec:hero')).toBe(hero)
  })

  it('flush is a no-op when nothing changed (byte-stable file)', () => {
    const path = join(ROOT, '.uniweb', 'uwx-ids.json')
    const r1 = sidecarResolver(path)
    r1.item('a')
    r1.flush()
    const bytes = readFileSync(path, 'utf8')

    // Re-open, look up the SAME key (no new mint), flush → file unchanged.
    const r2 = sidecarResolver(path)
    r2.item('a')
    r2.flush()
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })

  it('writes the store key-sorted for clean diffs', () => {
    const path = join(ROOT, '.uniweb', 'uwx-ids.json')
    const r = sidecarResolver(path)
    r.item('z')
    r.item('a')
    r.item('m')
    r.flush()
    const keys = Object.keys(JSON.parse(readFileSync(path, 'utf8')).items)
    expect(keys).toEqual([...keys].sort())
  })
})

describe('uwx/identity sidecarLookup (read-only)', () => {
  it('returns stored uuids and never mints or writes', () => {
    const path = join(ROOT, 'ids.json')
    writeFileSync(
      path,
      JSON.stringify({
        entities: { 'site-content': 'ENT-UUID' },
        items: { 'page:id:home': 'HOME-UUID' },
      })
    )
    const lk = sidecarLookup(path)
    expect(lk.entity('site-content')).toBe('ENT-UUID')
    expect(lk.item('page:id:home')).toBe('HOME-UUID')
    // Unknown key → undefined (no mint), and the file is untouched.
    const before = readFileSync(path, 'utf8')
    expect(lk.item('page:id:missing')).toBeUndefined()
    expect(lk.entity('nope')).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('treats a missing file as empty (every lookup undefined)', () => {
    const lk = sidecarLookup(join(ROOT, 'does-not-exist.json'))
    expect(lk.entity('x')).toBeUndefined()
    expect(lk.item('y')).toBeUndefined()
  })
})
