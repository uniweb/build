/**
 * Page assets: one manifest key per FILE, and every asset attribute rewritten.
 *
 * ⛔ Two defects, both measured 2026-09-29 on a docs tree:
 *
 * 1. The manifest was keyed by the reference AS WRITTEN, site-wide. A co-located
 *    ref names a different file in every folder, so two pages that both wrote
 *    `./media/shot.png` shared one entry — the last collected won, and BOTH pages
 *    rendered its image.
 * 2. `rewriteContentPaths` rewrote only `src`. An explicit `poster=` (and a
 *    document's `preview=`) was collected and emitted to dist/assets/, while the
 *    page kept pointing at its source path — a 404.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'
import { rewriteContentPaths } from '../src/site/asset-processor.js'

const images = (page) => {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'image') out.push(n.attrs)
    ;(n.content || []).forEach(walk)
  }
  page.sections.forEach((s) => walk(s.content))
  return out
}

describe('co-located asset keys', () => {
  let siteDir

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  async function makeSite(sections, extraSiteYml = '') {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-assets-'))
    await writeFile(join(siteDir, 'site.yml'), `name: T\n${extraSiteYml}`)
    for (const [name, markdown] of Object.entries(sections)) {
      await mkdir(join(siteDir, 'pages', name, '_media'), { recursive: true })
      await writeFile(join(siteDir, 'pages', name, '_media', 'shot.png'), name)
      await writeFile(join(siteDir, 'pages', name, '_media', 'poster.png'), name)
      await writeFile(join(siteDir, 'pages', name, '_media', 'clip.mp4'), name)
      await writeFile(join(siteDir, 'pages', name, 'index.md'), markdown)
    }
    return siteDir
  }

  it('gives one ref written in two folders one key per file', async () => {
    const md = '# P\n\n![a](./_media/shot.png)\n'
    const dir = await makeSite({ alpha: md, beta: md })

    const content = await collectSiteContent(dir)

    const byRoute = Object.fromEntries(content.pages.map((p) => [p.route, images(p)[0].src]))
    expect(byRoute['/']).toBe('./pages/alpha/_media/shot.png')
    expect(byRoute['/beta']).toBe('./pages/beta/_media/shot.png')
    expect(content.assets['./pages/alpha/_media/shot.png'].resolved).toBe(join(dir, 'pages/alpha/_media/shot.png'))
    expect(content.assets['./pages/beta/_media/shot.png'].resolved).toBe(join(dir, 'pages/beta/_media/shot.png'))
    // The shared key names nothing written any more.
    expect(content.assets['./_media/shot.png']).toBeUndefined()
  })

  it('renames a colliding poster and keeps the explicit-poster mark on the renamed video', async () => {
    const md = '# P\n\n![v](./_media/clip.mp4){role=video poster=./_media/poster.png}\n'
    const dir = await makeSite({ alpha: md, beta: md })

    const content = await collectSiteContent(dir)

    const beta = images(content.pages.find((p) => p.route === '/beta'))[0]
    expect(beta.src).toBe('./pages/beta/_media/clip.mp4')
    expect(beta.poster).toBe('./pages/beta/_media/poster.png')
    expect(content.hasExplicitPoster.has('./pages/beta/_media/clip.mp4')).toBe(true)
    expect(content.hasExplicitPoster.has('./_media/clip.mp4')).toBe(false)
  })

  it('leaves a ref that names one file exactly as written', async () => {
    const dir = await makeSite({
      alpha: '# A\n\n![a](./_media/shot.png)\n',
      beta: '# B\n\n![b](./_media/poster.png)\n',
    })

    const content = await collectSiteContent(dir)

    expect(images(content.pages.find((p) => p.route === '/'))[0].src).toBe('./_media/shot.png')
    expect(images(content.pages.find((p) => p.route === '/beta'))[0].src).toBe('./_media/poster.png')
    expect(Object.keys(content.assets).sort()).toEqual(['./_media/poster.png', './_media/shot.png'])
  })
})

describe('rewriteContentPaths — every asset attribute', () => {
  it('rewrites a video poster and a document preview, not only src', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: './clip.mp4', role: 'video', poster: './poster.png' } },
        { type: 'image', attrs: { src: './spec.pdf', role: 'pdf', preview: './cover.png' } },
      ],
    }
    const mapping = {
      './clip.mp4': '/assets/clip-1.mp4',
      './poster.png': '/assets/poster-2.webp',
      './spec.pdf': '/assets/spec-3.pdf',
      './cover.png': '/assets/cover-4.webp',
    }

    const [video, pdf] = rewriteContentPaths(doc, mapping).content

    expect(video.attrs).toMatchObject({ src: '/assets/clip-1.mp4', poster: '/assets/poster-2.webp' })
    expect(pdf.attrs).toMatchObject({ src: '/assets/spec-3.pdf', preview: '/assets/cover-4.webp' })
  })

  it('leaves an attribute the mapping does not cover as written', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: './a.mp4', poster: 'https://x/p.jpg' } }] }

    const [video] = rewriteContentPaths(doc, { './a.mp4': '/assets/a.mp4' }).content

    expect(video.attrs.poster).toBe('https://x/p.jpg')
  })
})
