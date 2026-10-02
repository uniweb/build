// ⭐ `vite preview` serves a page's folder for its URL without the slash, as the hosts a build deploys
// to do. ⛔ Until 2026-10-01 it served the site's root document there, so a translated page asked for
// without the slash rendered the not-found page: the root document carries the default locale.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directoryIndexUrl, previewDirectoryIndexPlugin } from '../src/site/preview-directory-index.js'

describe('directoryIndexUrl', () => {
  let dist
  const page = (route) => {
    mkdirSync(join(dist, route), { recursive: true })
    writeFileSync(join(dist, route, 'index.html'), '<html></html>')
  }
  const get = (url, base) => directoryIndexUrl({ method: 'GET', url }, dist, base)

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'uw-preview-index-'))
    page('fr/a-propos')
    page('about')
    page('fr/accès')
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'assets', 'app.js'), '')
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  it('a page asked for without the slash is its folder\'s index.html — a translated one included', () => {
    expect(get('/fr/a-propos')).toBe('/fr/a-propos/index.html')
    expect(get('/about')).toBe('/about/index.html')
  })

  it('keeps the query, and finds a folder by its decoded name', () => {
    expect(get('/fr/a-propos?ref=1')).toBe('/fr/a-propos/index.html?ref=1')
    expect(get('/fr/acc%C3%A8s')).toBe('/fr/acc%C3%A8s/index.html')
  })

  it('under a deployment base, the folder is found below the base', () => {
    expect(get('/docs/fr/a-propos', '/docs/')).toBe('/docs/fr/a-propos/index.html')
    expect(get('/fr/a-propos', '/docs/')).toBeNull()
  })

  it('leaves Vite everything else: the slash form, a file, a missing page, a <route>.html beside the folder', () => {
    expect(get('/fr/a-propos/')).toBeNull()
    expect(get('/assets/app.js')).toBeNull()
    expect(get('/assets')).toBeNull()
    expect(get('/nothing')).toBeNull()
    writeFileSync(join(dist, 'about.html'), '<html></html>')
    expect(get('/about')).toBeNull()
  })

  it('never leaves the output directory, and answers only GET and HEAD', () => {
    expect(get('/..%2F..%2Fetc')).toBeNull()
    expect(get('/%E0%A4%A')).toBeNull()
    expect(directoryIndexUrl({ method: 'POST', url: '/about' }, dist)).toBeNull()
    expect(directoryIndexUrl({ method: 'HEAD', url: '/about' }, dist)).toBe('/about/index.html')
  })

  it('the plugin installs it on the preview server only', () => {
    const plugin = previewDirectoryIndexPlugin()
    expect(plugin.configureServer).toBeUndefined()
    const used = []
    plugin.configurePreviewServer({
      config: { root: dist, base: '/', build: { outDir: '.' } },
      middlewares: { use: (fn) => used.push(fn) },
    })
    const req = { method: 'GET', url: '/fr/a-propos' }
    used[0](req, {}, () => {})
    expect(req.url).toBe('/fr/a-propos/index.html')
  })
})
