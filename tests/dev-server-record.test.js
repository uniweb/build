/**
 * A site's dev server states where it listens (`site/dev-server.js`), and a reader checks the claim
 * before it believes it: the server at the recorded address, asked with the record's token, must
 * answer with the record's pid. Run against a real Vite server, since when `resolvedUrls` is set is
 * Vite's to decide — and a stop in a server of its own, since a stop exits the process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  devServerRecordPlugin,
  runningDevServer,
  stopDevServer,
  requestedDevPort,
  DEV_SERVER_RECORD,
  DEV_SERVER_ROUTE,
  DEV_RECORD_ENV,
  DEV_PORT_ENV,
} from '../src/site/dev-server.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const UNIWEB_DEV = { [DEV_RECORD_ENV]: '1' }

const sites = []
const children = []
function tempSite() {
  const dir = mkdtempSync(join(tmpdir(), 'uniweb-dev-server-'))
  sites.push(dir)
  return dir
}
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const dir of sites.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function serve(siteRoot, { env = UNIWEB_DEV } = {}) {
  const server = await createServer({
    root: siteRoot,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [devServerRecordPlugin(siteRoot, { env })],
  })
  await server.listen()
  return server
}

// The same server, in a process of its own, started as `uniweb dev` starts it.
const SERVE_IN_CHILD = `
import { createServer } from 'vite'
import { devServerRecordPlugin } from './src/site/dev-server.js'
const site = process.env.SITE
const server = await createServer({
  root: site,
  configFile: false,
  clearScreen: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [devServerRecordPlugin(site)],
})
await server.listen()
console.log('listening')
`

function serveInChild(siteRoot) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVE_IN_CHILD], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...UNIWEB_DEV, SITE: siteRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('listening')) resolve()
    })
    child.stderr.on('data', (chunk) => { output += chunk })
    exited.then(({ code }) => reject(new Error(`exited ${code} before listening:\n${output}`)))
  })
  return { child, listening, exited, output: () => output }
}

function writeRecord(siteRoot, record) {
  mkdirSync(join(siteRoot, '.uniweb'), { recursive: true })
  writeFileSync(join(siteRoot, DEV_SERVER_RECORD), JSON.stringify(record))
}

describe('the dev server states where it listens', () => {
  it('⭐ the address it was given, once it listens — and no record once it closes', async () => {
    const site = tempSite()
    const server = await serve(site)
    try {
      const running = await runningDevServer(site)
      expect(running?.url).toBe(server.resolvedUrls.local[0])
      expect(running.port).toBe(server.httpServer.address().port)
      expect(running.pid).toBe(process.pid)
    } finally {
      await server.close()
    }
    expect(existsSync(join(site, DEV_SERVER_RECORD))).toBe(false)
  })

  it('⭐ only the server `uniweb dev` starts keeps one — another for the same site leaves it alone', async () => {
    // `uniweb snapshot --dev` serves the site in its own process. When every server kept a record,
    // the snapshot's replaced this one and removed it on closing, while this one still served.
    const site = tempSite()
    const theirs = await serve(site)
    try {
      const snapshots = await serve(site, { env: {} })
      await snapshots.close()
      expect((await runningDevServer(site))?.url).toBe(theirs.resolvedUrls.local[0])
    } finally {
      await theirs.close()
    }
    const alone = tempSite()
    const server = await serve(alone, { env: {} })
    try {
      expect(existsSync(join(alone, DEV_SERVER_RECORD))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('the route answers only a caller with the record\'s token — it never serves the token', async () => {
    // It is answered before Vite's CORS and host checks, so what it serves, any page can read.
    const site = tempSite()
    const server = await serve(site)
    try {
      const record = JSON.parse(readFileSync(join(site, DEV_SERVER_RECORD), 'utf8'))
      const route = new URL(DEV_SERVER_ROUTE, record.url)
      const unasked = await fetch(route)
      expect(unasked.status).toBe(403)
      expect(await unasked.text()).not.toContain(record.token)
      const guessed = await fetch(new URL(`${DEV_SERVER_ROUTE}/stop`, record.url), {
        method: 'POST',
        headers: { 'x-uniweb-dev-token': 'a guess' },
      })
      expect(guessed.status).toBe(403)
      const asked = await fetch(route, { headers: { 'x-uniweb-dev-token': record.token } })
      expect(await asked.json()).toEqual({ pid: process.pid })
    } finally {
      await server.close()
    }
  })

  it('a record whose process is gone is removed', async () => {
    const site = tempSite()
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    writeRecord(site, { url: 'http://127.0.0.1:9/', port: 9, pid, token: 'gone', startedAt: new Date().toISOString() })
    expect(await runningDevServer(site)).toBeNull()
    expect(existsSync(join(site, DEV_SERVER_RECORD))).toBe(false)
  })

  it('a record no server confirms is not believed — its pid may name another process now', async () => {
    const site = tempSite()
    // Left by a server that did not get to close: its pid names a live process (this one), and
    // nothing answers at its address.
    writeRecord(site, { url: 'http://127.0.0.1:9/', port: 9, pid: process.pid, token: 'gone', startedAt: new Date().toISOString() })
    expect(await runningDevServer(site, { timeout: 500 })).toBeNull()
    expect(await stopDevServer(site)).toEqual({ none: true })
  })

  it('another server at the recorded address is not the one that wrote it', async () => {
    const site = tempSite()
    const other = tempSite()
    const server = await serve(other)
    try {
      const theirs = JSON.parse(readFileSync(join(other, DEV_SERVER_RECORD), 'utf8'))
      writeRecord(site, { ...theirs, token: 'not-this-one' })
      expect(await runningDevServer(site)).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('with nothing running, there is nothing to stop', async () => {
    expect(await stopDevServer(tempSite())).toEqual({ none: true })
  })
})

describe('a stop', () => {
  it('⭐ is asked for, and the server exits 0 — signalled, Vite exits 143, which reads as a crash', { timeout: 30000 }, async () => {
    const site = tempSite()
    const server = serveInChild(site)
    await server.listening
    expect(await stopDevServer(site)).toMatchObject({ stopped: { pid: server.child.pid } })
    expect(await server.exited).toEqual({ code: 0, signal: null })
    expect(server.output()).toMatch(/Stopped: `uniweb dev --stop` asked/)
    expect(existsSync(join(site, DEV_SERVER_RECORD))).toBe(false)

    // The control: what the signal gets.
    const signalled = serveInChild(tempSite())
    await signalled.listening
    signalled.child.kill('SIGTERM')
    expect((await signalled.exited).code).toBe(143)
  })
})

describe('the port `uniweb dev --port` asks for', () => {
  it('is read from the environment, and what is not a port is refused', () => {
    expect(requestedDevPort({})).toBeNull()
    expect(requestedDevPort({ [DEV_PORT_ENV]: '5199' })).toBe(5199)
    expect(() => requestedDevPort({ [DEV_PORT_ENV]: 'abc' })).toThrow(/not a port/)
    expect(() => requestedDevPort({ [DEV_PORT_ENV]: '70000' })).toThrow(/not a port/)
  })
})
