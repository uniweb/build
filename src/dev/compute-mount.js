import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { runComputeFunction, LIMITS } from '../foundation/compute-run.js'
import { workspaceComputeFiles } from '../foundation/shared-types.js'
import { ownComputeFiles } from '../foundation/compute.js'
import { foundationScope } from '../foundation/scope-define.js'
import { loadFoundationConfig } from '../schema.js'
import { resolveFoundationSrcDir } from '../utils/foundation-source-root.js'

/** Where `uniweb dev` answers a local backend's compute calls. */
export const DEV_COMPUTE_ADDRESS = '/_compute'

/** The variable that hands the runner the site's functions key, so it checks each call's signature. */
export const FUNCTIONS_KEY_ENV = 'UNIWEB_FUNCTIONS_KEY'

/** The variable that names the port the runner answers on, on a server of its own (`serveDevCompute`). */
export const FUNCTIONS_PORT_ENV = 'UNIWEB_FUNCTIONS_PORT'

/**
 * `uniweb dev`'s compute runner — what answers a backend running on the developer's machine when
 * one of its integrations calls a compute function.
 *
 * On the platform a site's backend calls a function at the address it was given for its runner,
 * `POST <runner>/{scope}/{name}/{version}/{export}`, with the integration's JSON as the body, and
 * the runner answers with the function's object. A backend on the developer's machine has no such
 * runner, so the dev server is one: point the backend's runner address at
 * `http://<this machine>:<dev port>/_compute`, and each call runs the function **from the working
 * copy** — the foundation's `src/compute/`, or a library's `compute/` that its `main.js` names — so
 * an edited function answers its next call with nothing registered again. `{version}` is not read:
 * the working copy is the version.
 *
 * ⭐ THE PLATFORM'S RULES, AND ITS REPLIES. Each call runs under `runComputeFunction`, the rules
 * `uniweb compute run` enforces (the web's globals, no network, frozen built-in prototypes, the
 * input and answer limits), and answers as the platform's runner does: `200` with the object, or a
 * refusal `{ error }` with `X-Uniweb-Error`, and for a failure a `message` the backend records:
 *
 *   400 input-not-json · 401 invalid-signature · 404 function-not-found · 405 · 413 input-too-large
 *   422 function-failed (threw, answered no object, answered too much, or the file can't start)
 *   422 function-limit (over the CPU a call may take, or the time)
 *
 * ⚠️ One rule is stricter here than `uniweb compute run`: a call measured over the CPU a call may
 * take (`LIMITS.cpuMs`) is refused as `function-limit`, as the platform refuses it, where the local
 * run only warns. A function that passes here should not be stopped live; this machine is not that
 * one, so a call close to the limit may go either way.
 *
 * ⭐ THE SIGNATURE, WHEN GIVEN THE KEY. A backend signs each call with the site's functions key
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`). Given the key in
 * `UNIWEB_FUNCTIONS_KEY`, the runner checks it, the timestamp within five minutes; without it, it
 * takes the call as it comes, since only the developer's own backend reaches it.
 *
 * ⛔ Registered SYNCHRONOUSLY, like `mountDevApi`: Vite runs the middleware registered before
 * `configureServer` returns ahead of its SPA fallback.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {string} options.foundationDir - the foundation whose functions it runs
 * @param {string|null} [options.key] - the site's functions key (`whsec_…`); null takes unsigned calls
 * @param {() => number} [options.now] - seconds since the epoch, injected in tests
 * @param {(line: string) => void} [options.log]
 * @returns {string} the address it answers at
 */
export function mountDevCompute(server, { foundationDir, key = null, now = () => Math.floor(Date.now() / 1000), log = console.log }) {
  const prefix = DEV_COMPUTE_ADDRESS
  const secret = key ? keyBytes(key) : null
  if (key && !secret) throw new Error(`${FUNCTIONS_KEY_ENV} is not a functions key: it is \`whsec_\` and a base64 secret.`)

  server.middlewares.use(async (req, res, next) => {
    const url = req.url || ''
    if (url !== prefix && !url.startsWith(`${prefix}/`)) return next()
    const path = url.slice(prefix.length).split('?')[0]
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent)

    if (req.method !== 'POST') return refuse(res, 405, 'method-not-allowed')
    // `{scope}/{name}/{version}/{export}`, the scope with or without its `@`.
    if (parts.length !== 4) return refuse(res, 404, 'function-not-found')
    const [scopePart, name, , exportName] = parts
    const ref = `@${scopePart.replace(/^@/, '')}/${name}`

    const body = await readBody(req, LIMITS.inputBytes)
    if (body === null) return refuse(res, 413, 'input-too-large')

    if (secret && !signedBy(secret, req.headers, body, now())) return refuse(res, 401, 'invalid-signature')

    let file
    try {
      file = await declaredComputeFile(foundationDir, ref)
    } catch (err) {
      return refuse(res, 503, 'runner-unavailable', err?.message)
    }
    if (!file) return refuse(res, 404, 'function-not-found')

    const result = await runComputeFunction({ file, exportName, inputText: body.toString('utf8') })
    if (result.ok) {
      const limited = result.cpuMs != null && result.cpuMs > LIMITS.cpuMs
      if (!limited) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(result.answer))
      }
      return refuse(res, 422, 'function-limit', `The call took ${Math.round(result.cpuMs)} ms of CPU, over the ${LIMITS.cpuMs} ms a call may take.`)
    }
    const message = [result.failure, ...(result.problems || [])].filter(Boolean).join(' ')
    switch (result.reason) {
      case 'not-exported':
        return refuse(res, 404, 'function-not-found', message)
      case 'input-too-large':
        return refuse(res, 413, 'input-too-large', message)
      case 'input-not-json':
        return refuse(res, 400, 'input-not-json', message)
      case 'limit':
        return refuse(res, 422, 'function-limit', message)
      default:
        return refuse(res, 422, 'function-failed', message)
    }
  })

  log(`[dev-compute] ${prefix}/* runs this project's compute functions for a backend on this machine`)
  return prefix
}

/**
 * The compute file `ref` (`@scope/name`) names, when the foundation declares it: one of its own, in
 * its `src/compute/`, or a library's that its `main.js` names in `compute:`. Null otherwise — a
 * backend binds only what the foundation declares, so anything else is no function of this site's.
 *
 * Read on every call, so a file added, renamed or named in `main.js` is found without a restart.
 */
async function declaredComputeFile(foundationDir, ref) {
  const srcDir = join(foundationDir, resolveFoundationSrcDir(foundationDir))
  const [, scope, name] = /^(@[^/]+)\/(.+)$/.exec(ref) || []
  if (!scope) return null
  if (scope === (await foundationScope(foundationDir))) {
    const own = ownComputeFiles(srcDir).find((f) => f.name === name)
    if (own) return own.file
  }
  const config = await loadFoundationConfig(srcDir)
  const named = Array.isArray(config?.compute) ? config.compute : []
  if (!named.includes(ref)) return null
  const files = await workspaceComputeFiles(ref, srcDir)
  return files.length === 1 ? files[0] : null
}

/** The body, whole, or null when it is over `max` bytes. */
async function readBody(req, max) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** The secret a `whsec_` key holds, or null for one that doesn't hold one. */
function keyBytes(key) {
  const m = /^whsec_([A-Za-z0-9+/=]+)$/.exec(String(key).trim())
  if (!m) return null
  const bytes = Buffer.from(m[1], 'base64')
  return bytes.length ? bytes : null
}

/**
 * Whether a call is signed with `secret`: `webhook-signature` holds `v1,<base64 HMAC-SHA256 of
 * "{id}.{timestamp}.{body}">` (one of several, space-separated), and the timestamp is within five
 * minutes of now.
 */
export function signedBy(secret, headers, body, nowSeconds) {
  const id = header(headers, 'webhook-id')
  const timestamp = header(headers, 'webhook-timestamp')
  const signatures = header(headers, 'webhook-signature')
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(body).digest()
  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

function header(headers, name) {
  const value = headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/** A refusal as the platform's runner answers one: `{ error }`, the token in `X-Uniweb-Error`, and a message when there is one. */
function refuse(res, status, error, message) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('x-uniweb-error', error)
  const body = { error }
  if (message) body.message = String(message).slice(0, 1000)
  res.end(JSON.stringify(body))
}

/**
 * The runner on a server of its own, on `127.0.0.1:<port>` — what a backend in Docker calls.
 *
 * ⭐ WHY NOT THE DEV SERVER'S OWN ADDRESS. A backend running in Docker reaches this machine through
 * `host.docker.internal`, over IPv4, and the dev server listens where `localhost` resolves, which
 * Node takes as `::1` first: measured, a container got no connection to a server on `::1` and an
 * answer from one on `127.0.0.1`. Binding the dev server to `127.0.0.1` instead would move the
 * address its page is opened at, and a sign-in cookie the backend sets for `localhost` would not be
 * sent there. So the runner listens on IPv4 loopback, on the port the backend was given for it, and
 * the dev server stays where it is — on whatever port it takes.
 *
 * It answers exactly what `mountDevCompute` answers, under the same `/_compute` path.
 *
 * @param {object} options
 * @param {string} options.foundationDir
 * @param {string|null} [options.key]
 * @param {number} options.port
 * @param {string} [options.host]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<import('node:http').Server>} once it listens
 */
export async function serveDevCompute({ foundationDir, key = null, port, host = '127.0.0.1', log = console.log }) {
  let handler = null
  mountDevCompute({ middlewares: { use: (fn) => (handler = fn) } }, { foundationDir, key, log: () => {} })
  const server = createServer((req, res) => handler(req, res, () => refuse(res, 404, 'function-not-found')))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  log(`[dev-compute] http://${host}:${port}${DEV_COMPUTE_ADDRESS}/* runs this project's compute functions for a backend on this machine`)
  return server
}
