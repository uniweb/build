/**
 * Asset references that are a BARE STRING — `info.preview` (the site card's image
 * [Diego, 2026-09-10]), `info.favicon`, `seo.image` at the site and page tiers, a
 * section param — and `removeYamlScalar`, which the CLI uses to drop a previous
 * site's values from site.yml.
 *
 * Content images carry identity BESIDE their URL as flat attrs, so a pull restores
 * the author's path by id. A bare string has no object to carry it: the stored value
 * is the serve URL alone. The push records a FINGERPRINT of that URL in the
 * committed `assets.json`, and the pull recognizes it — so the wire carries exactly
 * the host's URL, and no consumer receives anything it would have to strip.
 *
 * The properties pinned here:
 *   · the wire carries the plain serve URL, and no undeclared attr lands on `info`
 *     (`preview` is a real ASSET_SLOTS slot, so the generic stamp WOULD);
 *   · push → pull puts back the exact path the author wrote, at every tier;
 *   · a URL the map cannot recognize stays as the URL that works.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  emitSyncPackages,
  siteContentDocumentToProject,
  readZip,
  readAssetMap,
  updateAssetMap,
  restoreAssetRefs,
  servedFingerprint,
  removeYamlScalar,
} from '../src/uwx/index.js'

// Stand-ins for what an upload plan hands back. A real serve URL is whatever the host
// returns, read verbatim — nothing here depends on its shape, so these are deliberately
// not shaped like any host's route. Both an absolute and an origin-relative form occur.
const ASSETS = [
  ['/images/card.png', 'a1', 'https://assets.example/a1'],
  ['/f.png', 'b2', 'https://assets.example/b2'],
  ['/og.png', 'c3', '/served/c3'],
  ['/page-og.png', 'd4', '/served/d4'],
  ['/param.png', 'e5', '/served/e5'],
]
const SERVED = Object.fromEntries(ASSETS.map(([ref, , url]) => [ref, url]))
// …and what the push records from them in assets.json.
const IDS = Object.fromEntries(
  ASSETS.map(([ref, id, url]) => [ref, { id, ext: 'png', served: servedFingerprint(url) }])
)

const DIRS = []
afterEach(() => {
  while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true })
})

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  DIRS.push(dir)
  return dir
}

/** A site with a bare-string image reference at every tier the defect reached. */
function project({ preview = '/images/card.png' } = {}) {
  const root = tmp('uwx-bare-')
  mkdirSync(join(root, 'pages', 'home'), { recursive: true })
  writeFileSync(join(root, 'pages', 'home', 'page.yml'), 'title: Home\nseo:\n  image: /page-og.png\n')
  writeFileSync(join(root, 'pages', 'home', 'hero.md'), '---\ntype: Hero\nimage: /param.png\n---\n\n# H\n')
  writeFileSync(
    join(root, 'site.yml'),
    [
      'name: S', "foundation: '@a/b@1.0.0'", `preview: ${JSON.stringify(preview)}`,
      'favicon: /f.png', 'seo:', '  image: /og.png', '',
    ].join('\n')
  )
  return root
}

const siteDocOf = (pkg) =>
  JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

function sectionFrontmatter(pageDir) {
  const md = readdirSync(pageDir).find((f) => f.endsWith('.md'))
  return yaml.load(readFileSync(join(pageDir, md), 'utf8').split('---')[1])
}

describe('bare-string asset references', () => {
  it('are surfaced for upload like any content image', async () => {
    const pkg = await emitSyncPackages(project())
    expect(pkg.localAssets).toEqual(expect.arrayContaining(Object.keys(SERVED)))
  })

  it('ride the wire as the plain serve URL — and no identity attr lands on info', async () => {
    const doc = siteDocOf(await emitSyncPackages(project(), { assetRewrite: SERVED, assetIds: IDS }))
    expect(doc.info.preview).toBe(SERVED['/images/card.png'])
    expect(doc.info.favicon).toBe(SERVED['/f.png'])
    expect(doc.settings.seo.image).toBe(SERVED['/og.png'])
    // `preview` is a real ASSET_SLOTS slot; the generic stamp would write these, and
    // the host refuses a field its `info` does not declare.
    expect(doc.info).not.toHaveProperty('previewAssetId')
    expect(doc.info).not.toHaveProperty('previewAssetExt')
  })

  it('⭐ push → pull puts back every path the author wrote, at every tier', async () => {
    const doc = siteDocOf(await emitSyncPackages(project(), { assetRewrite: SERVED, assetIds: IDS }))
    const dest = tmp('uwx-bare-pull-')
    mkdirSync(join(dest, 'pages'), { recursive: true })
    // The committed map every clone of the project carries.
    updateAssetMap(dest, IDS)
    siteContentDocumentToProject({ document: doc, siteRoot: dest })

    const site = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(site.preview).toBe('/images/card.png')
    expect(site.favicon).toBe('/f.png')
    expect(site.seo.image).toBe('/og.png')
    const page = yaml.load(readFileSync(join(dest, 'pages', 'home', 'page.yml'), 'utf8'))
    expect(page.seo.image).toBe('/page-og.png')
    expect(sectionFrontmatter(join(dest, 'pages', 'home')).image).toBe('/param.png')
  })

  it('a URL the map has no fingerprint for stays as the URL that works', () => {
    const doc = { info: { favicon: 'https://assets.example/ff' } }
    const stats = restoreAssetRefs(doc, IDS)
    expect(doc.info.favicon).toBe('https://assets.example/ff')
    expect(stats.restored).toBe(0)
  })
})

describe('info.preview values that are not a project image', () => {
  for (const value of ['2026-09-10T12:34:56Z', 'https://cdn.example/card.png']) {
    it(`${value} rides verbatim and is never uploaded`, async () => {
      const pkg = await emitSyncPackages(project({ preview: value }), {
        assetRewrite: SERVED,
        assetIds: IDS,
      })
      expect(siteDocOf(pkg).info.preview).toBe(value)
      expect(pkg.localAssets).not.toContain(value)
    })
  }
})

describe('assets.json — the served fingerprint', () => {
  it('is a hash, never the URL, and is stable', () => {
    const fp = servedFingerprint(SERVED['/f.png'])
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(fp).not.toContain('assets.example')
    expect(servedFingerprint(SERVED['/f.png'])).toBe(fp)
  })

  it('is kept; a download cannot erase it, and a new one for the same bytes is a change', () => {
    const dir = tmp('uwx-map-')
    updateAssetMap(dir, { '/a.png': { id: 'A', ext: 'png', served: 'sha256:1' } })
    expect(readAssetMap(dir)['/a.png']).toEqual({ id: 'A', ext: 'png', served: 'sha256:1' })
    // A download learns identity but not an upload's URL — it must not erase this.
    expect(updateAssetMap(dir, { '/a.png': { id: 'A', ext: 'png' } }).written).toBe(false)
    expect(readAssetMap(dir)['/a.png'].served).toBe('sha256:1')
    // The host now serves the same bytes at another address.
    expect(
      updateAssetMap(dir, { '/a.png': { id: 'A', ext: 'png', served: 'sha256:2' } }).changed
    ).toEqual(['/a.png'])
  })
})

describe('removeYamlScalar', () => {
  const siteYml = (body) => {
    const root = tmp('uwx-yml-')
    writeFileSync(join(root, 'site.yml'), body)
    return root
  }

  it('removeYamlScalar removes one scalar line and nothing else', () => {
    const root = siteYml("# keep me\n$url: https://old.example/\nname: S\npreview: '123'\n")
    const file = join(root, 'site.yml')
    expect(removeYamlScalar(file, '$url')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe("# keep me\nname: S\npreview: '123'\n")
    expect(removeYamlScalar(file, '$url')).toBe(false)
  })

  it('removeYamlScalar leaves a block value alone rather than half-removing it', () => {
    const root = siteYml('seo:\n  image: /og.png\nname: S\n')
    const file = join(root, 'site.yml')
    expect(removeYamlScalar(file, 'seo')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('seo:\n  image: /og.png\nname: S\n')
  })
})
