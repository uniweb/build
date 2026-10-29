/**
 * Asset references that are a BARE STRING — `info.preview` (the site card's image
 * [Diego, 2026-09-10]), `info.favicon`, `settings.touch_icon`, a theme's font faces, `seo.image`
 * at the site and page tiers, a section param — and removing a key from site.yml through `writeSiteConfig`, as a pull
 * removes the token an older pull left in `preview` (`removeYamlScalar` until 2026-10-07).
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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

const ORIGIN = 'https://backend.test'
import {
  emitSyncPackages,
  siteContentDocumentToProject,
  readZip,
  readBackendState,
  updateBackendMap,
  carryServed,
  restoreAssetRefs,
  servedFingerprint,
  writeSiteConfig,
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
    updateBackendMap(dest, ORIGIN, 'assets', IDS)
    siteContentDocumentToProject({ document: doc, siteRoot: dest, backend: ORIGIN })

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

describe('the favicon, whatever its type', () => {
  // `.ico` is not media to the walker (`isLocalAssetPath`), so until 2026-10-27 a site's
  // `favicon: /favicon.ico` was never uploaded: its hosted pages linked a site path the
  // host does not serve, and answered 404 for it.
  function withFavicon(favicon) {
    const root = project()
    const file = join(root, 'site.yml')
    writeFileSync(file, readFileSync(file, 'utf8').replace('favicon: /f.png', `favicon: ${JSON.stringify(favicon)}`))
    return root
  }
  const ICO = 'https://assets.example/f6'
  const SERVED_ICO = { ...SERVED, '/favicon.ico': ICO }
  const IDS_ICO = { ...IDS, '/favicon.ico': { id: 'f6', ext: 'ico', served: servedFingerprint(ICO) } }

  it('⭐ an .ico is surfaced for upload, rides as its serve URL, and pulls back as the path', async () => {
    const root = withFavicon('/favicon.ico')
    expect((await emitSyncPackages(root)).localAssets).toContain('/favicon.ico')
    const doc = siteDocOf(await emitSyncPackages(root, { assetRewrite: SERVED_ICO, assetIds: IDS_ICO }))
    expect(doc.info.favicon).toBe(ICO)

    const dest = tmp('uwx-ico-pull-')
    mkdirSync(join(dest, 'pages'), { recursive: true })
    updateBackendMap(dest, ORIGIN, 'assets', IDS_ICO)
    siteContentDocumentToProject({ document: doc, siteRoot: dest, backend: ORIGIN })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).favicon).toBe('/favicon.ico')
  })

  it('an address of its own is never uploaded, and rides as written', async () => {
    const pkg = await emitSyncPackages(withFavicon('https://cdn.example/f.ico'), { assetRewrite: SERVED_ICO, assetIds: IDS_ICO })
    expect(pkg.localAssets).not.toContain('https://cdn.example/f.ico')
    expect(siteDocOf(pkg).info.favicon).toBe('https://cdn.example/f.ico')
  })
})

describe('the touch icon — sent only where the deployment takes it', () => {
  // `site.yml::touchIcon` rides `settings.touch_icon`, a key a deployment declares or does not
  // (`GET /dev/config` → `settingsFields`), and one that does not refuses a push carrying it.
  function withTouchIcon() {
    const root = project()
    const file = join(root, 'site.yml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}touchIcon: /touch-icon.png\n`)
    return root
  }
  const TOUCH = 'https://assets.example/t7'
  const SERVED_TOUCH = { ...SERVED, '/touch-icon.png': TOUCH }
  const IDS_TOUCH = { ...IDS, '/touch-icon.png': { id: 't7', ext: 'png', served: servedFingerprint(TOUCH) } }
  const TAKES = { settingsFields: ['seo', 'touch_icon'] }

  let warnings
  beforeEach(() => {
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
  })
  afterEach(() => vi.restoreAllMocks())

  it('⭐ is surfaced for upload, rides as its serve URL, and pulls back as the path', async () => {
    const root = withTouchIcon()
    expect((await emitSyncPackages(root, TAKES)).localAssets).toContain('/touch-icon.png')
    const doc = siteDocOf(await emitSyncPackages(root, { ...TAKES, assetRewrite: SERVED_TOUCH, assetIds: IDS_TOUCH }))
    expect(doc.settings.touch_icon).toBe(TOUCH)
    // A bare string, like the favicon: no identity attr lands beside it.
    expect(Object.keys(doc.settings).filter((k) => /AssetId|AssetExt/.test(k))).toEqual([])

    const dest = tmp('uwx-touch-pull-')
    mkdirSync(join(dest, 'pages'), { recursive: true })
    updateBackendMap(dest, ORIGIN, 'assets', IDS_TOUCH)
    siteContentDocumentToProject({ document: doc, siteRoot: dest, backend: ORIGIN })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).touchIcon).toBe('/touch-icon.png')
    expect(warnings).toEqual([])
  })

  it('is neither sent nor uploaded where the deployment takes none — and the site is told', async () => {
    const pkg = await emitSyncPackages(withTouchIcon(), { settingsFields: ['seo'] })
    expect(siteDocOf(pkg).settings).not.toHaveProperty('touch_icon')
    expect(pkg.localAssets).not.toContain('/touch-icon.png')
    expect(warnings.filter((w) => w.includes('`touchIcon:` is not sent'))).toHaveLength(1)
  })

  it('with no list in hand, nothing optional is sent, and nothing is said', async () => {
    const pkg = await emitSyncPackages(withTouchIcon())
    expect(siteDocOf(pkg).settings).not.toHaveProperty('touch_icon')
    expect(warnings.filter((w) => w.includes('touchIcon'))).toEqual([])
  })
})

describe("the theme's font files", () => {
  // A font is not media to the walker (`isLocalAssetPath`), so until 2026-10-28 a theme's
  // `fonts.faces` were never uploaded: a hosted page preloaded each face from a site path its
  // host does not serve, and the site fell back to system fonts.
  function withFaces(...srcs) {
    const root = project()
    const faces = srcs.map((src) => ({ family: 'Söhne', src, weight: 400 }))
    writeFileSync(join(root, 'theme.yml'), yaml.dump({ fonts: { heading: 'Söhne, sans-serif', faces } }))
    return root
  }
  const FONT = 'https://assets.example/w8'
  const SERVED_FONT = { ...SERVED, '/fonts/s.woff2': FONT }
  const IDS_FONT = { ...IDS, '/fonts/s.woff2': { id: 'w8', ext: 'woff2', served: servedFingerprint(FONT) } }

  it('⭐ a face is surfaced for upload, rides as its serve URL, and pulls back as the path', async () => {
    const root = withFaces('/fonts/s.woff2')
    expect((await emitSyncPackages(root)).localAssets).toContain('/fonts/s.woff2')
    const doc = siteDocOf(await emitSyncPackages(root, { assetRewrite: SERVED_FONT, assetIds: IDS_FONT }))
    // The theme as written, its address swapped: `src` is a slot's key, yet no identity attr lands.
    expect(doc.settings.theme.fonts.faces).toEqual([{ family: 'Söhne', src: FONT, weight: 400 }])

    const dest = tmp('uwx-font-pull-')
    mkdirSync(join(dest, 'pages'), { recursive: true })
    updateBackendMap(dest, ORIGIN, 'assets', IDS_FONT)
    siteContentDocumentToProject({ document: doc, siteRoot: dest, backend: ORIGIN })
    const theme = yaml.load(readFileSync(join(dest, 'theme.yml'), 'utf8'))
    expect(theme.fonts.faces).toEqual([{ family: 'Söhne', src: '/fonts/s.woff2', weight: 400 }])
  })

  it('a face at an address of its own is never uploaded, and rides as written', async () => {
    const pkg = await emitSyncPackages(withFaces('https://cdn.example/s.woff2'), { assetRewrite: SERVED_FONT, assetIds: IDS_FONT })
    expect(pkg.localAssets).not.toContain('https://cdn.example/s.woff2')
    expect(siteDocOf(pkg).settings.theme.fonts.faces[0].src).toBe('https://cdn.example/s.woff2')
  })
})

describe('info.preview values that are not a project image', () => {
  it('a URL rides verbatim and is never uploaded', async () => {
    const value = 'https://cdn.example/card.png'
    const pkg = await emitSyncPackages(project({ preview: value }), { assetRewrite: SERVED, assetIds: IDS })
    expect(siteDocOf(pkg).info.preview).toBe(value)
    expect(pkg.localAssets).not.toContain(value)
  })

  it('the token an older pull wrote for the app\'s card image is neither sent nor uploaded', async () => {
    const value = '2026-09-10T12:34:56Z'
    const pkg = await emitSyncPackages(project({ preview: value }), { assetRewrite: SERVED, assetIds: IDS })
    expect(siteDocOf(pkg).info).not.toHaveProperty('preview')
    expect(pkg.localAssets).not.toContain(value)
  })
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
    const put = (e) => updateBackendMap(dir, ORIGIN, 'assets', { '/a.png': e }, carryServed)
    const got = () => readBackendState(dir, ORIGIN).assets['/a.png']

    put({ id: 'A', ext: 'png', served: 'sha256:1' })
    expect(got()).toEqual({ id: 'A', ext: 'png', served: 'sha256:1' })
    // A download learns identity but not an upload's URL — it must not erase this.
    expect(put({ id: 'A', ext: 'png' }).written).toBe(false)
    expect(got().served).toBe('sha256:1')
    // The host now serves the same bytes at another address.
    expect(put({ id: 'A', ext: 'png', served: 'sha256:2' }).changed).toEqual(['/a.png'])
  })
})

describe('dropping a key from site.yml — what a pull does to the app\'s old `preview` token', () => {
  const siteYml = (body) => {
    const root = tmp('uwx-yml-')
    writeFileSync(join(root, 'site.yml'), body)
    return root
  }

  it('removes the key and nothing else', () => {
    const root = siteYml("# keep me\npreview: '123'\nname: S\n$uuid: abc\n")
    const file = join(root, 'site.yml')
    expect(writeSiteConfig(root, { preview: null })).toBe('updated')
    expect(readFileSync(file, 'utf8')).toBe('# keep me\nname: S\n$uuid: abc\n')
    expect(writeSiteConfig(root, { preview: null })).toBe('unchanged')
    // A `$`-prefixed key is a key like any other.
    expect(writeSiteConfig(root, { $uuid: null })).toBe('updated')
    expect(readFileSync(file, 'utf8')).toBe('# keep me\nname: S\n')
  })

  it('removes a block value whole — the line editor it replaced left one alone rather than half-remove it', () => {
    const root = siteYml('seo:\n  image: /og.png   # the card\nname: S\n')
    expect(writeSiteConfig(root, { seo: null })).toBe('updated')
    expect(readFileSync(join(root, 'site.yml'), 'utf8')).toBe('name: S\n')
  })
})
