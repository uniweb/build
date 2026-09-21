/**
 * `sync.json` — the store that replaces `site.yml`'s identity keys, `assets.json`
 * and three maps out of the sync cache.
 *
 * The cases that matter are not "it round-trips a value". They are the four rules
 * that make a COMMITTED derived file survivable:
 *
 *   - merge, never replace — a push carries only what it touched
 *   - sorted at every level — or every push produces a spurious diff
 *   - no-op writes do not touch the file — or `git status` lies
 *   - a corrupt file reads as empty — it must never be why a push fails
 *
 * Plus the one this whole design exists for: two backends in one project never
 * see each other's ids.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SYNC_STORE_FILE,
  normalizeOrigin,
  readSyncStore,
  readBackendState,
  listSyncedBackends,
  updateBackendState,
  updateBackendMap,
  clearBackend,
  forgetSyncStore,
  refForAssetId
} from '../src/uwx/sync-store.js'

const A = 'https://uniweb.app'
const B = 'http://localhost:8080'

let dir
const file = () => join(dir, SYNC_STORE_FILE)
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-sync-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('origins', () => {
  it('reduces a full URL to its origin, so one backend is one section', () => {
    expect(normalizeOrigin(`${B}/dev/site/abc`)).toBe(B)
    expect(normalizeOrigin(`${B}/`)).toBe(B)
    expect(normalizeOrigin(B)).toBe(B)
  })

  it('treats a scheme change as a different backend', () => {
    expect(normalizeOrigin('https://x.test')).not.toBe(normalizeOrigin('http://x.test'))
  })

  it('refuses garbage rather than inventing a key', () => {
    expect(normalizeOrigin('not a url')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin(null)).toBeNull()
    // no scheme: `new URL()` parses it as the scheme `localhost:`, origin "null"
    expect(normalizeOrigin('localhost:8080')).toBeNull()
    expect(updateBackendState(dir, 'not a url', { site: { uuid: 'x' } })).toBe(false)
  })
})

describe('two backends in one project', () => {
  it('⭐ never see each other — the reason the scope guard can go', () => {
    updateBackendState(dir, A, { site: { uuid: 'site-A' } })
    updateBackendState(dir, B, { site: { uuid: 'site-B' } })

    expect(readBackendState(dir, A).site.uuid).toBe('site-A')
    expect(readBackendState(dir, B).site.uuid).toBe('site-B')
    expect(listSyncedBackends(dir)).toEqual([A, B].sort())
  })

  it('an unknown backend reads as never-synced, not as someone else', () => {
    updateBackendState(dir, A, { site: { uuid: 'site-A' } })
    expect(readBackendState(dir, 'https://elsewhere.test')).toEqual({})
  })

  it('clearing one leaves the others intact', () => {
    updateBackendState(dir, A, { site: { uuid: 'site-A' } })
    updateBackendState(dir, B, { site: { uuid: 'site-B' } })

    expect(clearBackend(dir, B)).toBe(true)
    expect(readBackendState(dir, B)).toEqual({})
    expect(readBackendState(dir, A).site.uuid).toBe('site-A')
    expect(clearBackend(dir, 'https://never.test')).toBe(false)
  })

  it('⭐ clearing the LAST backend removes the file — an empty ledger is a trace', () => {
    updateBackendState(dir, A, { site: { uuid: 'site-A' } })
    updateBackendState(dir, B, { site: { uuid: 'site-B' } })

    expect(clearBackend(dir, A)).toBe(true)
    expect(existsSync(file()), 'one backend left: the file stays').toBe(true)
    expect(clearBackend(dir, B)).toBe(true)
    expect(existsSync(file()), 'none left: no file').toBe(false)
    expect(readBackendState(dir, B)).toEqual({})
  })
})

describe('forgetSyncStore — for a copy that becomes a new project', () => {
  it('deletes the file and reports every origin it held', () => {
    updateBackendState(dir, A, { site: { uuid: 'site-A' } })
    updateBackendState(dir, B, { site: { uuid: 'site-B' } })

    expect(forgetSyncStore(dir)).toEqual([A, B].sort())
    expect(existsSync(file())).toBe(false)
    expect(listSyncedBackends(dir)).toEqual([])
  })

  it('null when there is no file — nothing to forget is not an error', () => {
    expect(forgetSyncStore(dir)).toBeNull()
  })

  it('removes a file that does not parse — it is still the original\'s', () => {
    writeFileSync(file(), '{ not json')
    expect(forgetSyncStore(dir)).toEqual([])
    expect(existsSync(file())).toBe(false)
  })
})

describe('merge, never replace', () => {
  it('a partial push keeps entries it did not mention', () => {
    updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-a', 'b.md': 'uuid-b' })
    updateBackendMap(dir, A, 'records', { 'b.md': 'uuid-b2' })

    expect(readBackendState(dir, A).records).toEqual({
      'a.md': 'uuid-a',
      'b.md': 'uuid-b2'
    })
  })

  it('`site` merges too, so a later org does not erase the uuid', () => {
    updateBackendState(dir, A, { site: { uuid: 'u1' } })
    updateBackendState(dir, A, { site: { org: 'acme' } })
    expect(readBackendState(dir, A).site).toEqual({ uuid: 'u1', org: 'acme' })
  })

  it('a non-map section REPLACES — services is a whole projection', () => {
    updateBackendState(dir, A, { services: [{ name: 'search' }, { name: 'submit' }] })
    updateBackendState(dir, A, { services: [{ name: 'search' }] })
    expect(readBackendState(dir, A).services).toEqual([{ name: 'search' }])
  })

  it('one section does not disturb another', () => {
    updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-a' })
    updateBackendMap(dir, A, 'assets', { '/hero.png': { id: 'x', ext: 'png' } })
    const state = readBackendState(dir, A)
    expect(state.records).toEqual({ 'a.md': 'uuid-a' })
    expect(state.assets).toEqual({ '/hero.png': { id: 'x', ext: 'png' } })
  })

  it('a returned state cannot be mutated back into the file', () => {
    updateBackendState(dir, A, { site: { uuid: 'u1' } })
    const state = readBackendState(dir, A)
    state.site = { uuid: 'tampered' }
    expect(readBackendState(dir, A).site.uuid).toBe('u1')
  })
})

describe('the per-entry merge rule', () => {
  // Assets carry a `served` fingerprint that a push learning only an id must not
  // drop — the rule `assets.json` already applies, moved intact.
  const keepServed = (next, prior) => ({
    ...next,
    ...(next.served || prior?.id !== next.id ? {} : { served: prior.served })
  })

  it('carries a fingerprint forward when the bytes did not change', () => {
    updateBackendMap(dir, A, 'assets', {
      '/hero.png': { id: 'id1', ext: 'png', served: 'sha256:abc' }
    })
    updateBackendMap(dir, A, 'assets', { '/hero.png': { id: 'id1', ext: 'png' } }, keepServed)

    expect(readBackendState(dir, A).assets['/hero.png'].served).toBe('sha256:abc')
  })

  it('drops it when the bytes did change', () => {
    updateBackendMap(dir, A, 'assets', {
      '/hero.png': { id: 'id1', ext: 'png', served: 'sha256:abc' }
    })
    updateBackendMap(dir, A, 'assets', { '/hero.png': { id: 'id2', ext: 'png' } }, keepServed)

    expect(readBackendState(dir, A).assets['/hero.png'].served).toBeUndefined()
    expect(readBackendState(dir, A).assets['/hero.png'].id).toBe('id2')
  })

  it('a rule returning undefined leaves the stored entry alone', () => {
    updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-a' })
    updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-b' }, () => undefined)
    expect(readBackendState(dir, A).records['a.md']).toBe('uuid-a')
  })

  it('reports what it added and what it changed', () => {
    const first = updateBackendMap(dir, A, 'records', { 'a.md': 'u1' })
    expect(first).toMatchObject({ added: ['a.md'], changed: [], written: true })

    const second = updateBackendMap(dir, A, 'records', { 'a.md': 'u2', 'b.md': 'u3' })
    expect(second.added).toEqual(['b.md'])
    expect(second.changed).toEqual(['a.md'])
  })
})

describe('diff stability', () => {
  it('⭐ sorts every level, so a push never reorders the file', () => {
    updateBackendState(dir, B, { site: { uuid: 'b' } })
    updateBackendState(dir, A, { site: { uuid: 'a' } })
    updateBackendMap(dir, A, 'records', { 'z.md': 'z', 'a.md': 'a', 'm.md': 'm' })

    const raw = onDisk()
    expect(Object.keys(raw.backends)).toEqual([A, B].sort())
    expect(Object.keys(raw.backends[A].records)).toEqual(['a.md', 'm.md', 'z.md'])
  })

  it('⭐ an unchanged write does not touch the file', () => {
    updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-a' })
    const before = statSync(file()).mtimeMs
    const text = readFileSync(file(), 'utf8')

    const result = updateBackendMap(dir, A, 'records', { 'a.md': 'uuid-a' })

    expect(result.written).toBe(false)
    expect(result.added).toEqual([])
    expect(result.changed).toEqual([])
    expect(readFileSync(file(), 'utf8')).toBe(text)
    expect(statSync(file()).mtimeMs).toBe(before)
  })

  it('writing the same state through updateBackendState is also a no-op', () => {
    updateBackendState(dir, A, { site: { uuid: 'u1' } })
    const text = readFileSync(file(), 'utf8')
    expect(updateBackendState(dir, A, { site: { uuid: 'u1' } })).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(text)
  })

  it('ends with a newline, like every other committed file here', () => {
    updateBackendState(dir, A, { site: { uuid: 'u1' } })
    expect(readFileSync(file(), 'utf8').endsWith('}\n')).toBe(true)
  })
})

describe('a damaged file is never why a push fails', () => {
  it('missing reads as empty', () => {
    expect(readSyncStore(dir)).toEqual({ version: 1, backends: {} })
    expect(readBackendState(dir, A)).toEqual({})
    expect(listSyncedBackends(dir)).toEqual([])
  })

  it('unparseable reads as empty, and the next write repairs it', () => {
    writeFileSync(file(), '{ not json')
    expect(readBackendState(dir, A)).toEqual({})

    updateBackendState(dir, A, { site: { uuid: 'u1' } })
    expect(readBackendState(dir, A).site.uuid).toBe('u1')
  })

  it('a wrong-shaped `backends` reads as empty rather than throwing', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, backends: [1, 2, 3] }))
    expect(readBackendState(dir, A)).toEqual({})
  })

  it('a junk origin key is dropped on read, not carried', () => {
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, backends: { 'not a url': { site: { uuid: 'x' } }, [A]: { site: { uuid: 'ok' } } } })
    )
    expect(listSyncedBackends(dir)).toEqual([A])
  })
})

describe('refForAssetId', () => {
  it('finds the path an author wrote, for the right backend only', () => {
    updateBackendMap(dir, A, 'assets', { '/images/hero.png': { id: 'id-A', ext: 'png' } })
    updateBackendMap(dir, B, 'assets', { '/other.png': { id: 'id-B', ext: 'png' } })

    expect(refForAssetId(dir, A, 'id-A')).toBe('/images/hero.png')
    expect(refForAssetId(dir, A, 'id-B')).toBeNull()
    expect(refForAssetId(dir, A, '')).toBeNull()
  })
})
