/**
 * `uniweb dev` serves the file a build would ship for each media reference (2026-10-28).
 *
 * A build resolves each local reference and rewrites it to its copy; dev left it as
 * written, so only one into `public/` reached its file. A co-located `./photo.png` was
 * read against the page's URL and answered with the site's HTML. Dev now rewrites each
 * through the same manifest to where its dev server serves the file.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseContent } from '@uniweb/semantic-parser'
import { collectSectionAssets } from '../src/site/assets.js'
import { rewriteSiteContentPaths } from '../src/site/asset-processor.js'
import { devMediaPaths } from '../src/site/dev-media.js'

describe('dev media addresses', () => {
  let dir, siteRoot, home, publicDir, mounted

  beforeEach(() => {
    dir = join(tmpdir(), `dev-media-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    siteRoot = join(dir, 'site')
    home = join(siteRoot, 'pages', 'home')
    publicDir = join(siteRoot, 'public')
    mounted = join(dir, 'shared-docs')
    for (const d of [home, publicDir, mounted]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, 'photo #1.png'), 'png')
    writeFileSync(join(home, 'clip.mp4'), 'mp4')
    writeFileSync(join(publicDir, 'pub.png'), 'png')
    writeFileSync(join(mounted, 'diagram.svg'), 'svg')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // The manifest a collection makes, from a section in `markdownDir`.
  const manifestFor = (markdownDir, refs) => {
    const content = { type: 'doc', content: refs.map((src) => ({ type: 'image', attrs: { src } })) }
    return collectSectionAssets({ content }, join(markdownDir, '1-media.md'), siteRoot).assets
  }

  it('names each file where the dev server serves it', () => {
    const assets = manifestFor(home, ['./photo #1.png', './clip.mp4', '/pub.png', '/missing.png'])
    expect(devMediaPaths(assets, { root: siteRoot, publicDir })).toEqual({
      // Co-located: by its path from the root, encoded.
      './photo #1.png': '/pages/home/photo%20%231.png',
      './clip.mp4': '/pages/home/clip.mp4',
      // `/pub.png` is public/'s, served at the root already — and `/missing.png` names no file.
    })
  })

  it('puts the site base in front, as a build does', () => {
    const assets = manifestFor(home, ['./clip.mp4', '/pub.png'])
    expect(devMediaPaths(assets, { root: siteRoot, publicDir, base: '/docs/' })).toEqual({
      './clip.mp4': '/docs/pages/home/clip.mp4',
      '/pub.png': '/docs/pub.png',
    })
  })

  it('serves a file outside the root — a mounted folder\'s — through /@fs/', () => {
    const assets = manifestFor(mounted, ['./diagram.svg'])
    const address = devMediaPaths(assets, { root: siteRoot, publicDir })['./diagram.svg']
    expect(address).toMatch(/^\/@fs\/.*\/shared-docs\/diagram\.svg$/)
  })

  it('a component receives the dev address, and the manifest leaves the payload', () => {
    const content = { type: 'doc', content: [{ type: 'image', attrs: { src: './clip.mp4', role: 'video' } }] }
    const site = { pages: [{ sections: [{ content }] }], assets: manifestFor(home, ['./clip.mp4']) }
    const served = rewriteSiteContentPaths(site, devMediaPaths(site.assets, { root: siteRoot, publicDir }))
    expect(parseContent(served.pages[0].sections[0].content).videos[0].src).toBe('/pages/home/clip.mp4')
    expect(served.assets).toBeUndefined()
  })
})
