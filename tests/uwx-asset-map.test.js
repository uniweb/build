/**
 * `assets.json` — the committed local-ref → asset-id map, and the path
 * restoration it exists for.
 *
 * The properties under test are the ones that make a COMMITTED file safe to
 * keep: it merges rather than replaces (a push carries only the refs its
 * content touched), it sorts (an unstable file diffs on every push and trains
 * people to stop reading it), and it does not rewrite an identical file (a push
 * that moved no assets must leave `git status` clean).
 *
 * Plus the half the whole thing is for: a push/pull cycle must be a fixed point
 * on the paths a developer wrote.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readAssetMap,
  updateAssetMap,
  refForAssetId,
  restoreAssetRefs,
  ASSET_MAP_FILE
} from '../src/uwx/asset-map.js'

let DIR
beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), 'uw-assetmap-')) })
afterEach(() => { if (DIR) rmSync(DIR, { recursive: true, force: true }) })

const raw = () => readFileSync(join(DIR, ASSET_MAP_FILE), 'utf8')

describe('reading', () => {
  it('a missing map reads as empty rather than throwing', () => {
    expect(readAssetMap(DIR)).toEqual({})
  })

  it('a corrupt map reads as empty — it must never be why a push fails', () => {
    writeFileSync(join(DIR, ASSET_MAP_FILE), '{ this is not json')
    expect(readAssetMap(DIR)).toEqual({})
    // …and the next write repairs it rather than compounding the damage.
    updateAssetMap(DIR, { '/images/a.png': { id: 'A', ext: 'png' } })
    expect(readAssetMap(DIR)).toEqual({ '/images/a.png': { id: 'A', ext: 'png' } })
  })
})

describe('writing — the properties a committed file needs', () => {
  it('writes sorted keys and a trailing newline', () => {
    updateAssetMap(DIR, {
      '/images/z.png': { id: 'Z', ext: 'png' },
      '/images/a.png': { id: 'A', ext: 'png' },
      '/images/m.png': { id: 'M', ext: 'png' }
    })
    const text = raw()
    const order = [...text.matchAll(/"(\/images\/[^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['/images/a.png', '/images/m.png', '/images/z.png'])
    expect(text.endsWith('\n')).toBe(true)
  })

  it('MERGES rather than replaces — a partial push must not drop untouched refs', () => {
    updateAssetMap(DIR, { '/images/a.png': { id: 'A', ext: 'png' } })
    updateAssetMap(DIR, { '/images/b.png': { id: 'B', ext: 'png' } })
    expect(readAssetMap(DIR)).toEqual({
      '/images/a.png': { id: 'A', ext: 'png' },
      '/images/b.png': { id: 'B', ext: 'png' }
    })
  })

  it('⭐ an unchanged push does not rewrite the file — git status stays clean', () => {
    const entries = { '/images/a.png': { id: 'A', ext: 'png' } }
    const first = updateAssetMap(DIR, entries)
    expect(first.written).toBe(true)
    expect(first.added).toEqual(['/images/a.png'])

    const before = raw()
    const second = updateAssetMap(DIR, entries)
    expect(second.written).toBe(false)
    expect(second.added).toEqual([])
    expect(second.changed).toEqual([])
    expect(raw()).toBe(before)
  })

  it('re-pointing a ref is reported as changed, not added', () => {
    updateAssetMap(DIR, { '/images/a.png': { id: 'A', ext: 'png' } })
    const r = updateAssetMap(DIR, { '/images/a.png': { id: 'A2', ext: 'png' } })
    expect(r.changed).toEqual(['/images/a.png'])
    expect(r.added).toEqual([])
    expect(readAssetMap(DIR)['/images/a.png'].id).toBe('A2')
  })

  it('entries with no id are ignored rather than written as junk', () => {
    const r = updateAssetMap(DIR, { '/images/a.png': { ext: 'png' } })
    expect(r.written).toBe(false)
    expect(existsSync(join(DIR, ASSET_MAP_FILE))).toBe(false)
  })
})

describe('refForAssetId', () => {
  const map = {
    '/images/hero.png': { id: '9f2c', ext: 'png' },
    '/images/other.png': { id: 'abcd', ext: 'png' }
  }
  it('is the direction pull needs — id back to the AUTHORED path', () => {
    expect(refForAssetId(map, '9f2c')).toBe('/images/hero.png')
  })
  it('returns null for an unknown or empty id', () => {
    expect(refForAssetId(map, 'nope')).toBe(null)
    expect(refForAssetId(map, '')).toBe(null)
  })
})

describe('restoreAssetRefs — the reason the map is committed', () => {
  const MAP = { '/images/hero.png': { id: '9f2c', ext: 'png' } }
  const SERVE = '/gateway/asset/dist/9f2c/base.png'

  it('⭐ puts the AUTHOR\'S path back where the serve URL is', () => {
    const doc = { pages: [{ content: { type: 'doc', content: [
      { type: 'image', attrs: { src: SERVE, assetId: '9f2c', assetExt: 'png', alt: 'Hero' } }
    ] } }] }
    const stats = restoreAssetRefs(doc, MAP)
    expect(stats).toEqual({ restored: 1, unknown: 0 })
    expect(doc.pages[0].content.content[0].attrs.src).toBe('/images/hero.png')
  })

  it('restores a section background too — same walk, both shapes', () => {
    const doc = { pages: [{ params: { background: {
      mode: 'image', image: { src: SERVE, assetId: '9f2c', assetExt: 'png' }
    } } }] }
    expect(restoreAssetRefs(doc, MAP).restored).toBe(1)
    expect(doc.pages[0].params.background.image.src).toBe('/images/hero.png')
  })

  it('⛔ leaves an UNKNOWN id alone — the URL that works beats a path that is not there', () => {
    // An asset this project has never held: authored in the app, or pushed from
    // another machine whose map entry has not arrived. Inventing a local path
    // would point at a file that does not exist. Filling it in is the download's
    // job, not this one.
    const doc = { a: { src: 'https://cdn/x.png', assetId: 'UNSEEN' } }
    const stats = restoreAssetRefs(doc, MAP)
    expect(stats).toEqual({ restored: 0, unknown: 1 })
    expect(doc.a.src).toBe('https://cdn/x.png')
  })

  it('is a no-op with an empty map', () => {
    const doc = { a: { src: SERVE, assetId: '9f2c' } }
    expect(restoreAssetRefs(doc, {})).toEqual({ restored: 0, unknown: 0 })
    expect(doc.a.src).toBe(SERVE)
  })

  it('⭐ push→pull is a FIXED POINT on the authored path', () => {
    // The whole charter clause, in one assertion: what the developer wrote comes
    // back as what the developer wrote.
    const authored = '/images/hero.png'
    // push: local ref → serve URL, identity stamped beside it
    const pushed = { attrs: { src: SERVE, assetId: '9f2c', assetExt: 'png' } }
    // pull: identity → the authored path
    restoreAssetRefs(pushed, MAP)
    expect(pushed.attrs.src).toBe(authored)
  })
})

describe('a poster round-trips like any other asset', () => {
  const POSTER_ID = 'b'.repeat(64)
  const MAP2 = {
    '/images/hero.png': { id: '9f2c', ext: 'png' },
    '/video/clip.mp4': { id: 'aaaa', ext: 'mp4' },
    '/images/poster.png': { id: POSTER_ID, ext: 'png' }
  }

  it('⭐ restores src AND poster to their authored paths', () => {
    const node = {
      src: '/gateway/asset/dist/aaaa/base.mp4',
      assetId: 'aaaa',
      assetExt: 'mp4',
      poster: `/gateway/asset/dist/${POSTER_ID}/base.png`,
      posterAssetId: POSTER_ID,
      posterAssetExt: 'png'
    }
    const stats = restoreAssetRefs(node, MAP2)
    expect(stats).toEqual({ restored: 2, unknown: 0 })
    expect(node.src).toBe('/video/clip.mp4')
    expect(node.poster).toBe('/images/poster.png')
  })

  it('restores a document preview', () => {
    const node = { preview: '/served/x.png', previewAssetId: '9f2c', previewAssetExt: 'png' }
    expect(restoreAssetRefs(node, MAP2).restored).toBe(1)
    expect(node.preview).toBe('/images/hero.png')
  })

  it('an unknown poster id leaves the poster URL alone', () => {
    const node = { poster: 'https://cdn/p.png', posterAssetId: 'UNSEEN' }
    expect(restoreAssetRefs(node, MAP2)).toEqual({ restored: 0, unknown: 1 })
    expect(node.poster).toBe('https://cdn/p.png')
  })
})
