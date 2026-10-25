/**
 * WHERE A SITE'S DEV SERVER IS — stated by the dev server once it listens, and read by `uniweb dev`.
 *
 * Whoever starts a dev server needs its address, and one guessed from a port is worse than none:
 * Vite's 5173 may be another project's server, and a review of the wrong site reports success. So
 * the address is the server's to state and everyone else's to read, as a serve location is. The
 * dev server writes the address it was given (Vite's `resolvedUrls`) to the site's `.uniweb/`,
 * which the templates gitignore, and removes it when it closes:
 *
 *   .uniweb/dev-server.json   { url, port, pid, token, startedAt }
 *
 * `uniweb dev` reads it: to say where the server is (`--status`), to leave a running one alone
 * rather than start a second on another port, and to stop it (`--stop`).
 *
 * ⭐ A RECORD IS A CLAIM, CHECKED WHEN READ (`runningDevServer`). A server that did not get to close
 * — killed, its machine restarted — leaves its record behind, and its pid may since name another
 * process. So the record counts only while the server at its address answers `DEV_SERVER_ROUTE`
 * with the record's own pid and token. One whose process is gone is removed; one that does not
 * answer so is not believed, and the next server to listen replaces it. Nothing stops a process
 * this has not confirmed is the site's dev server.
 *
 * ⭐ A PORT IS THE DEV SERVER'S TO CHOOSE: Vite takes the next free one when its default is busy.
 * `uniweb dev --port <n>` asks for one, in `DEV_PORT_ENV`, and gets exactly that one or a refusal
 * (`strictPort`), never another (`config.js`).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** The dev server's record, under the site's `.uniweb/`. */
export const DEV_SERVER_RECORD = join('.uniweb', 'dev-server.json')

/** Where the dev server answers who it is: its pid and its record's token. */
export const DEV_SERVER_ROUTE = '/@uniweb/dev-server'

/** The port `uniweb dev --port <n>` asks for, in the dev server's environment. */
export const DEV_PORT_ENV = 'UNIWEB_DEV_PORT'

/**
 * The port `DEV_PORT_ENV` asks for, or null when it asks for none.
 *
 * @param {Object} [env]
 * @returns {number|null}
 */
export function requestedDevPort(env = process.env) {
  const value = env[DEV_PORT_ENV]
  if (value === undefined || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${DEV_PORT_ENV} is "${value}", which is not a port (1–65535).`)
  }
  return port
}

/** The record at `siteRoot` as written, or null. Unchecked — `runningDevServer` checks it. */
function readRecord(siteRoot) {
  try {
    const record = JSON.parse(readFileSync(join(siteRoot, DEV_SERVER_RECORD), 'utf8'))
    return record && typeof record.url === 'string' && Number.isInteger(record.pid) ? record : null
  } catch {
    return null
  }
}

function writeRecord(siteRoot, record) {
  const path = join(siteRoot, DEV_SERVER_RECORD)
  mkdirSync(dirname(path), { recursive: true })
  // Written whole, then moved into place, so a reader never sees half a record.
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(temp, path)
}

/**
 * Remove the record, if it is still the one `pid` wrote — a newer server's is left alone.
 *
 * @param {string} siteRoot
 * @param {number} pid
 */
export function removeDevServerRecord(siteRoot, pid) {
  if (readRecord(siteRoot)?.pid === pid) rmSync(join(siteRoot, DEV_SERVER_RECORD), { force: true })
}

/** What the server at `url` says it is (`DEV_SERVER_ROUTE`), or null when nothing answers so. */
function askDevServer(url, timeout) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(DEV_SERVER_ROUTE, url)
    } catch {
      return resolve(null)
    }
    const get = target.protocol === 'https:' ? httpsGet : httpGet
    // A dev server's certificate is its own, so it is not verified: the token is the check. One
    // request, on a connection of its own, so no kept-alive socket outlives the answer.
    const request = get(target, { timeout, rejectUnauthorized: false, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM' // alive, and someone else's
  }
}

/**
 * The site's running dev server — its record — or null. Confirmed by asking the server at the
 * record's address who it is. A record whose process is gone is removed; one no server confirms
 * is left for the next server to replace, since a busy one may answer late.
 *
 * @param {string} siteRoot
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ url: string, port: number|null, pid: number, token: string, startedAt: string }|null>}
 */
export async function runningDevServer(siteRoot, { timeout = 2000 } = {}) {
  const record = readRecord(siteRoot)
  if (!record) return null
  if (!isAlive(record.pid)) {
    removeDevServerRecord(siteRoot, record.pid)
    return null
  }
  const answer = await askDevServer(record.url, timeout)
  return answer?.pid === record.pid && answer?.token === record.token ? record : null
}

/**
 * Stop the site's running dev server, once it has confirmed it is one (`runningDevServer`).
 *
 * @param {string} siteRoot
 * @param {{ wait?: number }} [options] - how long to wait for it to exit, in ms
 * @returns {Promise<{ stopped: Object }|{ stuck: Object }|{ none: true }>}
 */
export async function stopDevServer(siteRoot, { wait = 5000 } = {}) {
  const running = await runningDevServer(siteRoot)
  if (!running) return { none: true }
  try {
    process.kill(running.pid, 'SIGTERM')
  } catch {
    // Gone between the check and the signal.
  }
  for (const until = Date.now() + wait; isAlive(running.pid) && Date.now() < until; ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (isAlive(running.pid)) return { stuck: running }
  removeDevServerRecord(siteRoot, running.pid)
  return { stopped: running }
}

/**
 * The plugin that keeps the record: it answers `DEV_SERVER_ROUTE`, and writes the record once the
 * server listens — `listen` is what sets `resolvedUrls`, so the record is written when it resolves,
 * whoever calls it (the vite CLI, a script) — and removes it when the server closes.
 *
 * @param {string} siteRoot
 * @returns {import('vite').Plugin}
 */
export function devServerRecordPlugin(siteRoot) {
  return {
    name: 'uniweb:dev-server-record',
    apply: 'serve',
    configureServer(server) {
      const token = randomUUID()
      server.middlewares.use(DEV_SERVER_ROUTE, (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ pid: process.pid, token }))
      })
      const listen = server.listen.bind(server)
      server.listen = async (...args) => {
        const listening = await listen(...args)
        const url = server.resolvedUrls?.local?.[0]
        if (url) {
          const port = server.httpServer?.address()?.port ?? null
          writeRecord(siteRoot, { url, port, pid: process.pid, token, startedAt: new Date().toISOString() })
          server.httpServer?.once('close', () => removeDevServerRecord(siteRoot, process.pid))
        }
        return listening
      }
    },
  }
}
