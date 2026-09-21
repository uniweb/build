/**
 * Asset reference restoration — the half of the old `assets.json` module that is
 * pure, and stayed.
 *
 * ⚠️ **The map's own tests moved to `uwx-sync-store.test.js`** on 2026-09-20, with
 * the map itself: reading, merging, sorting, no-op writes and `refForAssetId` are
 * now properties of `sync.json`, which holds one map PER BACKEND because an asset id
 * is minted by one and means nothing to another.
 *
 * What is left here is what the map exists FOR: a push/pull cycle must be a fixed
 * point on the paths a developer wrote.
 */

import { restoreAssetRefs } from '../src/uwx/asset-map.js'

describe('restoreAssetRefs — the reason the map is committed at all', () => {
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
