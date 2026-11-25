/**
 * `uniweb dev`'s compute runner: a backend on the developer's machine calls the site's compute
 * functions at `/_compute/{scope}/{name}/{version}/{export}`, and the dev server runs them from the
 * working copy, under the platform's rules, answering as the platform's runner does.
 */
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mountDevCompute, DEV_COMPUTE_ADDRESS, signedBy } from '../src/dev/compute-mount.js'

let dir
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A foundation named `@acme/marketing`, with the compute files given (`compute/<name>.js`). */
function foundation(files) {
  dir = mkdtempSync(join(tmpdir(), 'uw-dev-compute-'))
  const all = {
    'package.json': JSON.stringify({ name: '@acme/marketing', type: 'module', main: './_entry.generated.js' }),
    'main.js': "export default { name: '@acme/marketing' }\n",
    ...files,
  }
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

function server(options = {}) {
  const stack = []
  const s = { middlewares: { use: (fn) => stack.push(fn) } }
  mountDevCompute(s, { foundationDir: dir, log: () => {}, ...options })
  return {
    async call(url, { method = 'POST', body = '{}', headers = {} } = {}) {
      const req = { url, method, headers }
      req[Symbol.asyncIterator] = async function* () {
        if (body) yield Buffer.from(body)
      }
      const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { this.body = b } }
      let passed = false
      for (const fn of stack) await fn(req, res, () => { passed = true })
      return { ...res, passed, json: res.body ? JSON.parse(res.body) : null }
    },
  }
}

const GRADER = `export function grade(input) {
  let points = 0
  for (const a of input.answers) if (a === 'b') points += 1
  return { points, max: input.answers.length }
}
export function boom() { throw new Error('no key for this quiz') }
export function nothing() { return 42 }
export function spin() { const end = Date.now() + 400; while (Date.now() < end) {} return {} }
`

describe('mountDevCompute', () => {
  it('⭐ runs a foundation’s own function from the working copy, at /{scope}/{name}/{version}/{export}', async () => {
    foundation({ 'compute/grading.js': GRADER })
    const res = await server().call(`${DEV_COMPUTE_ADDRESS}/acme/grading/3/grade`, { body: JSON.stringify({ answers: ['b', 'a', 'b'] }) })
    expect(res.statusCode).toBe(200)
    expect(res.json).toEqual({ points: 2, max: 3 })
  })

  it('⭐ reads the file on every call, so an edit answers the next one', async () => {
    foundation({ 'compute/grading.js': GRADER })
    const s = server()
    expect((await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: '{"answers":["b"]}' })).json).toEqual({ points: 1, max: 1 })
    writeFileSync(join(dir, 'compute/grading.js'), 'export function grade() { return { edited: true } }\n')
    expect((await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: '{"answers":["b"]}' })).json).toEqual({ edited: true })
  })

  it('answers the platform runner’s refusals, each with its token in X-Uniweb-Error', async () => {
    foundation({ 'compute/grading.js': GRADER })
    const s = server()
    const cases = [
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/boom`), 422, 'function-failed', /no key for this quiz/],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/nothing`), 422, 'function-failed', /not an object/],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/missing`), 404, 'function-not-found', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/nope/1/grade`), 404, 'function-not-found', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/other/grading/1/grade`), 404, 'function-not-found', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: 'not json' }), 400, 'input-not-json', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: '[1]' }), 400, 'input-not-json', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: 'x'.repeat(1024 * 1024 + 1) }), 413, 'input-too-large', null],
      [await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { method: 'GET' }), 405, 'method-not-allowed', null],
    ]
    for (const [res, status, token, message] of cases) {
      expect(res.statusCode).toBe(status)
      expect(res.headers['x-uniweb-error']).toBe(token)
      expect(res.json.error).toBe(token)
      if (message) expect(res.json.message).toMatch(message)
    }
  })

  it('⭐ refuses a call over the CPU a call may take as function-limit, as the platform does', async () => {
    foundation({ 'compute/grading.js': GRADER })
    const res = await server().call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/spin`)
    expect(res.statusCode).toBe(422)
    expect(res.json.error).toBe('function-limit')
  })

  it('⭐ runs a library’s function the foundation’s main.js names, and no other', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uw-dev-compute-ws-'))
    const files = {
      'pnpm-workspace.yaml': 'packages:\n  - foundation\n  - lib\n',
      'package.json': JSON.stringify({ name: 'ws', private: true }),
      'foundation/package.json': JSON.stringify({ name: '@acme/marketing', type: 'module', main: './_entry.generated.js' }),
      'foundation/main.js': "export default { name: '@acme/marketing', compute: ['@lib/score'] }\n",
      'lib/package.json': JSON.stringify({ name: 'lib', type: 'module', uniweb: { scope: '@lib' } }),
      'lib/compute/score.js': 'export function total(input) { return { total: input.n * 2 } }\n',
      'lib/compute/other.js': 'export function total() { return {} }\n',
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    const stack = []
    mountDevCompute({ middlewares: { use: (fn) => stack.push(fn) } }, { foundationDir: join(dir, 'foundation'), log: () => {} })
    const call = async (url) => {
      const req = { url, method: 'POST', headers: {} }
      req[Symbol.asyncIterator] = async function* () { yield Buffer.from('{"n":21}') }
      const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
      for (const fn of stack) await fn(req, res, () => {})
      return res
    }
    const named = await call(`${DEV_COMPUTE_ADDRESS}/lib/score/1/total`)
    expect([named.statusCode, JSON.parse(named.body)]).toEqual([200, { total: 42 }])
    expect((await call(`${DEV_COMPUTE_ADDRESS}/lib/other/1/total`)).statusCode).toBe(404)
  })

  it('passes everything outside its address through', async () => {
    foundation({ 'compute/grading.js': GRADER })
    expect((await server().call('/_computer/x')).passed).toBe(true)
  })

  describe('the signature', () => {
    const secret = Buffer.from('k'.repeat(32))
    const key = `whsec_${secret.toString('base64')}`
    const sign = (body, { id = 'msg_1', ts = 1_700_000_000, with: k = secret } = {}) => ({
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': `v1,${createHmac('sha256', k).update(`${id}.${ts}.${body}`).digest('base64')}`,
    })

    it('⭐ given the key, takes a signed call and refuses an unsigned or wrongly signed one', async () => {
      foundation({ 'compute/grading.js': GRADER })
      const s = server({ key, now: () => 1_700_000_000 })
      const body = '{"answers":["b"]}'
      expect((await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body, headers: sign(body) })).statusCode).toBe(200)
      const unsigned = await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body })
      expect([unsigned.statusCode, unsigned.json.error]).toEqual([401, 'invalid-signature'])
      const wrong = await s.call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body, headers: sign(body, { with: Buffer.from('x'.repeat(32)) }) })
      expect(wrong.statusCode).toBe(401)
    })

    it('refuses a timestamp more than five minutes away', () => {
      const body = Buffer.from('{}')
      expect(signedBy(secret, sign('{}', { ts: 1000 }), body, 1000 + 300)).toBe(true)
      expect(signedBy(secret, sign('{}', { ts: 1000 }), body, 1000 + 301)).toBe(false)
    })

    it('without the key, takes an unsigned call', async () => {
      foundation({ 'compute/grading.js': GRADER })
      expect((await server().call(`${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { body: '{"answers":[]}' })).statusCode).toBe(200)
    })

    it('⛔ refuses to start with something that is not a functions key', () => {
      foundation({ 'compute/grading.js': GRADER })
      expect(() => server({ key: 'not-a-key' })).toThrow(/not a functions key/)
    })
  })
})

describe('the dev server mounts it', () => {
  let root
  afterEach(() => root && rmSync(root, { recursive: true, force: true }))

  async function devServer(devBackend) {
    root = mkdtempSync(join(tmpdir(), 'uw-dev-compute-site-'))
    const files = {
      'site/site.yml': `name: S\nservices:\n  backend: true\n$devBackend: ${devBackend}\n`,
      'site/mock/api.js': 'export default () => new Response("{}")\n',
      'src/package.json': JSON.stringify({ name: '@acme/marketing', type: 'module', main: './_entry.generated.js' }),
      'src/main.js': "export default { name: '@acme/marketing' }\n",
      'src/compute/grading.js': 'export function grade() { return { ok: true } }\n',
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    const { siteContentPlugin } = await import('../src/site/plugin.js')
    const plugin = siteContentPlugin({ sitePath: './', foundationPath: join(root, 'src') })
    const saved = console.log
    console.log = () => {}
    try {
      await plugin.configResolved({ root: join(root, 'site'), publicDir: join(root, 'site/public'), build: { outDir: 'dist' }, command: 'serve', base: '/' })
      const stack = []
      plugin.configureServer({ middlewares: { use: (fn) => stack.push(fn) }, ssrLoadModule: (href) => import(href), ws: { send: () => {} } })
      return stack
    } finally {
      console.log = saved
    }
  }

  async function ask(stack) {
    const req = { url: `${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, method: 'POST', headers: {} }
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from('{}') }
    const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b } }
    let passed = false
    for (const fn of stack) {
      if (res.body !== undefined) break
      await fn(req, res, () => { passed = true })
    }
    return { status: res.statusCode, passed: res.body === undefined && passed }
  }

  it('⭐ when `$devBackend` is a backend’s address', async () => {
    expect((await ask(await devServer('http://localhost:1234/api'))).status).toBe(200)
  })

  it('CONTROL — not for a `$devBackend` module, which no backend calls back', async () => {
    expect((await ask(await devServer('./mock/api.js'))).status).toBe(0)
  })
})

describe('serveDevCompute — the runner on a server of its own', () => {
  it('⭐ answers on 127.0.0.1 at the port it is given, as the mounted runner does', async () => {
    foundation({ 'compute/grading.js': GRADER })
    const { serveDevCompute } = await import('../src/dev/compute-mount.js')
    const runner = await serveDevCompute({ foundationDir: dir, port: 0, log: () => {} })
    try {
      const { address, port } = runner.address()
      expect(address).toBe('127.0.0.1')
      const ok = await fetch(`http://127.0.0.1:${port}${DEV_COMPUTE_ADDRESS}/acme/grading/1/grade`, { method: 'POST', body: '{"answers":["b"]}' })
      expect([ok.status, await ok.json()]).toEqual([200, { points: 1, max: 1 }])
      const elsewhere = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', body: '{}' })
      expect([elsewhere.status, elsewhere.headers.get('x-uniweb-error')]).toEqual([404, 'function-not-found'])
    } finally {
      await new Promise((done) => runner.close(done))
    }
  })
})
