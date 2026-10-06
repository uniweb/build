/**
 * `$devApi` — a site's own backend, answered locally.
 *
 * ⭐ The framework mounts; the site supplies. This module knows nothing about what
 * it mounts — not the routes, not the shapes, not which backend is being imitated —
 * and that is load-bearing: the moment the framework knows what a "mock backend"
 * is, it has a favourite one, and a site talking to anything else becomes a
 * second-class citizen in its own dev server.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDevApi, DEV_API_ADDRESS } from '../src/dev/api-mount.js'
import { siteContentPlugin } from '../src/site/plugin.js'

/** A Vite-shaped dev server: collects middleware, and loads modules by URL. */
function fakeServer() {
  const stack = []
  return {
    middlewares: { use: (fn) => stack.push(fn) },
    ssrLoadModule: (href) => import(href),
    stack,
    async call(url, { method = 'GET', body } = {}) {
      const req = { url, method, headers: { host: 'site.test' } }
      if (body) {
        req[Symbol.asyncIterator] = async function* () {
          yield Buffer.from(body)
        }
      }
      const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
      let passed = false
      for (const fn of stack) await fn(req, res, () => { passed = true })
      return { ...res, passed }
    },
  }
}

describe('mountDevApi', () => {
  let dir

  async function site(yml, handler) {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-devapi-'))
    await writeFile(join(dir, 'site.yml'), yml)
    if (handler) {
      await mkdir(join(dir, 'mock'), { recursive: true })
      await writeFile(join(dir, 'mock', 'api.js'), handler)
    }
    return dir
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  const echo = `export default (request) => {
    const url = new URL(request.url)
    return new Response(JSON.stringify({ path: url.pathname, method: request.method }), {
      headers: { 'content-type': 'application/json' },
    })
  }`

  it('⭐ mounts the handler at the dev server’s own address, and says which', async () => {
    // In `uniweb dev` the dev server is the host: the address is its own, and the site
    // writes none — `api:` under `services:` would read as "the site brings its own".
    const root = await site('name: S\nservices:\n  api: true\n$devApi: ./mock/api.js\n', echo)
    const server = fakeServer()
    expect(mountDevApi(server, { root })).toBe(DEV_API_ADDRESS)
    expect(DEV_API_ADDRESS).toBe('/_api')

    const res = await server.call('/_api/entities?model=x')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ path: '/entities', method: 'GET' })
  })

  it('⭐ strips the mount point, so a handler is not written against one deployment’s prefix', async () => {
    // Where a backend is exposed is the host's business. A handler that saw
    // `/_api/entities` would break the moment a deployment chose another prefix.
    const root = await site('name: S\n$devApi: ./mock/api.js\n', echo)
    const server = fakeServer()
    mountDevApi(server, { root })
    expect(JSON.parse((await server.call('/_api/entities')).body).path).toBe('/entities')
  })

  it('passes everything outside the mount straight through', async () => {
    const root = await site('name: S\n$devApi: ./mock/api.js\n', echo)
    const server = fakeServer()
    mountDevApi(server, { root })
    expect((await server.call('/pages/home')).passed).toBe(true)
    // ⚠️ And a path that merely starts with the same letters is not the mount.
    expect((await server.call('/_apiary')).passed).toBe(true)
  })

  it('does nothing without $devApi — the ordinary site', async () => {
    const root = await site('name: S\n')
    const server = fakeServer()
    expect(mountDevApi(server, { root })).toBeNull()
    expect(server.stack).toHaveLength(0)
  })

  it('says so loudly when the module cannot be loaded — on the first request', async () => {
    // ⚠️ The mount itself succeeds: the middleware must be on the stack BEFORE
    // Vite's own, so the module load is deferred to the first request. The failure
    // is therefore a 500 with a reason, not a silent pass-through to the SPA
    // fallback — which would answer the API with index.html and explain nothing.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = await site('name: S\n$devApi: ./mock/missing.js\n')
    const server = fakeServer()
    expect(mountDevApi(server, { root })).toBe(DEV_API_ADDRESS)

    const res = await server.call('/_api/x')
    expect(res.statusCode).toBe(500)
    expect(res.passed).toBe(false)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('missing.js'))
    err.mockRestore()
  })

  it('does not fall through to the SPA when the handler is broken', async () => {
    // The failure mode this guards: a pass-through here means the client gets a
    // 200 of HTML from the SPA fallback and fails to parse it, with nothing in the
    // log naming the API as the cause.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = await site('name: S\n$devApi: ./mock/api.js\n', 'export default 42')
    const server = fakeServer()
    mountDevApi(server, { root })
    const res = await server.call('/_api/x')
    expect(res.passed).toBe(false)
    expect(res.statusCode).toBe(500)
    err.mockRestore()
  })

  it('answers 500 rather than hanging when a handler throws', async () => {
    const root = await site('name: S\n$devApi: ./mock/api.js\n', 'export default () => { throw new Error("boom") }')
    const server = fakeServer()
    mountDevApi(server, { root })
    const res = await server.call('/_api/x')
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).detail).toBe('boom')
  })
})

describe('the payload `uniweb dev` serves names the address', () => {
  // ⭐ The dev server supplies the address, and the site writes none: under `services:` an
  // address means a provider the site brings, which asks a host to leave its own off. So
  // the dev payload carries it as the site tier — `config.api`, which `resolveService`
  // reads when no host speaks.
  let root
  let saved

  beforeEach(() => {
    saved = [console.log, console.warn]
    console.log = () => {}
    console.warn = () => {}
  })
  afterEach(async () => {
    ;[console.log, console.warn] = saved
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** Drive the site plugin in Vite's dev order — configureServer, then buildStart. */
  async function devPayload(yml) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-devapi-payload-'))
    await writeFile(join(root, 'site.yml'), yml)
    await mkdir(join(root, 'mock'), { recursive: true })
    await writeFile(join(root, 'mock', 'api.js'), 'export default () => new Response("{}")\n')
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')

    const plugin = siteContentPlugin({ sitePath: './' })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
    plugin.configureServer({ ...fakeServer(), ws: { send: () => {} } })
    await plugin.buildStart()
    const html = await plugin.transformIndexHtml('<html><head></head><body></body></html>', {})
    plugin.closeBundle()
    const json = html.match(/<script type="application\/json" id="__SITE_CONTENT__">(.*?)<\/script>/s)?.[1]
    return JSON.parse(json.replace(/\\u003c/g, '<'))
  }

  it('⭐ `$devApi` puts the dev server’s own address in config.api', async () => {
    const content = await devPayload('name: S\nservices:\n  api: true\n$devApi: ./mock/api.js\n')
    expect(content.config.api).toBe(DEV_API_ADDRESS)
    // Never the host tier, and the `$` key itself stays on this machine.
    expect(content.config.services).toBeUndefined()
    expect(content.config.$devApi).toBeUndefined()
  })

  it('CONTROL — without `$devApi` there is no address: `api: true` asks a host, and none speaks here', async () => {
    const content = await devPayload('name: S\nservices:\n  api: true\n')
    expect(content.config.api).toBeUndefined()
  })
})
