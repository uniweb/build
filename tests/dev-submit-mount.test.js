/**
 * `uniweb dev` takes a site's forms when site.yml asks its host for them.
 *
 * ⭐ `services: { submit: true }` asks the HOST, and a component draws a form only when
 * something answers. In development the dev server is the host — so it answers, and a
 * form can be seen, filled in and sent before the site is published.
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDevSubmit, DEV_SUBMIT_ADDRESS, DEV_SUBMISSIONS_DIR } from '../src/dev/submit-mount.js'
import { siteContentPlugin } from '../src/site/plugin.js'

/** A Vite-shaped dev server: collects middleware and runs a request through it. */
function fakeServer() {
  const stack = []
  return {
    middlewares: { use: (fn) => stack.push(fn) },
    stack,
    async call(url, { method = 'POST', body, headers = {} } = {}) {
      const req = { url, method, headers: { host: 'site.test', ...headers } }
      req[Symbol.asyncIterator] = async function* () {
        if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      }
      const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
      let passed = false
      for (const fn of stack) await fn(req, res, () => { passed = true })
      return { ...res, json: res.body ? JSON.parse(res.body) : undefined, passed }
    },
  }
}

describe('mountDevSubmit', () => {
  let dir
  const lines = []
  const log = (line) => lines.push(line)

  async function site(yml) {
    dir = await mkdtemp(join(tmpdir(), 'uniweb-devsubmit-'))
    await writeFile(join(dir, 'site.yml'), yml)
    return dir
  }
  const kept = async () => (await readdir(join(dir, DEV_SUBMISSIONS_DIR))).filter((f) => f.endsWith('.json'))

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
    lines.length = 0
  })

  it('⭐ answers when the site asks its host for form handling, at the dev server’s own address', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    expect(mountDevSubmit(server, { root, log })).toBe(DEV_SUBMIT_ADDRESS)
    expect(DEV_SUBMIT_ADDRESS).toBe('/_submit')
    expect(server.stack).toHaveLength(1)
  })

  it.each([
    ['no services', 'name: S\n'],
    ['submit: false', 'name: S\nservices:\n  submit: false\n'],
    // An address is the site's own provider — it answers itself, in dev as everywhere.
    ['an address of its own', 'name: S\nservices:\n  submit: https://forms.example.com/f/abc\n'],
    ['an address as a map', 'name: S\nservices:\n  submit:\n    endpoint: /forms\n'],
  ])('answers nothing for %s', async (_, yml) => {
    const root = await site(yml)
    const server = fakeServer()
    expect(mountDevSubmit(server, { root, log })).toBeNull()
    expect(server.stack).toHaveLength(0)
  })

  it('⭐ keeps each submission whole, says so in the terminal, and returns its id', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    mountDevSubmit(server, { root, log })

    const res = await server.call('/_submit', {
      body: {
        formData: { name: 'Ada', email: 'ada@example.com', agent: true },
        formId: 'viewing',
        metadata: { sectionType: 'Visit', preview: { title: 'Ada', subtitle: 'ada@example.com', tag: 'viewing' } },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.passed).toBe(false)
    const { submissionId } = res.json
    expect(submissionId).toBeTruthy()

    const [file] = await kept()
    expect(file).toBe(`${submissionId}.json`)
    const record = JSON.parse(await readFile(join(dir, DEV_SUBMISSIONS_DIR, file), 'utf8'))
    expect(record).toMatchObject({
      submissionId,
      formId: 'viewing',
      formData: { name: 'Ada', email: 'ada@example.com', agent: true },
      metadata: { sectionType: 'Visit' },
      files: [],
    })
    expect(lines.at(-1)).toMatch(/viewing — Ada · ada@example\.com \(3 answers\)/)
  })

  it('takes attachments the way kit sends them: manifest, upload per slot, finalize', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    mountDevSubmit(server, { root, log })

    const { json } = await server.call('/_submit', {
      body: { formData: { note: 'see attached' }, fileSlots: [{ name: 'plan.pdf', size: 4, mime: 'application/pdf' }] },
    })
    const headers = { 'x-submission-id': json.submissionId, 'x-slot': '0' }
    expect((await server.call('/_submit/upload', { body: Buffer.from('%PDF'), headers })).statusCode).toBe(200)
    expect((await server.call('/_submit/finalize', { body: { submissionId: json.submissionId } })).statusCode).toBe(200)

    const saved = await readFile(join(dir, DEV_SUBMISSIONS_DIR, json.submissionId, '0-plan.pdf'), 'utf8')
    expect(saved).toBe('%PDF')
    expect(lines.at(-1)).toMatch(/1 attachment/)
  })

  it('⛔ keeps an attachment’s name, never its path', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    mountDevSubmit(server, { root, log })
    const { json } = await server.call('/_submit', { body: { formData: {}, fileSlots: [{ name: '../../escape.txt', size: 1 }] } })
    await server.call('/_submit/upload', { body: 'x', headers: { 'x-submission-id': json.submissionId, 'x-slot': '0' } })
    expect(await readdir(join(dir, DEV_SUBMISSIONS_DIR, json.submissionId))).toEqual(['0-escape.txt'])
  })

  it('refuses what kit never sends: another method, a body that is not JSON, no answers, an unknown slot', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    mountDevSubmit(server, { root, log })
    expect((await server.call('/_submit', { method: 'GET' })).statusCode).toBe(405)
    expect((await server.call('/_submit', { body: 'not json' })).statusCode).toBe(400)
    expect((await server.call('/_submit', { body: { formId: 'x' } })).statusCode).toBe(400)
    expect((await server.call('/_submit/upload', { body: 'x', headers: { 'x-submission-id': 'nope', 'x-slot': '0' } })).statusCode).toBe(400)
  })

  it('passes everything else through, and finds its address under the site’s base path', async () => {
    const root = await site('name: S\nservices:\n  submit: true\n')
    const server = fakeServer()
    mountDevSubmit(server, { root, base: '/docs/', log })
    expect((await server.call('/pages/home', { method: 'GET' })).passed).toBe(true)
    // ⚠️ A path that merely starts with the same letters is not the address.
    expect((await server.call('/_submitted', { method: 'GET' })).passed).toBe(true)
    const res = await server.call('/docs/_submit', { body: { formData: { a: '1' } } })
    expect(res.statusCode).toBe(200)
  })
})

describe('the payload `uniweb dev` serves names the address', () => {
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
    root = await mkdtemp(join(tmpdir(), 'uniweb-devsubmit-payload-'))
    await writeFile(join(root, 'site.yml'), yml)
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

  it('⭐ `submit: true` puts the dev server’s own address in config.submit — the site tier, never the host’s', async () => {
    const content = await devPayload('name: S\nservices:\n  submit: true\n')
    expect(content.config.submit).toBe(DEV_SUBMIT_ADDRESS)
    expect(content.config.services).toBeUndefined()
  })

  it('CONTROL — an address of the site’s own is what config.submit carries; the dev server does not take its place', async () => {
    const content = await devPayload('name: S\nservices:\n  submit: https://forms.example.com/f/abc\n')
    expect(content.config.submit).toBe('https://forms.example.com/f/abc')
  })

  it('CONTROL — a site that asks for no forms gets no address', async () => {
    const content = await devPayload('name: S\n')
    expect(content.config.submit).toBeUndefined()
  })
})
