import { mergeKey } from './records-merge.js'

/** Where `uniweb dev` answers a site's records when a backend's records are merged in. */
export const DEV_RECORDS_ADDRESS = '/_records'

/**
 * `uniweb dev`'s records service — for a site whose `$devBackend` names a backend's records address
 * beside its own:
 *
 * ```yaml
 * $devBackend:
 *   backend: http://localhost:1234/api
 *   records: http://localhost:1234/records/{locale}
 * ```
 *
 * The dev server is the site's host then, and its payload offers this as the site's `records`
 * service, so the page asks every named query here (`/_records/{locale}`, the batch a records service
 * takes). Each key is asked of both sources — the project's record files (`answerFiles`) and the
 * backend's public records, in one request carrying every key, as written — and the two answers are
 * merged as a site's records service merges them (`./records-merge.js`). The answer is that
 * service's: `{ data, whole?, cursors?, partial? }`.
 *
 * ⭐ THE BACKEND'S ADDRESS IS READ, NEVER COMPOSED: the developer writes it whole, `{locale}`
 * included, and the request goes there as an anonymous one — no cookie, no credential.
 *
 * ⭐ PAGING STAYS IN ONE SOURCE. A key offers a cursor only when one source delivered its records,
 * and the cursor this hands out names that source: the backend's own token sealed inside, or where
 * the files' list resumes. A page asked with it is asked of that source alone.
 *
 * ⭐ A BACKEND THAT DOESN'T ANSWER leaves each key the files' answer, and says so in `partial`.
 *
 * ⛔ Registered SYNCHRONOUSLY, like `mountDevApi`.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {string} options.address - the backend's records address, with its `{locale}` slot
 * @param {(p: { key: string, question: object, locale: string, offset: number }) => Promise<{ records: object[], whole: boolean, cursor: number|null }>} options.answerFiles
 * @param {typeof fetch} [options.fetch]
 * @param {(line: string) => void} [options.log]
 * @returns {string} the address the payload offers, with its `{locale}` slot
 */
export function mountDevRecords(server, { address, answerFiles, fetch: send = globalThis.fetch, log = console.log }) {
  server.middlewares.use(async (req, res, next) => {
    const url = (req.url || '').split('?')[0]
    const at = url.indexOf(`${DEV_RECORDS_ADDRESS}/`)
    if (at === -1 || (at > 0 && !url.slice(0, at).startsWith('/'))) return next()
    const locale = decodeURIComponent(url.slice(at + DEV_RECORDS_ADDRESS.length + 1)).replace(/\/+$/, '')
    if (!locale || locale.includes('/')) return next()
    if (req.method !== 'POST') return problem(res, 405, 'Method Not Allowed', 'A records question is a POST.')

    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || 'null')
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return problem(res, 400, 'Bad Request', 'A records request is an object of questions, by key.')
    }

    // Who each key is asked of: both, or the one source a cursor resumes.
    const plan = {}
    const toEngine = {}
    for (const [key, question] of Object.entries(body)) {
      const resumed = readCursor(question?.narrow?.cursor)
      const asked = withoutCursor(question)
      if (resumed?.source === 'engine') {
        plan[key] = { question: asked, files: false, engine: true }
        toEngine[key] = { ...asked, narrow: { ...(asked.narrow || {}), cursor: resumed.at } }
      } else if (resumed?.source === 'files') {
        plan[key] = { question: asked, files: true, engine: false, offset: resumed.at }
      } else {
        plan[key] = { question: asked, files: true, engine: true }
        toEngine[key] = asked
      }
    }

    const engine = Object.keys(toEngine).length ? await askEngine(send, address.replace('{locale}', encodeURIComponent(locale)), toEngine) : null

    const data = {}
    const whole = {}
    const cursors = {}
    const partial = {}
    for (const [key, p] of Object.entries(plan)) {
      let files = null
      if (p.files) {
        try {
          files = await answerFiles({ key, question: p.question, locale, offset: p.offset || 0 })
        } catch (err) {
          files = { records: [], whole: false, cursor: null }
          partial[key] = { source: 'files', code: 'files-failed', detail: err?.message || String(err) }
        }
      }
      let fromEngine = null
      if (p.engine) {
        const failure = engine?.failure || (Array.isArray(engine?.data?.[key]) ? null : { code: 'missing-key', detail: `The backend's answer has no \`${key}\`.` })
        if (failure) partial[key] = { source: 'engine', ...failure }
        else fromEngine = { records: engine.data[key], whole: engine.whole?.[key] === true, cursor: engine.cursors?.[key] ?? null }
      }
      const merged = mergeKey(p.question, { files, engine: fromEngine }, locale)
      data[key] = merged.records
      if (merged.whole) whole[key] = true
      if (merged.cursor) cursors[key] = writeCursor(merged.cursor)
    }

    const answer = { data }
    if (Object.keys(whole).length) answer.whole = whole
    if (Object.keys(cursors).length) answer.cursors = cursors
    if (Object.keys(partial).length) answer.partial = partial
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(answer))
  })

  log(`[dev-records] ${DEV_RECORDS_ADDRESS}/{locale} answers the site's records: its files, with ${address}`)
  return `${DEV_RECORDS_ADDRESS}/{locale}`
}

/** One request to the backend for every key it is asked; `{ failure }` when it doesn't answer. */
async function askEngine(send, url, questions) {
  let response
  try {
    response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(questions),
      credentials: 'omit',
    })
  } catch (err) {
    return { failure: { code: 'unreachable', detail: `Could not reach ${url}: ${err?.cause?.message || err.message}` } }
  }
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // reported below
  }
  if (!response.ok) {
    return { failure: { code: `http-${response.status}`, detail: parsed?.detail || `${url} answered ${response.status}.` } }
  }
  if (!parsed || typeof parsed.data !== 'object' || !parsed.data) {
    return { failure: { code: 'no-data', detail: `${url} answered with no \`data\`.` } }
  }
  return parsed
}

// A cursor this hands out names its source: `dev1.` and the base64url of `{ s, a }`.
const CURSOR = 'dev1.'

function writeCursor({ source, at }) {
  return CURSOR + Buffer.from(JSON.stringify({ s: source, a: at })).toString('base64url')
}

function readCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR)) return null
  try {
    const { s, a } = JSON.parse(Buffer.from(cursor.slice(CURSOR.length), 'base64url').toString('utf8'))
    if (s === 'engine' && typeof a === 'string') return { source: 'engine', at: a }
    if (s === 'files' && Number.isInteger(a)) return { source: 'files', at: a }
  } catch {
    // not one of ours
  }
  return null
}

/** The question without a cursor: a page's own goes to the source it names, and nothing else is passed on. */
function withoutCursor(question) {
  if (!question || typeof question !== 'object' || !question.narrow?.cursor) return question
  const { cursor: _c, ...narrow } = question.narrow
  return Object.keys(narrow).length ? { ...question, narrow } : (({ narrow: _n, ...rest }) => rest)(question)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function problem(res, status, title, detail) {
  res.statusCode = status
  res.setHeader('content-type', 'application/problem+json')
  res.end(JSON.stringify({ status, title, detail }))
}
