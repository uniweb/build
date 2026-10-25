/**
 * WHERE A SITE'S DEV SERVER IS — stated by the dev server `uniweb dev` starts, once it listens, and
 * read by `uniweb dev`.
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
 * ⭐ ONLY THE SERVER `uniweb dev` STARTS KEEPS A RECORD (`DEV_RECORD_ENV`). A dev server started for a
 * tool's own use is the tool's: `uniweb snapshot --dev` runs one in its own process, and while every
 * server kept a record, a snapshot's replaced the one people were using and removed it on closing,
 * so `--status` said none was running while it still served (measured 2026-10-25). A server started
 * with `vite` itself keeps none either; it prints its own address.
 *
 * ⭐ A RECORD IS A CLAIM, CHECKED WHEN READ (`runningDevServer`). A server that did not get to close
 * — killed, its machine restarted — leaves its record behind, and its pid may since name another
 * process. So the record counts only while the server at its address, asked with the record's
 * token, answers with the record's pid. One whose process is gone is removed; one that does not
 * answer so is not believed, and the next server to listen replaces it. Nothing stops a process
 * this has not confirmed is the site's dev server.
 *
 * ⭐ A STOP IS ASKED FOR, AND THE SERVER EXITS 0 (`stopDevServer`). Vite exits a SIGTERM with 143,
 * which the package manager running the site's dev script reports as a failed script, so a
 * signalled stop read as a crash in the server's own output. The token that asks is the record's:
 * sent to the server and never served by it, so a page that can reach the route — it is answered
 * before Vite's CORS and host checks — learns nothing from it and cannot stop the server.
 *
 * ⭐ A PORT IS THE DEV SERVER'S TO CHOOSE: Vite takes the next free one when its default is busy.
 * `uniweb dev --port <n>` asks for one, in `DEV_PORT_ENV`, and gets exactly that one or a refusal
 * (`strictPort`), never another (`config.js`).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'

/** The dev server's record, under the site's `.uniweb/`. */
export const DEV_SERVER_RECORD = join('.uniweb', 'dev-server.json')

/** Where the dev server, asked with its record's token, says who it is (`GET`) and stops (`POST /stop`). */
export const DEV_SERVER_ROUTE = '/@uniweb/dev-server'

/** The request header that carries the record's token. */
const TOKEN_HEADER = 'x-uniweb-dev-token'

/** Set by `uniweb dev` in the environment of the dev server it starts — the one that keeps a record. */
export const DEV_RECORD_ENV = 'UNIWEB_DEV_RECORD'

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
    return record && typeof record.url === 'string' && Number.isInteger(record.pid) && typeof record.token === 'string'
      ? record
      : null
  } catch {
    return null
  }
}

function writeRecord(siteRoot, record) {
  const path = join(siteRoot, DEV_SERVER_RECORD)
  mkdirSync(dirname(path), { recursive: true })
  // Written whole, then moved into place, so a reader never sees half a record. Its owner's to
  // read, since its token stops the server.
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
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

/**
 * Ask the server at the record's address, with the record's token: who it is (`GET`), or to stop
 * (`POST /stop`). Its JSON answer, or null when nothing answers so.
 */
function callDevServer(record, { method = 'GET', path = '', timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(DEV_SERVER_ROUTE + path, record.url)
    } catch {
      return resolve(null)
    }
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest
    // A dev server's certificate is its own, so it is not verified: the answer is the check. One
    // request, on a connection of its own, so no kept-alive socket outlives the answer.
    const call = request(
      target,
      { method, timeout, headers: { [TOKEN_HEADER]: record.token }, rejectUnauthorized: false, agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          if (response.statusCode >= 300) return resolve(null)
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(null)
          }
        })
      }
    )
    call.on('timeout', () => call.destroy())
    call.on('error', () => resolve(null))
    call.end()
  })
}

/** Whether a request carries `token`, compared as a secret is: in constant time. */
function carriesToken(req, token) {
  const given = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
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
  const answer = await callDevServer(record, { timeout })
  return answer?.pid === record.pid ? record : null
}

/**
 * Stop the site's running dev server, once it has confirmed it is one (`runningDevServer`). Asked,
 * it closes and exits 0; one that does not take the request is sent SIGTERM, which Vite exits
 * with 143.
 *
 * @param {string} siteRoot
 * @param {{ wait?: number }} [options] - how long to wait for it to exit, in ms
 * @returns {Promise<{ stopped: Object }|{ stuck: Object }|{ none: true }>}
 */
export async function stopDevServer(siteRoot, { wait = 5000 } = {}) {
  const running = await runningDevServer(siteRoot)
  if (!running) return { none: true }
  const asked = await callDevServer(running, { method: 'POST', path: '/stop' })
  if (!asked?.stopping) {
    try {
      process.kill(running.pid, 'SIGTERM')
    } catch {
      // Gone between the check and the signal.
    }
  }
  for (const until = Date.now() + wait; isAlive(running.pid) && Date.now() < until; ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (isAlive(running.pid)) return { stuck: running }
  removeDevServerRecord(siteRoot, running.pid)
  return { stopped: running }
}

/** Close the server and exit, as Vite does on SIGTERM — with 0, since this stop was asked for. */
async function closeAndExit(server) {
  server.config.logger.info('Stopped: `uniweb dev --stop` asked.')
  try {
    await server.close()
  } finally {
    process.exit(0)
  }
}

/**
 * The plugin that keeps the record, in the server `uniweb dev` starts (`DEV_RECORD_ENV`): it
 * answers `DEV_SERVER_ROUTE`, and writes the record once the server listens — `listen` is what
 * sets `resolvedUrls`, so the record is written when it resolves — and removes it when the server
 * closes.
 *
 * @param {string} siteRoot
 * @param {{ env?: Object }} [options] - the environment that says whether `uniweb dev` started it
 * @returns {import('vite').Plugin}
 */
export function devServerRecordPlugin(siteRoot, { env = process.env } = {}) {
  return {
    name: 'uniweb:dev-server-record',
    apply: (_config, { command }) => command === 'serve' && env[DEV_RECORD_ENV] === '1',
    configureServer(server) {
      const token = randomUUID()
      server.middlewares.use(DEV_SERVER_ROUTE, (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (!carriesToken(req, token)) {
          res.statusCode = 403
          return res.end('{}')
        }
        if (req.method === 'POST' && req.url === '/stop') {
          res.statusCode = 202
          // Answered before it closes, so the caller hears it is stopping.
          return res.end(JSON.stringify({ stopping: true }), () => closeAndExit(server))
        }
        res.end(JSON.stringify({ pid: process.pid }))
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
