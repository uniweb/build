/**
 * A site's dev server states where it listens (`site/dev-server.js`), and a reader checks the claim
 * before it believes it: the server at the recorded address must answer with the record's pid and
 * token. Run against a real Vite server, since when `resolvedUrls` is set is Vite's to decide.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import {
  devServerRecordPlugin,
  runningDevServer,
  stopDevServer,
  requestedDevPort,
  DEV_SERVER_RECORD,
  DEV_PORT_ENV,
} from '../src/site/dev-server.js'

const sites = []
function tempSite() {
  const dir = mkdtempSync(join(tmpdir(), 'uniweb-dev-server-'))
  sites.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of sites.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function serve(siteRoot) {
  const server = await createServer({
    root: siteRoot,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [devServerRecordPlugin(siteRoot)],
  })
  await server.listen()
  return server
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

describe('the port `uniweb dev --port` asks for', () => {
  it('is read from the environment, and what is not a port is refused', () => {
    expect(requestedDevPort({})).toBeNull()
    expect(requestedDevPort({ [DEV_PORT_ENV]: '5199' })).toBe(5199)
    expect(() => requestedDevPort({ [DEV_PORT_ENV]: 'abc' })).toThrow(/not a port/)
    expect(() => requestedDevPort({ [DEV_PORT_ENV]: '70000' })).toThrow(/not a port/)
  })
})
