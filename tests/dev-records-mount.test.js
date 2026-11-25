/**
 * `uniweb dev` as a site's host for its records: `$devBackend.records` names a backend's public
 * records, and the dev server answers the site's records service itself, merging its record files
 * with that backend's answer.
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mountDevRecords, DEV_RECORDS_ADDRESS } from '../src/dev/records-mount.js'
import { answerFromFiles } from '../src/dev/records-files.js'
import { devBackendParts, devRecordsAddress, siteServiceNames } from '../src/dev/api-mount.js'

/** A stand-in backend on a real socket: answers each key from `answers`, and records what it was asked. */
async function backend(answer) {
  const asked = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      asked.push({ url: req.url, body, cookie: req.headers.cookie, authorization: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer(body)))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    asked,
    address: `http://127.0.0.1:${server.address().port}/records/{locale}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

function mounted(options) {
  const stack = []
  mountDevRecords({ middlewares: { use: (fn) => stack.push(fn) } }, { log: () => {}, ...options })
  return async (body, { url = `${DEV_RECORDS_ADDRESS}/en`, method = 'POST', headers = {} } = {}) => {
    const req = { url, method, headers }
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    let passed = false
    for (const fn of stack) await fn(req, res, () => { passed = true })
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, passed }
  }
}

describe('mountDevRecords', () => {
  let engine
  afterEach(async () => {
    if (engine) await engine.close()
    engine = undefined
  })

  it('⭐ asks both sources the whole question and answers each key merged, as a records service does', async () => {
    engine = await backend((body) => ({ data: { events: [{ $uuid: 'e1', title: 'Été' }] } }))
    const files = []
    const ask = mounted({
      address: engine.address,
      answerFiles: async (p) => {
        files.push(p)
        return { records: [{ $name: 'apple', title: 'apple' }, { $name: 'zoo', title: 'Zoo' }], whole: false, cursor: null }
      },
    })
    const question = { schema: '@acme/event', sort: 'title' }
    const res = await ask({ events: question }, { url: `${DEV_RECORDS_ADDRESS}/fr` })
    expect(res.status).toBe(200)
    expect(res.json.data.events.map((r) => r.$name ?? r.$uuid)).toEqual(['apple', 'e1', 'zoo'])
    // The backend got the question as written, its language in the address, and no credential.
    expect(engine.asked).toHaveLength(1)
    expect(engine.asked[0]).toMatchObject({ url: '/records/fr', body: { events: question } })
    expect(engine.asked[0].cookie).toBeUndefined()
    expect(engine.asked[0].authorization).toBeUndefined()
    expect(files[0]).toMatchObject({ key: 'events', question, locale: 'fr', offset: 0 })
  })

  it('⭐ pages in the one source that delivered: the cursor seals the backend’s token, and resumes it alone', async () => {
    engine = await backend((body) =>
      body.events.narrow?.cursor === 'engine-token'
        ? { data: { events: [{ $uuid: 'e3' }] } }
        : { data: { events: [{ $uuid: 'e1' }, { $uuid: 'e2' }] }, cursors: { events: 'engine-token' } }
    )
    let filesAsked = 0
    const ask = mounted({
      address: engine.address,
      answerFiles: async () => {
        filesAsked += 1
        return { records: [], whole: false, cursor: null }
      },
    })
    const first = await ask({ events: { schema: '@acme/event', narrow: { limit: 2 } } })
    const cursor = first.json.cursors?.events
    expect(cursor).toMatch(/^dev1\./)
    expect(cursor).not.toContain('engine-token')

    const next = await ask({ events: { schema: '@acme/event', narrow: { limit: 2, cursor } } })
    expect(next.json.data.events).toEqual([{ $uuid: 'e3' }])
    expect(engine.asked[1].body.events.narrow.cursor).toBe('engine-token')
    expect(filesAsked).toBe(1)
  })

  it('pages the files alone when only they delivered', async () => {
    engine = await backend(() => ({ data: { events: [] } }))
    const offsets = []
    const ask = mounted({
      address: engine.address,
      answerFiles: async ({ offset }) => {
        offsets.push(offset)
        return offset ? { records: [{ $name: 'f3' }], whole: false, cursor: null } : { records: [{ $name: 'f1' }, { $name: 'f2' }], whole: false, cursor: 2 }
      },
    })
    const first = await ask({ events: { schema: '@acme/event', narrow: { limit: 2 } } })
    const next = await ask({ events: { schema: '@acme/event', narrow: { limit: 2, cursor: first.json.cursors.events } } })
    expect(next.json.data.events).toEqual([{ $name: 'f3' }])
    expect(offsets).toEqual([0, 2])
    expect(engine.asked).toHaveLength(1)
  })

  it('⭐ a backend that doesn’t answer leaves each key the files’ answer, and says so in `partial`', async () => {
    const ask = mounted({
      address: 'http://127.0.0.1:1/records/{locale}',
      answerFiles: async () => ({ records: [{ $name: 'f1' }], whole: false, cursor: null }),
    })
    const res = await ask({ events: { schema: '@acme/event' } })
    expect(res.status).toBe(200)
    expect(res.json.data.events).toEqual([{ $name: 'f1' }])
    expect(res.json.partial.events).toMatchObject({ source: 'engine', code: 'unreachable' })
  })

  it('a key missing from the backend’s answer is partial, not empty', async () => {
    engine = await backend(() => ({ data: {} }))
    const ask = mounted({ address: engine.address, answerFiles: async () => ({ records: [], whole: false, cursor: null }) })
    const res = await ask({ events: { schema: '@acme/event' } })
    expect(res.json.partial.events).toMatchObject({ source: 'engine', code: 'missing-key' })
  })

  it('refuses what is not a records request, and passes other paths through', async () => {
    const ask = mounted({ address: 'http://127.0.0.1:1/x/{locale}', answerFiles: async () => ({ records: [] }) })
    expect((await ask('[1]')).status).toBe(400)
    expect((await ask({}, { method: 'GET' })).status).toBe(405)
    expect((await ask({}, { url: '/_recordsx/en' })).passed).toBe(true)
  })
})

describe('answerFromFiles', () => {
  // The compiled list a query's file holds — briefs with the branch a `scope` reads — and each record's own file.
  const files = {
    'events.json': [
      { $name: 'b', title: 'Beta', $branch: 'past' },
      { $name: 'a', title: 'Alpha', $branch: '' },
      { $name: 'c', title: 'Gamma', $branch: '' },
    ],
    'events/a.json': { $name: 'a', identity: { title: 'Alpha' }, details: { room: 1 } },
    'events/b.json': { $name: 'b', identity: { title: 'Beta' }, details: { room: 3 } },
    'events/c.json': { $name: 'c', identity: { title: 'Gamma' }, details: { room: 2 } },
    'other.json': [{ $name: 'z' }],
  }
  const read = async (_locale, file) => (file in files ? structuredClone(files[file]) : null)
  const queries = { events: { schema: '@acme/event' }, other: { schema: '@acme/other' } }

  it('⭐ evaluates the question over the query’s compiled list, as a page does with no records service', async () => {
    const all = await answerFromFiles({ key: 'events', question: { schema: '@acme/event', sort: 'title' }, locale: 'en', queries, read })
    expect(all.records.map((r) => r.$name)).toEqual(['a', 'b', 'c'])
    const out = await answerFromFiles({ key: 'events', question: { schema: '@acme/event', scope: 'past' }, locale: 'en', queries, read })
    expect(out.records.map((r) => r.$name)).toEqual(['b'])
    expect(out.records[0].$branch).toBeUndefined()
    expect(out.whole).toBe(false)
  })

  it('⭐ answers a whole question from each record’s own file', async () => {
    const out = await answerFromFiles({ key: 'events', question: { schema: '@acme/event', sort: '-title', narrow: { limit: 2 }, whole: true }, locale: 'en', queries, read })
    expect(out.records).toEqual([files['events/c.json'], files['events/b.json']])
    expect(out.whole).toBe(true)
    // A record whose own file is missing is delivered as its list holds it, and the key isn't whole.
    const missing = await answerFromFiles({ key: 'events', question: { schema: '@acme/event', whole: true }, locale: 'en', queries, read: async (l, f) => (f === 'events/b.json' ? null : read(l, f)) })
    expect(missing.whole).toBe(false)
  })

  it('pages by `narrow.limit`, and resumes at the offset its cursor gave', async () => {
    const q = { schema: '@acme/event', sort: 'title', narrow: { limit: 2 } }
    const first = await answerFromFiles({ key: 'events', question: q, locale: 'en', queries, read })
    expect([first.records.map((r) => r.$name), first.cursor]).toEqual([['a', 'b'], 2])
    const next = await answerFromFiles({ key: 'events', question: q, locale: 'en', queries, read, offset: 2 })
    expect([next.records.map((r) => r.$name), next.cursor]).toEqual([['c'], null])
  })

  it('a type no query of the site reads answers [] from the files', async () => {
    expect((await answerFromFiles({ key: 'x', question: { schema: '@acme/nobody' }, locale: 'en', queries, read })).records).toEqual([])
  })

  it('reads the file of the query the key names, else the first of the type', async () => {
    const both = { first: { schema: '@acme/event' }, events: { schema: '@acme/event' } }
    const seen = []
    const spy = async (l, file) => (seen.push(file), read(l, file))
    await answerFromFiles({ key: 'events', question: { schema: '@acme/event' }, locale: 'en', queries: both, read: spy })
    await answerFromFiles({ key: 'mine', question: { schema: '@acme/event' }, locale: 'en', queries: both, read: spy })
    expect(seen).toEqual(['events.json', 'first.json'])
  })
})

describe('`$devBackend`’s map form', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const site = (yml) => {
    dir = mkdtempSync(join(tmpdir(), 'uw-dev-records-'))
    writeFileSync(join(dir, 'site.yml'), yml)
    return dir
  }

  it('names each service the backend answers; the string form is `backend` alone', () => {
    expect(devBackendParts('./mock/api.js')).toEqual({ backend: './mock/api.js', records: null })
    expect(devBackendParts({ backend: 'http://l/api', records: 'http://l/q/{locale}' })).toEqual({ backend: 'http://l/api', records: 'http://l/q/{locale}' })
    expect(() => devBackendParts({ backend: 'x', search: 'y' })).toThrow(/not `search:`/)
  })

  it('⛔ a records address is http(s) and has its {locale} slot', () => {
    expect(devRecordsAddress(site('$devBackend:\n  records: http://localhost:1234/records/{locale}\n'))).toBe('http://localhost:1234/records/{locale}')
    expect(() => devRecordsAddress(site('$devBackend:\n  records: http://localhost:1234/records\n'))).toThrow(/no \{locale\} slot/)
    expect(() => devRecordsAddress(site('$devBackend:\n  records: localhost:1234/q/{locale}\n'))).toThrow(/not an http\(s\) address/)
    expect(devRecordsAddress(site('$devBackend: ./mock/api.js\n'))).toBeNull()
  })

  it('reads the services site.yml names', () => {
    expect(siteServiceNames(site('services:\n  backend: true\n  submit: https://f.example/x\n'))).toEqual(['backend', 'submit'])
  })
})

describe('the dev payload, with a backend’s records', () => {
  let root
  let saved
  beforeEach(() => {
    saved = [console.log, console.warn]
    console.log = () => {}
    console.warn = () => {}
  })
  afterEach(() => {
    ;[console.log, console.warn] = saved
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  async function payload(siteYml) {
    root = mkdtempSync(join(tmpdir(), 'uw-dev-records-site-'))
    const files = {
      'site/site.yml': siteYml,
      'site/queries.yml': 'events:\n  schema: "@/event"\n',
      'site/pages/home/1-hero.md': '---\ntype: Hero\n---\n# Home\n',
      'src/package.json': JSON.stringify({ name: '@acme/marketing', type: 'module', main: './_entry.generated.js' }),
      'src/main.js': "export default { name: '@acme/marketing' }\n",
      'src/schemas/event.yml': 'fields:\n  title: { type: string }\n',
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    const { siteContentPlugin } = await import('../src/site/plugin.js')
    const plugin = siteContentPlugin({ sitePath: './', foundationPath: join(root, 'src') })
    const site = join(root, 'site')
    await plugin.configResolved({ root: site, publicDir: join(site, 'public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
    plugin.configureServer({ middlewares: { use: () => {} }, ssrLoadModule: (href) => import(href), ws: { send: () => {} } })
    await plugin.buildStart()
    const html = await plugin.transformIndexHtml('<html><head></head><body></body></html>', {})
    plugin.closeBundle()
    const json = html.match(/<script type="application\/json" id="__SITE_CONTENT__">(.*?)<\/script>/s)?.[1]
    return JSON.parse(json.replace(/\\u003c/g, '<')).config
  }

  const engineSite = (extra = '') =>
    'name: S\nservices:\n  backend: true\n  submit: https://forms.example.com/f/abc\n' + extra +
    '$devBackend:\n  backend: http://localhost:1234/api\n  records: http://localhost:1234/records/{locale}\n'

  it('⭐ carries a host block: its records, its own addresses, search, and the site’s own addresses', async () => {
    const config = await payload(engineSite())
    expect(config.services).toEqual({
      records: `${DEV_RECORDS_ADDRESS}/{locale}`,
      backend: '/_api',
      submit: 'https://forms.example.com/f/abc',
      search: '/_search',
    })
  })

  it('⭐ names the site’s queries in full, as the backend holds their types', async () => {
    const config = await payload(engineSite())
    expect(config.queries.events.schema).toBe('@acme/event')
  })

  it('a site that switched search off gets none', async () => {
    const config = await payload(engineSite('  search: false\n'))
    expect(config.services.search).toBeUndefined()
  })

  it('CONTROL — without `records`, no host block, as before', async () => {
    const config = await payload('name: S\nservices:\n  backend: true\n$devBackend: http://localhost:1234/api\n')
    expect(config.services).toBeUndefined()
    expect(config.backend).toBe('/_api')
  })
})
