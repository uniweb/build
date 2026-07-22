/**
 * Processed media URLs must carry the deployment base path.
 *
 * Regression: under a subdirectory deployment (GitHub Pages project site,
 * `/docs/`, ...) the asset processor emitted a site-root-absolute URL with no
 * base — `/assets/hero-ab12cd34.webp` instead of `/repo/assets/...`. The files
 * were uploaded to the right place, but every `content.images[]` reference in
 * site-content.json pointed one directory too high and 404'd. Components render
 * those as a raw `<img src>`, so nothing downstream could repair it; the
 * collection processor already based its own asset paths, which is why
 * collection-backed images worked while page-section images did not.
 */

import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processAssets } from '../src/site/asset-processor.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'

describe('processAssets — base path', () => {
  let dir, outputDir, manifest

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-assets-'))
    outputDir = join(dir, 'dist')
    const srcPath = join(dir, 'hero.svg')
    await mkdir(outputDir, { recursive: true })
    await writeFile(srcPath, SVG)
    // SVG is a passthrough format — copied, not run through sharp.
    manifest = { '/img/hero.svg': { original: '/img/hero.svg', resolved: srcPath, isImage: true } }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('prefixes the emitted URL with the base', async () => {
    const { pathMapping } = await processAssets(manifest, { outputDir, basePath: '/my-repo/' })

    expect(pathMapping['/img/hero.svg']).toMatch(/^\/my-repo\/assets\/hero-[0-9a-f]{8}\.svg$/)
  })

  it('writes the file at the path the URL resolves to', async () => {
    const { pathMapping } = await processAssets(manifest, { outputDir, basePath: '/my-repo/' })

    // The base is a serving concern, not a disk concern: the artifact still
    // lands at dist/assets/, and the host mounts dist/ at /my-repo/.
    const url = pathMapping['/img/hero.svg']
    const written = await readdir(join(outputDir, 'assets'))
    expect(written).toContain(url.replace('/my-repo/assets/', ''))
  })

  it('emits a root-absolute URL when no base is set', async () => {
    for (const basePath of ['/', undefined]) {
      const { pathMapping } = await processAssets(manifest, { outputDir, basePath })
      expect(pathMapping['/img/hero.svg']).toMatch(/^\/assets\/hero-[0-9a-f]{8}\.svg$/)
    }
  })

  it('bases the fallback URL when the source is missing', async () => {
    const missing = { '/img/gone.png': { original: '/img/gone.png', resolved: join(dir, 'gone.png'), isImage: true } }

    const { pathMapping } = await processAssets(missing, { outputDir, basePath: '/my-repo/' })

    // Falls back to the authored path — which is served from public/ under the
    // base too, so it needs the prefix just the same.
    expect(pathMapping['/img/gone.png']).toBe('/my-repo/img/gone.png')
  })
})
