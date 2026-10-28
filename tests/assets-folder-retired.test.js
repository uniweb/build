/**
 * `/x` names `public/x`, and only that (2026-10-28).
 *
 * `assets/` was a second home for a site-root reference, searched after `public/`. It is
 * retired: a site keeps media beside the page that shows it, or in `public/` for a fixed
 * address. A `/x` only `assets/` holds is refused by name — at a build, a dev collection
 * and a push alike, since all of them resolve through `resolveAssetPath` — rather than
 * read as a missing file.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAssetPath, ASSETS_FOLDER_RETIRED } from '../src/site/assets.js'
import { buildSiteData } from '../src/site/build-site-data.js'

describe('the retired assets/ folder', () => {
  let siteRoot, page

  beforeEach(() => {
    siteRoot = join(tmpdir(), `assets-retired-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    page = join(siteRoot, 'pages', 'home', '1-hero.md')
    for (const d of ['pages/home', 'public', 'assets']) mkdirSync(join(siteRoot, d), { recursive: true })
    writeFileSync(join(siteRoot, 'site.yml'), 'name: test-site\nfoundation: src\nindex: home\n')
  })

  afterEach(() => {
    rmSync(siteRoot, { recursive: true, force: true })
  })

  it('a /x that only assets/ holds is refused, naming the file and the two ways out', () => {
    writeFileSync(join(siteRoot, 'assets', 'explainer.mp4'), 'mp4')
    writeFileSync(page, '![Watch](/explainer.mp4){role=video}\n')
    let thrown
    try {
      resolveAssetPath('/explainer.mp4', page, siteRoot)
    } catch (err) {
      thrown = err
    }
    expect(thrown?.code).toBe(ASSETS_FOLDER_RETIRED)
    expect(thrown.message).toContain('/explainer.mp4 (in pages/home/1-hero.md) names assets/explainer.mp4')
    expect(thrown.message).toContain('./explainer.mp4')
    expect(thrown.message).toContain('public/')
  })

  it('a /x resolves to public/, which wins over a copy in assets/', () => {
    writeFileSync(join(siteRoot, 'public', 'hero.png'), 'png')
    writeFileSync(join(siteRoot, 'assets', 'hero.png'), 'png')
    expect(resolveAssetPath('/hero.png', page, siteRoot).resolved).toBe(join(siteRoot, 'public', 'hero.png'))
  })

  it('a /x that names no file is still public/\'s, unrefused', () => {
    expect(resolveAssetPath('/missing.png', page, siteRoot).resolved).toBe(join(siteRoot, 'public', 'missing.png'))
  })

  it('a relative path into a folder that happens to be named assets/ is untouched', () => {
    writeFileSync(join(siteRoot, 'assets', 'logo.svg'), 'svg')
    expect(resolveAssetPath('../../assets/logo.svg', page, siteRoot).resolved).toBe(join(siteRoot, 'assets', 'logo.svg'))
  })

  it('a build stops on one', async () => {
    writeFileSync(join(siteRoot, 'assets', 'explainer.mp4'), 'mp4')
    writeFileSync(page, '---\ntype: Hero\n---\n\n# Welcome\n\n![Watch](/explainer.mp4){role=video}\n')
    await expect(buildSiteData({ siteRoot, distDir: join(siteRoot, 'dist') })).rejects.toMatchObject({
      code: ASSETS_FOLDER_RETIRED,
    })
  })
})
