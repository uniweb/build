/**
 * ⭐ MEDIA BESIDE A PAGE REACHES A SITE PUBLISHED WITH UNIWEB (2026-10-28).
 *
 * A push uploaded only `/x` media and warned about a co-located file (`./team.jpg`) and skipped
 * it, so a page that showed its image under `uniweb dev` and in a static build lost it when
 * published. A push uploads it now, keyed by its path from the site root — `./team.jpg` names a
 * different file beside every page — and a pull writes it back as the author wrote it, relative
 * to the file the section is written to (`located-media.js`).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, siteContentDocumentToProject } from '../src/uwx/index.js'
import { writtenRefs, siteFileKey } from '../src/uwx/located-media.js'

const BACKEND = 'http://localhost:8080'
let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const sent = (pkg) => JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
const keysOf = (pkg) => pkg.localFiles.map((f) => f.ref).sort()

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-located-'))
  SITE = join(ROOT, 'site')
  mkdirSync(join(ROOT, 'foundation', 'dist', 'meta'), { recursive: true })
  writeFileSync(
    join(ROOT, 'foundation', 'dist', 'meta', 'schema.json'),
    JSON.stringify({ _self: { name: '@acme/marketing', version: '1', role: 'foundation' } })
  )
  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } }))
  w('pages/home/page.yml', 'id: home\n')
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('push — a section\'s co-located file', () => {
  it('rides localFiles under its path from the site root, and is not warned about', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Team](./team.jpg)\n')
    w('pages/home/team.jpg', 'jpg')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.localFiles).toContainEqual({ ref: 'pages/home/team.jpg', path: join(SITE, 'pages/home/team.jpg') })
    expect(pkg.warnings.some((m) => m.includes('team.jpg'))).toBe(false)
    // Without the upload, the document keeps the reference as written.
    expect(JSON.stringify(sent(pkg))).toContain('./team.jpg')
  })

  it('is swapped for its served URL, its identity beside it, by the upload that names it', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Team](./team.jpg)\n')
    w('pages/home/team.jpg', 'jpg')
    const pkg = await emitSyncPackages(SITE, {
      assetRewrite: { 'pages/home/team.jpg': 'https://cdn.example/a1.jpg' },
      assetIds: { 'pages/home/team.jpg': { id: 'a1', ext: 'jpg' } },
    })
    const json = JSON.stringify(sent(pkg))
    expect(json).toContain('"src":"https://cdn.example/a1.jpg"')
    expect(json).toContain('"assetId":"a1"')
    expect(json).not.toContain('team.jpg')
  })

  it('the same ./ path beside two pages names two files, each under its own key', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Photo](./photo.png)\n')
    w('pages/home/photo.png', 'home')
    w('pages/about/page.yml', 'id: about\n')
    w('pages/about/1-intro.md', '---\ntype: Hero\nid: intro\n---\n# About\n\n![Photo](./photo.png)\n')
    w('pages/about/photo.png', 'about')
    const keys = ['pages/about/photo.png', 'pages/home/photo.png']
    expect(keysOf(await emitSyncPackages(SITE))).toEqual(keys)

    const pkg = await emitSyncPackages(SITE, { assetRewrite: { [keys[0]]: 'https://cdn/about.png', [keys[1]]: 'https://cdn/home.png' } })
    const pages = Object.fromEntries(sent(pkg).pages.map((p) => [p.stable_id, JSON.stringify(p)]))
    expect(pages.home).toContain('https://cdn/home.png')
    expect(pages.about).toContain('https://cdn/about.png')
  })

  it('a video beside the page and its ./ poster both ride, and the poster is swapped with its identity', async () => {
    w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Clip](./clip.mp4){role=video poster=./thumb.jpg}\n')
    w('pages/home/clip.mp4', 'mp4')
    w('pages/home/thumb.jpg', 'jpg')
    expect(keysOf(await emitSyncPackages(SITE))).toEqual(['pages/home/clip.mp4', 'pages/home/thumb.jpg'])

    const pkg = await emitSyncPackages(SITE, {
      assetRewrite: { 'pages/home/clip.mp4': '/assets/v1.mp4', 'pages/home/thumb.jpg': '/assets/p1.jpg' },
      assetIds: { 'pages/home/clip.mp4': { id: 'v1', ext: 'mp4' }, 'pages/home/thumb.jpg': { id: 'p1', ext: 'jpg' } },
    })
    const json = JSON.stringify(sent(pkg))
    expect(json).toContain('"poster":"/assets/p1.jpg"')
    expect(json).toContain('"posterAssetId":"p1"')
  })

  it('one in the layout rides under its path too', async () => {
    w('layout/header.md', '---\ntype: Header\n---\n# H\n\n![Logo](./logo.svg)\n')
    w('layout/logo.svg', '<svg/>')
    expect(keysOf(await emitSyncPackages(SITE))).toEqual(['layout/logo.svg'])
  })

  it('one outside the site\'s folder is warned about, and not uploaded', async () => {
    writeFileSync(join(ROOT, 'outside.png'), 'png')
    w('pages/home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Out](../../../outside.png)\n')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.localFiles).toEqual([])
    expect(pkg.warnings.some((m) => m.includes('../../../outside.png') && m.includes("outside the site's folder"))).toBe(true)
  })
})

describe('pull — a co-located file a push uploaded', () => {
  it('writtenRefs: a key is written relative to the section\'s file, and nothing else moves', () => {
    const keys = new Set(['pages/home/team.jpg'])
    const at = (rel) => ({ siteRoot: SITE, filePath: join(SITE, rel), keys })
    const value = { src: 'pages/home/team.jpg', other: '/images/x.png', list: ['pages/home/team.jpg'] }
    expect(writtenRefs(value, at('pages/home/1-hero.md'))).toEqual({ src: './team.jpg', other: '/images/x.png', list: ['./team.jpg'] })
    expect(writtenRefs(value, at('pages/about/1-intro.md')).src).toBe('../home/team.jpg')
    expect(value.src).toBe('pages/home/team.jpg') // never mutated
    expect(siteFileKey(SITE, join(ROOT, 'outside.png'))).toBe(null)
  })

  it('⭐ a push then a pull is a fixed point: the section comes back as the author wrote it', async () => {
    const authored = '---\ntype: Hero\nid: hero\n---\n\n# Hi\n\n![Team](./team.jpg)\n'
    w('pages/home/hero.md', authored)
    w('pages/home/team.jpg', 'jpg')
    const ids = { 'pages/home/team.jpg': { id: 'a1', ext: 'jpg' } }
    const document = sent(await emitSyncPackages(SITE, { assetRewrite: { 'pages/home/team.jpg': '/assets/a1.jpg' }, assetIds: ids }))
    // What the push banked — and what the pull reads the author's paths from.
    writeFileSync(join(SITE, 'sync.json'), JSON.stringify({ version: 1, backends: { [BACKEND]: { assets: ids } } }))

    siteContentDocumentToProject({ document, siteRoot: SITE, backend: BACKEND })
    expect(readFileSync(join(SITE, 'pages/home/hero.md'), 'utf8')).toBe(authored)
  })

  it('CONTROL — with no asset map, the served URL that works is written', async () => {
    w('pages/home/hero.md', '---\ntype: Hero\nid: hero\n---\n\n# Hi\n\n![Team](./team.jpg)\n')
    w('pages/home/team.jpg', 'jpg')
    const ids = { 'pages/home/team.jpg': { id: 'a1', ext: 'jpg' } }
    const document = sent(await emitSyncPackages(SITE, { assetRewrite: { 'pages/home/team.jpg': '/assets/a1.jpg' }, assetIds: ids }))
    siteContentDocumentToProject({ document, siteRoot: SITE, backend: BACKEND })
    expect(readFileSync(join(SITE, 'pages/home/hero.md'), 'utf8')).toContain('/assets/a1.jpg')
  })
})
