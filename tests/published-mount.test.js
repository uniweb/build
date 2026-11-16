/**
 * `uniweb dev --published` — a working copy served against the services of the site as published.
 *
 * The dev server is handed the host's services block a published page carries, answers each
 * service at an address of its own, and forwards to the published address: same-origin, so a
 * sign-in cookie is first-party, and nothing composed, so whatever serves the site is what the
 * copy talks to. Exercised here against a stand-in host on a real socket.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PUBLISHED_ENV, PUBLISHED_MOUNT, encodePublished, readPublished, localServices, queriesInFull } from '../src/site/published.js'
import { mountPublished, firstPartyCookie } from '../src/dev/published-mount.js'
import { siteContentPlugin } from '../src/site/plugin.js'

/** A Vite-shaped dev server: collects middleware, and calls it in order. */
function fakeServer() {
  const stack = []
  return {
    middlewares: { use: (fn) => stack.push(fn) },
    ssrLoadModule: (href) => import(href),
    stack,
    async call(url, { method = 'GET', headers = {}, body } = {}) {
      const req = { url, method, headers: { host: 'localhost:5173', ...headers } }
      req[Symbol.asyncIterator] = async function* () {
        if (body) yield Buffer.from(body)
      }
      const res = {
        statusCode: 0,
        headers: {},
        body: undefined,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v },
        end(b) { this.body = b },
      }
      let passed = false
      for (const fn of stack) await fn(req, res, () => { passed = true })
      return { ...res, passed, text: res.body ? Buffer.from(res.body).toString('utf8') : '' }
    },
  }
}

/** A stand-in for the host a published site is on: it says what it was asked, and sets a cookie. */
async function standInHost() {
  const asked = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    asked.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.setHeader('content-type', 'application/json')
    res.setHeader('set-cookie', ['sid=abc; Domain=site.test; Path=/_api; Secure; HttpOnly; SameSite=None', '__Host-csrf=x; Path=/; Secure; SameSite=Strict'])
    res.end(JSON.stringify({ ok: true, url: req.url }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, asked, close: () => new Promise((resolve) => server.close(resolve)) }
}

describe('what the dev server is handed', () => {
  it('reads nothing when nothing is set, and refuses a value that says nothing usable', () => {
    expect(readPublished({})).toBeNull()
    expect(() => readPublished({ [PUBLISHED_ENV]: '{"site":"localhost:8080"}' })).toThrow(/uniweb dev --published/)
  })

  it('round-trips through the variable', () => {
    const value = encodePublished({ site: 'http://s.localhost:8080/', backend: 'http://localhost:8080', services: { backend: '/_api' } })
    expect(readPublished({ [PUBLISHED_ENV]: value })).toEqual({
      site: 'http://s.localhost:8080/',
      backend: 'http://localhost:8080',
      base: null,
      services: { backend: '/_api' },
    })
  })
})

describe('localServices — the host block, at the dev server’s own addresses', () => {
  const site = 'https://acme.example/'

  it('⭐ keeps each address after its origin as written, a `{locale}` slot included', () => {
    const { services, targets } = localServices({
      site,
      services: {
        backend: '/_api',
        records: { endpoint: '/_query/{locale}' },
        tracking: { endpoint: '/_a/e', events: ['page_view'] },
      },
    })
    expect(services).toEqual({
      backend: `${PUBLISHED_MOUNT}/backend/_api`,
      records: { endpoint: `${PUBLISHED_MOUNT}/records/_query/{locale}` },
      tracking: { endpoint: `${PUBLISHED_MOUNT}/tracking/_a/e`, events: ['page_view'] },
    })
    expect(targets).toEqual({ backend: 'https://acme.example', records: 'https://acme.example', tracking: 'https://acme.example' })
  })

  it('forwards an absolute address to its own origin, and joins a relative one to the published base', () => {
    const { services, targets } = localServices({
      site,
      base: '/docs/',
      services: { backend: 'https://api.other.example/v1', search: '_search' },
    })
    expect(services).toEqual({ backend: `${PUBLISHED_MOUNT}/backend/v1`, search: `${PUBLISHED_MOUNT}/search/docs/_search` })
    expect(targets).toEqual({ backend: 'https://api.other.example', search: 'https://acme.example' })
  })

  it('carries a service the host names with no address as it is: the host answered, and offered none', () => {
    const { services, targets } = localServices({ site, services: { submit: null, assistant: false } })
    expect(services).toEqual({ submit: null, assistant: false })
    expect(targets).toEqual({})
  })
})

describe('queriesInFull — the site’s queries, named as the published page names them', () => {
  it('⭐ names each `@/x` type in full, with the scope of the foundation’s name', () => {
    const queries = {
      courses: { schema: '@/course', sort: 'order asc' },
      people: { schema: '@std/person' },
      posts: { schema: 'post' },
    }
    expect(queriesInFull(queries, '@acme')).toEqual({
      courses: { schema: '@acme/course', sort: 'order asc' },
      people: { schema: '@std/person' },
      posts: { schema: 'post' },
    })
    // The copy's own declarations are not changed in place.
    expect(queries.courses.schema).toBe('@/course')
  })

  it('leaves every query as written when the foundation’s name has no scope', () => {
    const queries = { courses: { schema: '@/course' } }
    expect(queriesInFull(queries, null)).toBe(queries)
    expect(queriesInFull(undefined, '@acme')).toBeUndefined()
  })
})

describe('mountPublished — forwarding, same-origin', () => {
  let host

  afterEach(async () => {
    await host?.close()
    host = undefined
  })

  async function mounted({ base = '/' } = {}) {
    host = await standInHost()
    const server = fakeServer()
    mountPublished(server, { targets: { backend: host.origin }, site: 'http://acme.localhost:8080/', base, log: () => {} })
    return server
  }

  it('⭐ sends the request on as the published page would, and keeps its cookies first-party', async () => {
    const server = await mounted()
    const res = await server.call(`${PUBLISHED_MOUNT}/backend/_api/session?x=1`, {
      headers: { cookie: 'sid=abc', origin: 'http://localhost:5173', referer: 'http://localhost:5173/members', 'x-uniweb-csrf': 't' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ ok: true, url: '/_api/session?x=1' })
    const [asked] = host.asked
    expect(asked.headers).toMatchObject({ cookie: 'sid=abc', origin: 'http://acme.localhost:8080', 'x-uniweb-csrf': 't' })
    // The dev server's own name and page stay behind.
    expect(asked.headers.host).toBe(new URL(host.origin).host)
    expect(asked.headers.referer).toBeUndefined()
    // Over plain http a cookie keeps no `Domain`, takes the whole path, and gives up `Secure` —
    // unless its name requires it.
    expect(res.headers['set-cookie']).toEqual([
      'sid=abc; Path=/; HttpOnly; SameSite=Lax',
      '__Host-csrf=x; Path=/; Secure; SameSite=Strict',
    ])
  })

  it('forwards a body, and a request that still carries the site’s base path', async () => {
    const server = await mounted({ base: '/docs/' })
    const res = await server.call(`/docs${PUBLISHED_MOUNT}/backend/_api/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"schema":"@acme/track"}',
    })
    expect(res.statusCode).toBe(200)
    expect(host.asked[0]).toMatchObject({ method: 'POST', url: '/_api/entities', body: '{"schema":"@acme/track"}' })
  })

  it('leaves every other address to the dev server, and says so for a service the site does not have', async () => {
    const server = await mounted()
    expect((await server.call('/members')).passed).toBe(true)
    const res = await server.call(`${PUBLISHED_MOUNT}/search/x`)
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.text)).toMatchObject({ title: 'No Such Service' })
    expect(host.asked).toEqual([])
  })

  it('says which origin it could not reach, rather than hanging or answering HTML', async () => {
    const server = fakeServer()
    mountPublished(server, { targets: { backend: 'http://127.0.0.1:9' }, site: 'http://acme.localhost:8080/', log: () => {} })
    const res = await server.call(`${PUBLISHED_MOUNT}/backend/_api/session`)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.text)).toMatchObject({ title: 'Published Site Unreachable' })
  })

  it('a cookie over https keeps everything but its domain and path', () => {
    expect(firstPartyCookie('sid=abc; Domain=site.test; Path=/_api; Secure; HttpOnly; SameSite=None', { secure: true })).toBe(
      'sid=abc; Path=/; Secure; HttpOnly; SameSite=None'
    )
  })
})

describe('the dev payload under `--published`', () => {
  let root
  const saved = [console.log, console.warn]

  afterEach(async () => {
    ;[console.log, console.warn] = saved
    delete process.env[PUBLISHED_ENV]
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** Drive the site plugin in Vite's dev order — configureServer, then buildStart. */
  async function devPayload(yml, { files = {}, foundationName } = {}) {
    root = await mkdtemp(join(tmpdir(), 'uniweb-published-payload-'))
    await writeFile(join(root, 'site.yml'), yml)
    await mkdir(join(root, 'mock'), { recursive: true })
    await writeFile(join(root, 'mock', 'api.js'), 'export default () => new Response("{}")\n')
    await mkdir(join(root, 'pages', 'home'), { recursive: true })
    await writeFile(join(root, 'pages', 'home', '1-hero.md'), '---\ntype: Hero\n---\n# Home\n')
    for (const [rel, body] of Object.entries(files)) await writeFile(join(root, rel), body)
    // A foundation beside the site, named as `main.js` names it.
    let foundationPath
    if (foundationName) {
      foundationPath = join(root, 'foundation')
      await mkdir(foundationPath, { recursive: true })
      await writeFile(
        join(foundationPath, 'package.json'),
        JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js' })
      )
      await writeFile(join(foundationPath, 'main.js'), `export default { name: '${foundationName}' }\n`)
    }
    console.log = () => {}
    console.warn = () => {}
    const plugin = siteContentPlugin({ sitePath: './', foundationPath })
    await plugin.configResolved({ root, publicDir: join(root, 'public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
    const server = { ...fakeServer(), ws: { send: () => {} } }
    plugin.configureServer(server)
    await plugin.buildStart()
    const html = await plugin.transformIndexHtml('<html><head></head><body></body></html>', {})
    plugin.closeBundle()
    const json = html.match(/<script type="application\/json" id="__SITE_CONTENT__">(.*?)<\/script>/s)?.[1]
    return { content: JSON.parse(json.replace(/\\u003c/g, '<')), server }
  }

  it('⭐ carries the published host block at the dev server’s addresses, and mounts no mock', async () => {
    process.env[PUBLISHED_ENV] = encodePublished({
      site: 'http://acme.localhost:8080/',
      backend: 'http://localhost:8080',
      services: { backend: '/_api', records: { endpoint: '/_query/{locale}' } },
    })
    const { content, server } = await devPayload('name: S\nservices:\n  backend: true\n$devBackend: ./mock/api.js\n')
    expect(content.config.services).toEqual({
      backend: `${PUBLISHED_MOUNT}/backend/_api`,
      records: { endpoint: `${PUBLISHED_MOUNT}/records/_query/{locale}` },
    })
    // The mock's address is not the site's: the published site's backend answers.
    expect(content.config.backend).toBeUndefined()
    expect((await server.call('/_api/session')).passed).toBe(true)
  })

  it('⭐ names the site’s query types in full, as the published page does', async () => {
    process.env[PUBLISHED_ENV] = encodePublished({
      site: 'http://acme.localhost:8080/',
      backend: 'http://localhost:8080',
      services: { records: { endpoint: '/_query/{locale}' } },
    })
    const { content } = await devPayload('name: S\nservices:\n  records: true\n', {
      files: { 'queries.yml': "courses:\n  schema: '@/course'\n  sort: order asc\n" },
      foundationName: '@acme/courses',
    })
    expect(content.config.queries.courses).toMatchObject({ schema: '@acme/course' })
  })

  it('control: a working copy without it keeps `@/x`, which its own files answer', async () => {
    const { content } = await devPayload('name: S\nservices:\n  records: true\n', {
      files: { 'queries.yml': "courses:\n  schema: '@/course'\n  sort: order asc\n" },
      foundationName: '@acme/courses',
    })
    expect(content.config.queries.courses).toMatchObject({ schema: '@/course' })
  })

  it('control: without it, `$devBackend` answers and the payload carries no host block', async () => {
    const { content } = await devPayload('name: S\nservices:\n  backend: true\n$devBackend: ./mock/api.js\n')
    expect(content.config.backend).toBe('/_api')
    expect(content.config.services).toBeUndefined()
  })
})
