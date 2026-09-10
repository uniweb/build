/**
 * Single-string asset fields on the site's `info` brief — today `preview`, the site
 * card's image [Diego, 2026-09-10] — and the two site.yml writers for values the CLI
 * records rather than the author types.
 *
 * Identity for every other asset rides BESIDE its URL as flat attrs. `info` is a
 * Section whose fields the host declares, so for these fields it rides in the served
 * URL's fragment instead. The tests pin the two properties that make that safe:
 *   · the push never puts an undeclared attr on `info` (`preview` is a real
 *     ASSET_SLOTS slot, so the generic stamp WOULD write `previewAssetId`);
 *   · push → pull puts back the exact path the author wrote.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  emitSyncPackages,
  siteContentDocumentToProject,
  readZip,
  updateAssetMap,
  restoreAssetRefs,
  withAssetIdentity,
  assetIdentityOf,
  writeSiteUrl,
  removeYamlScalar,
} from '../src/uwx/index.js'

const SERVE = '/gateway/asset/dist/9f2c/base.png'
const IDS = { '/images/card.png': { id: '9f2c', ext: 'png' } }
const REWRITE = { '/images/card.png': SERVE }

const DIRS = []
afterEach(() => {
  while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true })
})

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  DIRS.push(dir)
  return dir
}

function siteWithPreview(preview) {
  const root = tmp('uwx-info-assets-')
  mkdirSync(join(root, 'pages', 'home'), { recursive: true })
  writeFileSync(join(root, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# H\n')
  writeFileSync(
    join(root, 'site.yml'),
    `name: S\nfoundation: '@a/b@1.0.0'\npreview: ${JSON.stringify(preview)}\n`
  )
  return root
}

const siteDocOf = (pkg) =>
  JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

describe('the identity fragment', () => {
  it('carries id and ext, and reads back exactly', () => {
    const value = withAssetIdentity(SERVE, { id: '9f2c', ext: 'png' })
    expect(value).toBe(`${SERVE}#assetId=9f2c&assetExt=png`)
    expect(assetIdentityOf(value)).toEqual({ id: '9f2c', ext: 'png', url: SERVE })
  })

  it('leaves a value alone when there is nothing to carry, or a fragment is already there', () => {
    expect(withAssetIdentity(SERVE, null)).toBe(SERVE)
    expect(withAssetIdentity(`${SERVE}#x`, { id: '9f2c' })).toBe(`${SERVE}#x`)
    // The app's timestamp and a plain URL carry no identity.
    expect(assetIdentityOf('2026-09-10T12:34:56Z')).toBeNull()
    expect(assetIdentityOf('https://cdn.example/card.png')).toBeNull()
  })
})

describe('info.preview — an image in the project', () => {
  it('is surfaced for upload like any content image', async () => {
    const pkg = await emitSyncPackages(siteWithPreview('/images/card.png'))
    expect(pkg.localAssets).toContain('/images/card.png')
  })

  it('⛔ goes up as the serve URL with identity in the fragment — and NO attr beside it on info', async () => {
    const pkg = await emitSyncPackages(siteWithPreview('/images/card.png'), {
      assetRewrite: REWRITE,
      assetIds: IDS,
    })
    const { info } = siteDocOf(pkg)
    expect(info.preview).toBe(`${SERVE}#assetId=9f2c&assetExt=png`)
    // `preview` is a real ASSET_SLOTS slot; the generic stamp would write these, and
    // the host refuses a field its `info` does not declare.
    expect(info).not.toHaveProperty('previewAssetId')
    expect(info).not.toHaveProperty('previewAssetExt')
  })

  it('⭐ push → pull puts back the path the author wrote', async () => {
    const pkg = await emitSyncPackages(siteWithPreview('/images/card.png'), {
      assetRewrite: REWRITE,
      assetIds: IDS,
    })
    const dest = tmp('uwx-info-assets-pull-')
    mkdirSync(join(dest, 'pages'), { recursive: true })
    // The committed map every clone of the project carries.
    updateAssetMap(dest, IDS)
    siteContentDocumentToProject({ document: siteDocOf(pkg), siteRoot: dest })
    expect(yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8')).preview).toBe('/images/card.png')
  })

  it('an id the map does not know stays as the URL that works', () => {
    const doc = { info: { preview: `${SERVE}#assetId=ffff&assetExt=png` } }
    const stats = restoreAssetRefs(doc, IDS)
    expect(doc.info.preview).toBe(`${SERVE}#assetId=ffff&assetExt=png`)
    expect(stats.unknown).toBe(1)
  })
})

describe('info.preview — values that are not a project image', () => {
  for (const value of ['2026-09-10T12:34:56Z', 'https://cdn.example/card.png']) {
    it(`${value} rides verbatim and is never uploaded`, async () => {
      const pkg = await emitSyncPackages(siteWithPreview(value), {
        assetRewrite: REWRITE,
        assetIds: IDS,
      })
      expect(siteDocOf(pkg).info.preview).toBe(value)
      expect(pkg.localAssets).not.toContain(value)
    })
  }
})

describe('site.yml writers for recorded values', () => {
  const siteYml = (body) => {
    const root = tmp('uwx-yml-')
    writeFileSync(join(root, 'site.yml'), body)
    return root
  }

  it('writeSiteUrl records $url, keeps the comments, and is a no-op when unchanged', () => {
    const root = siteYml('# my site\nname: S\n')
    expect(writeSiteUrl(root, 'https://acme.example/')).toBe(true)
    const text = readFileSync(join(root, 'site.yml'), 'utf8')
    expect(text).toContain('# my site')
    expect(yaml.load(text).$url).toBe('https://acme.example/')
    expect(writeSiteUrl(root, 'https://acme.example/')).toBe(false)
  })

  it('writeSiteUrl quotes a value YAML would otherwise misread', () => {
    const root = siteYml('name: S\n')
    writeSiteUrl(root, 'https://acme.example/a b')
    expect(yaml.load(readFileSync(join(root, 'site.yml'), 'utf8')).$url).toBe('https://acme.example/a b')
  })

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
