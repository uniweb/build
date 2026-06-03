import { collectSectionAssets, isMediaFieldReference } from '../src/site/assets.js'

/**
 * `background` (and other media frontmatter fields) are dual-use: an image/video
 * path OR a CSS value (color, gradient, palette token). The build must only
 * resolve the former as a file — mirroring the runtime's
 * `Block.normalizeBackground`. Regression guard: `background: gray` used to be
 * resolved as `<page-dir>/gray`, producing a spurious "Source not found".
 */
describe('media field asset references', () => {
  const siteRoot = '/fake/site'
  const markdownPath = '/fake/site/pages/research/4-methods.md'

  describe('isMediaFieldReference', () => {
    it('rejects CSS colors, gradients, and palette tokens', () => {
      for (const v of ['gray', 'white', '#ffffff', 'rgb(0,0,0)', 'oklch(0.7 0.1 200)', 'primary-900', 'linear-gradient(to right, red, blue)', 'transparent']) {
        expect(isMediaFieldReference(v)).toBe(false)
      }
    })

    it('accepts path-like values and bare media filenames', () => {
      for (const v of ['./hero.jpg', '../media/clip.mp4', '/images/x.webp', 'hero.png', 'poster.jpeg', '/docs/spec.pdf']) {
        expect(isMediaFieldReference(v)).toBe(true)
      }
    })

    it('rejects external URLs (loaded at runtime, not processed here) and non-strings', () => {
      expect(isMediaFieldReference('https://cdn.example.com/a.jpg')).toBe(false)
      expect(isMediaFieldReference('data:image/png;base64,AAAA')).toBe(false)
      expect(isMediaFieldReference(undefined)).toBe(false)
      expect(isMediaFieldReference('')).toBe(false)
      expect(isMediaFieldReference({ color: 'gray' })).toBe(false)
    })
  })

  describe('collectSectionAssets', () => {
    it('does NOT collect a CSS-color background (the regression)', () => {
      for (const background of ['gray', 'white', 'linear-gradient(to right, red, blue)', 'primary-900']) {
        const { assets } = collectSectionAssets({ params: { background } }, markdownPath, siteRoot)
        expect(Object.keys(assets)).toHaveLength(0)
      }
    })

    it('still collects a real image background (relative and site-absolute)', () => {
      const rel = collectSectionAssets({ params: { background: './hero.jpg' } }, markdownPath, siteRoot).assets
      expect(rel['./hero.jpg']).toBeDefined()
      expect(rel['./hero.jpg'].resolved).toBe('/fake/site/pages/research/hero.jpg')
      expect(rel['./hero.jpg'].isImage).toBe(true)

      const abs = collectSectionAssets({ params: { background: '/images/banner.png' } }, markdownPath, siteRoot).assets
      expect(abs['/images/banner.png']).toBeDefined()
      expect(abs['/images/banner.png'].isImage).toBe(true)
    })

    it('collects a bare relative image filename (no ./ prefix)', () => {
      const { assets } = collectSectionAssets({ params: { image: 'photo.webp' } }, markdownPath, siteRoot)
      expect(assets['photo.webp']).toBeDefined()
      expect(assets['photo.webp'].resolved).toBe('/fake/site/pages/research/photo.webp')
    })
  })
})
