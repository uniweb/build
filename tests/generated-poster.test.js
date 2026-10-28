/**
 * A poster the build makes for a video reaches the video (2026-10-28).
 *
 * The build makes a poster frame for each local video its author gave none
 * (`processAdvancedAssets`), keyed by the reference as written. Until 2026-10-28 it
 * went to a top-level `_assetMeta.posters` that nothing read — keyed by a reference
 * the node no longer held, since the rewrite had moved it to the hashed copy — so no
 * page showed it. It goes on the node now, where an authored `{poster=…}` is.
 */

import { parseContent } from '@uniweb/semantic-parser'
import { rewriteContentPaths, rewriteSiteContentPaths } from '../src/site/asset-processor.js'

const pathMapping = { '/clip.mp4': '/assets/clip-2b14d41e.mp4', './cover.jpg': '/assets/cover-11aa22bb.webp' }
const made = { posters: { '/clip.mp4': '/assets/clip-poster-2b14d41e.webp' } }
const videoDoc = (attrs) => ({ type: 'doc', content: [{ type: 'image', attrs: { alt: 'Clip', role: 'video', ...attrs } }] })

describe('a generated poster', () => {
  it('arrives in content.videos[i].poster', () => {
    const built = rewriteContentPaths(videoDoc({ src: '/clip.mp4' }), pathMapping, null, made)
    const [video] = parseContent(built).videos
    expect(video.src).toBe('/assets/clip-2b14d41e.mp4')
    expect(video.poster).toBe('/assets/clip-poster-2b14d41e.webp')
  })

  it('never replaces the poster an author set', () => {
    const built = rewriteContentPaths(videoDoc({ src: '/clip.mp4', poster: './cover.jpg' }), pathMapping, null, made)
    expect(parseContent(built).videos[0].poster).toBe('/assets/cover-11aa22bb.webp')
  })

  it('reaches every page and layout area through the site rewrite', () => {
    const site = {
      pages: [{ sections: [{ content: videoDoc({ src: '/clip.mp4' }) }] }],
      layouts: { default: { header: { sections: [{ content: videoDoc({ src: '/clip.mp4' }) }] } } },
    }
    const built = rewriteSiteContentPaths(site, pathMapping, null, made)
    for (const section of [built.pages[0].sections[0], built.layouts.default.header.sections[0]]) {
      expect(section.content.content[0].attrs.poster).toBe('/assets/clip-poster-2b14d41e.webp')
    }
  })

  it('CONTROL — without what the build made, the video has no poster', () => {
    const built = rewriteContentPaths(videoDoc({ src: '/clip.mp4' }), pathMapping)
    expect(parseContent(built).videos[0].poster).toBeFalsy()
  })
})
