/**
 * A PREVIEW OF A SITE A BACKEND HOLDS — what `uniweb dev` hands the dev server (`site/preview.js`).
 *
 * A clone names its foundation by catalog ref, and a build refuses one: where a version is served is
 * the backend's to say. `uniweb dev` asks, and hands the answer — with the backend it asked — to its
 * one dev server. These pin the three things that make that safe:
 *
 *   - the answer resolves the DECLARED foundation and can substitute no other;
 *   - it never reaches a built artifact;
 *   - the media URLs a clone keeps from its backend are fetched from that backend, and nothing else is.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { detectFoundationType, defineSiteConfig } from '../src/site/config.js'
import { PREVIEW_ENV, encodePreview, readPreview } from '../src/site/preview.js'
import { previewMediaPlugin, mediaPath } from '../src/site/preview-media.js'

const REF = '@acme/fnd@1.0.0'
const PREVIEW = {
  backend: 'http://backend.test',
  foundation: { ref: REF, url: 'http://backend.test/served/fnd/entry.js', cssUrl: 'http://backend.test/served/fnd/style.css' },
}

describe('the preview contract', () => {
  it('reads what it was handed, and nothing when it was handed nothing', () => {
    expect(readPreview({ [PREVIEW_ENV]: encodePreview(PREVIEW) })).toEqual(PREVIEW)
    expect(readPreview({})).toBe(null)
  })

  it('refuses a value that holds no preview — a preview must not start as if it had none', () => {
    for (const raw of ['{', '{}', JSON.stringify({ ...PREVIEW, backend: 'localhost:8080' }), JSON.stringify({ backend: PREVIEW.backend, foundation: { ref: REF } })]) {
      expect(() => readPreview({ [PREVIEW_ENV]: raw })).toThrow(/uniweb dev/)
    }
  })
})

describe('a catalog ref, resolved for a preview', () => {
  it('⭐ resolves to where the backend serves it — for the ref site.yml names', () => {
    expect(detectFoundationType(REF, '/nowhere', { served: PREVIEW.foundation })).toEqual({
      type: 'url',
      url: PREVIEW.foundation.url,
      cssUrl: PREVIEW.foundation.cssUrl,
      served: REF,
    })
  })

  it('⛔ never for another ref — the answer cannot substitute a foundation', () => {
    const other = { ...PREVIEW.foundation, ref: '@acme/fnd@2.0.0' }
    expect(() => detectFoundationType(REF, '/nowhere', { served: other })).toThrow(/@acme\/fnd@2\.0\.0.*@acme\/fnd@1\.0\.0/s)
  })

  it('CONTROL — handed nothing, a catalog ref is refused as before, and the refusal names `uniweb dev`', () => {
    expect(() => detectFoundationType(REF, '/nowhere')).toThrow(/catalog ref/)
    expect(() => detectFoundationType(REF, '/nowhere')).toThrow(/uniweb dev/)
  })
})

describe('the dev server of a preview', () => {
  let root
  let cwd
  const saved = process.env[PREVIEW_ENV]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'uniweb-preview-'))
    const siteDir = join(root, 'site')
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), `name: T\nfoundation: '${REF}'\n`)
    await writeFile(join(siteDir, 'package.json'), JSON.stringify({ name: 'site' }))
    cwd = process.cwd()
    process.chdir(siteDir)
  })

  afterEach(async () => {
    process.chdir(cwd)
    if (saved === undefined) delete process.env[PREVIEW_ENV]
    else process.env[PREVIEW_ENV] = saved
    await rm(root, { recursive: true, force: true })
  })

  const plugin = (config, name) => config.plugins.find((p) => p?.name === name)

  it('⭐ loads the foundation from where the backend serves it', async () => {
    process.env[PREVIEW_ENV] = encodePreview(PREVIEW)
    const config = await defineSiteConfig()
    expect(JSON.parse(config.define.__FOUNDATION_CONFIG__)).toEqual({
      mode: 'runtime',
      url: PREVIEW.foundation.url,
      cssUrl: PREVIEW.foundation.cssUrl,
    })
    expect(plugin(config, 'uniweb:import-map')).toBeTruthy()
    expect(plugin(config, 'uniweb:preview-media')).toBeTruthy()
  })

  it('⛔ a build handed a preview refuses it — the answer never reaches `dist/`', async () => {
    process.env[PREVIEW_ENV] = encodePreview(PREVIEW)
    const config = await defineSiteConfig()
    const guard = plugin(config, 'uniweb:preview-only')
    expect(() => guard.config({}, { command: 'build' })).toThrow(/a build does not take it/)
    expect(() => guard.config({}, { command: 'serve' })).not.toThrow()
  })

  it('CONTROL — without a preview a clone does not start, and nothing preview-shaped is added', async () => {
    delete process.env[PREVIEW_ENV]
    await expect(defineSiteConfig()).rejects.toThrow(/catalog ref/)
  })
})

describe('the media a preview fetches from its backend', () => {
  const req = (url, headers = {}, method = 'GET') => ({ url, method, headers })

  it('is a media request, by its destination or, without one, by what it accepts', () => {
    expect(mediaPath(req('/media/x/base.png', { 'sec-fetch-dest': 'image' }))).toBe('/media/x/base.png')
    expect(mediaPath(req('/v.mp4', { 'sec-fetch-dest': 'video' }))).toBe('/v.mp4')
    expect(mediaPath(req('/a.png', { accept: 'image/avif,image/*' }))).toBe('/a.png')
  })

  it('CONTROL — never a page, a script, a write, or one of Vite’s own paths', () => {
    expect(mediaPath(req('/blog', { 'sec-fetch-dest': 'document' }))).toBe(null)
    expect(mediaPath(req('/data/articles.json', { 'sec-fetch-dest': 'empty' }))).toBe(null)
    expect(mediaPath(req('/a.png', { 'sec-fetch-dest': 'image' }, 'POST'))).toBe(null)
    expect(mediaPath(req('/@fs/x/a.png', { 'sec-fetch-dest': 'image' }))).toBe(null)
    expect(mediaPath(req('/node_modules/x/a.png', { 'sec-fetch-dest': 'image' }))).toBe(null)
  })

  describe('the middleware', () => {
    let siteRoot
    let fetched
    const realFetch = globalThis.fetch

    beforeEach(async () => {
      siteRoot = await mkdtemp(join(tmpdir(), 'uniweb-preview-media-'))
      await mkdir(join(siteRoot, 'public', 'images'), { recursive: true })
      await writeFile(join(siteRoot, 'public', 'images', 'own.png'), 'own')
      fetched = []
      globalThis.fetch = async (url, init) => {
        fetched.push([String(url), init.method])
        return String(url).endsWith('/missing.png')
          ? new Response('', { status: 404 })
          : new Response('backend-bytes', { status: 200, headers: { 'content-type': 'image/png' } })
      }
    })

    afterEach(async () => {
      globalThis.fetch = realFetch
      await rm(siteRoot, { recursive: true, force: true })
    })

    function serve(url, dest = 'image') {
      let middleware
      previewMediaPlugin({ backend: 'http://backend.test', siteRoot }).configureServer({
        config: { base: '/', publicDir: join(siteRoot, 'public') },
        middlewares: { use: (fn) => (middleware = fn) },
      })
      const res = new PassThrough()
      const headers = {}
      res.statusCode = 200
      res.setHeader = (k, v) => (headers[k] = v)
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      return new Promise((resolve) => {
        res.on('end', () => resolve({ passed: false, status: res.statusCode, headers, body: Buffer.concat(chunks).toString() }))
        middleware(req(url, { 'sec-fetch-dest': dest }), res, () => resolve({ passed: true }))
      })
    }

    it('⭐ answers media the site does not hold with what its backend answers', async () => {
      const got = await serve('/media/abc/base.png')
      expect(fetched).toEqual([['http://backend.test/media/abc/base.png', 'GET']])
      expect(got).toMatchObject({ status: 200, body: 'backend-bytes', headers: { 'content-type': 'image/png' } })
    })

    it('says the backend lacks it too, rather than answering `index.html`', async () => {
      expect(await serve('/media/missing.png')).toMatchObject({ passed: false, status: 404 })
    })

    it('CONTROL — the site’s own file, and anything not media, never leave the dev server', async () => {
      expect(await serve('/images/own.png')).toEqual({ passed: true })
      expect(await serve('/blog', 'document')).toEqual({ passed: true })
      expect(fetched).toEqual([])
    })
  })
})
