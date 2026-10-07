/**
 * A site's services — `site.yml::services`, ONE entry per service, saying
 * everything the owner says about it.
 *
 * ```yaml
 * services:
 *   search:                                   # on: the host's, or the built-in index
 *     exclude: { routes: [/legal] }           # an option the site's runtime reads
 *   submit: https://forms.example.com/f/abc   # an address: a provider the site brings
 *   tracking: { consent: required }
 *   api: { grade: pro }                       # a setting for the host's service
 * ```
 *
 * ⭐ ONE PLACE [Diego, 2026-10-06]. Until then the site's own provider and options
 * lived in top-level `search:` / `submit:` / `assistant:` / `tracking:` / `api:`, and
 * the request to the host in `services:` — two switches for one thing. Those keys are
 * retired and refused (`refuseRetiredServiceKeys`).
 *
 * Each entry goes ONE place per lane, decided here and nowhere else:
 *
 *   - **a built site** reads it as its own config (`config.<name>` in the payload) —
 *     the switch, an address, the options. ⛔ For `api` only its switch and address:
 *     its settings are for the host that provisions it. Never a credential.
 *   - **a push** sends it as the request: ONE row per entry in the `services` Section,
 *     `{ name, enabled?: false, config? }`, whose `config` is the whole entry — an
 *     address, the options, the host's settings — never a credential. What reaches a
 *     hosted page from a row is the host's to project.
 *
 * ⭐ THE ROW CARRIES THE WHOLE ENTRY [Diego, 2026-10-06: "If it's on and has
 * configuration, it can all be in the same place"]. ⛔ Until that evening a push sent
 * the address and the options as `settings.<name>` beside the row — the two places
 * this module exists to replace, moved from `site.yml` onto the wire.
 *
 * ⭐ AN ADDRESS MEANS THE SITE BRINGS ITS OWN PROVIDER [Diego, 2026-10-06], so the
 * host is asked to leave its own off — a host's offer outranks the site's address
 * (`core/src/services.js`), and would otherwise win.
 *
 * ⭐ ONE REQUEST, WHICHEVER BACKEND A COMMAND TALKS TO. The rows a backend holds for
 * the site are kept apart, in that backend's entry in `sync.json` — the CLI's record
 * of what it last agreed with that site, which nobody edits.
 *
 * Pure functions, shared by the static build (`content-collector.js`), the producer
 * (`site.js`), pull (`site-project.js`) and the CLI's push, publish and doctor.
 *
 * Spec: kb/framework/reference/site-services-request.md
 *
 * @module
 */

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The options each service's RUNTIME reads from the site's config — the framework's
 * own vocabulary, which `uniweb doctor` checks an entry against. On the wire they ride
 * in the row's `config` with everything else; this list decides nothing there.
 *
 * ⚠️ Read off the readers, and owed to them: `Website.getSearchConfig` and kit's search
 * client, and the search index `@uniweb/projections` builds (search); `readEndpoint`
 * (every `endpoint`); `wireTracker` (tracking). A key one of them starts reading
 * belongs here, or `doctor` calls it unknown.
 */
export const RUNTIME_KEYS = Object.freeze({
  search: Object.freeze(['enabled', 'provider', 'endpoint', 'include', 'exclude', 'fields', 'weight']),
  submit: Object.freeze(['enabled', 'endpoint']),
  assistant: Object.freeze(['enabled', 'endpoint']),
  tracking: Object.freeze(['enabled', 'endpoint', 'emit', 'consent', 'scripts', 'flushIntervalMs', 'debug']),
  api: Object.freeze(['enabled', 'endpoint'])
})

/**
 * Services only a host provides, which a site never answers itself: no address, no
 * runtime part. A site does not declare its own record provider — a third-party
 * source is a foundation transport.
 */
const HOST_ONLY = new Set(['records'])

/**
 * Credential-shaped keys, mirroring the set the delivery edge strips on the reading
 * side — deliberately the SAME list, so the two guards are visibly twins. Never sent
 * and never published: a key belongs in the host's secret store, set in the app.
 */
const CREDENTIAL_KEYS = Object.freeze(['apiKey', 'api_key', 'key', 'token', 'secret'])

/** The top-level keys `services:` replaced, refused by name. */
const RETIRED_SERVICE_KEYS = Object.freeze(['search', 'submit', 'assistant', 'tracking', 'api'])

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
function stable(value) {
  return JSON.stringify(value ?? null, (_k, v) =>
    isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  )
}

/**
 * A row as it is stored and compared: no payload-local `$id`, `enabled` only when
 * it is `false` (absent means on), no empty `config`.
 */
function canonicalRow(row) {
  const { $id: _id, enabled, ...rest } = row
  const out = { ...rest }
  if (enabled === false) out.enabled = false
  if (isMap(out.config) && Object.keys(out.config).length === 0) delete out.config
  return out
}

const rowNamed = (rows, name) =>
  Array.isArray(rows) ? rows.find((r) => isMap(r) && r.name === name) : undefined

/** The address an entry names, or null — a string, or a map's `endpoint`. */
function addressOf(value) {
  if (typeof value === 'string') return value.trim() || null
  if (isMap(value) && typeof value.endpoint === 'string' && value.endpoint.trim()) return value.endpoint.trim()
  return null
}

/** The keys of a map the runtime reads for this service. */
function isRuntimeKey(name, key) {
  const keys = RUNTIME_KEYS[name]
  return keys ? keys.includes(key) : true
}

/** A map without its credential-shaped keys, and which ones it had. */
function withoutCredentials(value) {
  const found = CREDENTIAL_KEYS.filter((k) => k in value)
  if (!found.length) return { value, found }
  const out = { ...value }
  for (const k of found) delete out[k]
  return { value: out, found }
}

function sayCredentials(name, found, warn) {
  if (found.length) {
    warn(
      `\`services.${name}\` carries ${found.map((k) => `\`${k}\``).join(', ')} — a credential is never sent ` +
        'or published. Set it in the app, where secrets are kept.'
    )
  }
}

/**
 * Refuse the top-level keys `services:` replaced.
 *
 * @param {object} siteYml
 * @param {string} [where]
 * @throws {Error} naming each key and how to move it
 */
export function refuseRetiredServiceKeys(siteYml, where = 'site.yml') {
  if (!isMap(siteYml)) return
  const found = RETIRED_SERVICE_KEYS.filter((k) => siteYml[k] !== undefined)
  if (!found.length) return
  const lines = found.map((k) => `  ${k}: …`).join('\n')
  const api = found.includes('api')
    ? '\n  `api:` named the address a local mock answered on — in `uniweb dev`, `$devApi` now ' +
      'supplies it. Asking your host for an app backend is `api: true` under `services:`.'
    : ''
  throw new Error(
    `[uniweb] ${where}: ${found.map((k) => `\`${k}:\``).join(', ')} ` +
      `${found.length === 1 ? 'is' : 'are'} retired — a service lives under \`services:\`, ` +
      `one entry per service:\n\nservices:\n${lines}${api}`
  )
}

/**
 * Services whose settings are never published: only the switch and the address reach
 * the site's config. `api`'s settings are for the host that provisions it (a grade,
 * sign-in providers, billing) and no page reads them.
 */
const UNPUBLISHED_SETTINGS = new Set(['api'])

/**
 * One entry → what the site's config carries: `false`, an address, or the entry's
 * options — or undefined when there is nothing for it (`true` is the default).
 *
 * @param {string} name
 * @param {*} value - the entry
 * @returns {false|string|object|undefined}
 */
export function runtimeServiceConfig(name, value) {
  if (HOST_ONLY.has(name)) return undefined
  if (value === false) return false
  if (typeof value === 'string') return value.trim() || undefined
  if (!isMap(value)) return undefined
  const out = {}
  for (const [key, v] of Object.entries(withoutCredentials(value).value)) {
    if (!UNPUBLISHED_SETTINGS.has(name) || isRuntimeKey(name, key)) out[key] = v
  }
  if (out.enabled === true) delete out.enabled
  return Object.keys(out).length ? out : undefined
}

/**
 * `site.yml::services` → `{ <name>: <runtime value> }` for every entry the runtime
 * has something for — what a static payload's `config.<name>` carries.
 *
 * @param {*} declared
 * @param {{ warn?: (message: string) => void }} [opts]
 * @returns {object}
 */
export function runtimeServicesConfig(declared, { warn = () => {} } = {}) {
  const out = {}
  if (!isMap(declared)) return out
  for (const [name, value] of Object.entries(declared)) {
    if (isMap(value)) sayCredentials(name, withoutCredentials(value).found, warn)
    const runtime = runtimeServiceConfig(name, value)
    if (runtime !== undefined) out[name] = runtime
  }
  return out
}

/**
 * `site.yml::services` → the asks to the host, ONE row per entry, in the `services`
 * Section's shape: `{ name, enabled?: false, config? }`.
 *
 * `true` asks on; `false` asks off; a map asks on — or off, with `enabled: false` — and
 * its keys are the row's `config`. An address — a string, or `endpoint:` in a map — is
 * the site's own provider: it rides as `config.endpoint`, and the host is asked to
 * leave its own off, since a host's offer outranks the site's address
 * (`core/src/services.js`) and would otherwise win. `enabled` is the row's switch and
 * never in `config`; a credential never leaves at all.
 *
 * @param {*} declared - the raw `services:` value
 * @param {{ warn?: (message: string) => void }} [opts] - told about every value it
 *   ignores or trims, with the fix
 * @returns {object[]|null} null when the file asks nothing — no key, or no usable entry
 */
export function readServicesRequest(declared, { warn = () => {} } = {}) {
  if (declared === undefined || declared === null) return null
  if (!isMap(declared)) {
    warn('`services:` is a map of service names — `services: { search: true }`. Ignoring it.')
    return null
  }
  const asks = []
  for (const [name, value] of Object.entries(declared)) {
    if (value === true) {
      asks.push({ name })
      continue
    }
    if (value === false) {
      asks.push({ name, enabled: false })
      continue
    }
    if (typeof value !== 'string' && !isMap(value)) {
      warn(`\`services.${name}\` is true, false, an address, or a map. Ignoring it.`)
      continue
    }
    if (isMap(value) && value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      warn(`\`services.${name}.enabled\` is true or false. Ignoring \`${name}\`.`)
      continue
    }
    const address = addressOf(value)
    if (typeof value === 'string' && !address) continue // an empty string asks nothing
    if (address && HOST_ONLY.has(name)) {
      warn(`\`services.${name}\` has no address of its own — your host provides it. Ignoring \`${name}\`.`)
      continue
    }
    const { enabled, ...entry } = isMap(value) ? value : { endpoint: address }
    const { value: config, found } = withoutCredentials(entry)
    sayCredentials(name, found, warn)
    if (address) {
      config.endpoint = address
      // ⚠️ Said for `api` because its old spelling invites it: `api: /_api` was where a
      // local mock answered, and under `services:` an address turns the host's off.
      if (name === 'api') {
        warn(
          "`services.api` is an address: it asks your host to leave its own `api` off, so the site uses yours. " +
            "For your host's, write `api: true`; in `uniweb dev`, `$devApi` answers it."
        )
      }
    }
    asks.push({
      name,
      ...(address || enabled === false ? { enabled: false } : {}),
      ...(Object.keys(config).length ? { config } : {})
    })
  }
  return asks.length ? asks : null
}

/**
 * One row → the entry `site.yml::services` writes for it.
 *
 * An address with the host's own off is the site's own provider, written as the entry
 * was — a bare address when that is all it says. With the host's own on, the address
 * goes: the host's offer is what answers now, and it was turned on elsewhere.
 */
function entryFromRow(row) {
  const off = row.enabled === false
  const config = isMap(row.config) ? { ...row.config } : {}
  const address = addressOf(config)
  if (address && off) return Object.keys(config).length === 1 ? address : config
  if (address) delete config.endpoint
  if (!Object.keys(config).length) return !off
  return off ? { enabled: false, ...config } : config
}

/**
 * The credentials an author typed into an entry, kept on the one a pull writes over it.
 * A push never sends one — it is stripped, with a warning naming the app — so the site's
 * row cannot hold it, and writing the row whole would delete what the author typed.
 * ⛔ *Until 2026-10-06 they sat in top-level keys the writer merged one level deep,
 * which kept them; `services` is written whole.*
 */
function keepCredentials(entry, local) {
  if (!isMap(local)) return entry
  const found = CREDENTIAL_KEYS.filter((k) => k in local)
  if (!found.length) return entry
  const kept = Object.fromEntries(found.map((k) => [k, local[k]]))
  if (entry === true) return kept
  if (entry === false) return { enabled: false, ...kept }
  if (typeof entry === 'string') return { endpoint: entry, ...kept }
  return isMap(entry) ? { ...entry, ...kept } : entry
}

/**
 * The site's rows → the `site.yml::services` map — what pull writes.
 *
 * @param {object} p
 * @param {object[]} [p.rows] - the `services` Section: the site's settled request
 * @param {object} [p.local] - the `services:` the pull writes over, for the credentials
 *   a push never sends (`keepCredentials`)
 * @returns {object|null} null when there is nothing to write
 */
export function servicesFromDocument({ rows, local } = {}) {
  const before = isMap(local) ? local : {}
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name || row.name in out) continue
    out[row.name] = keepCredentials(entryFromRow(row), before[row.name])
  }
  return Object.keys(out).length ? out : null
}

/**
 * The `site.yml::services` map with these services taken from the site's rows — the
 * offer to bring the file in line. Each named entry becomes what its row says, keeping
 * only the author's credentials; a service the site holds no row for leaves the map.
 *
 * @param {*} declared - the current `services:` value
 * @param {object[]} stored - the site's rows now
 * @param {string[]} names
 * @returns {object|null} the new map, or null when nothing is left in it
 */
export function takeServices(declared, stored, names) {
  const out = isMap(declared) ? { ...declared } : {}
  for (const name of names) {
    const row = rowNamed(stored, name)
    if (row) out[name] = keepCredentials(entryFromRow(row), out[name])
    else delete out[name]
  }
  return Object.keys(out).length ? out : null
}

/**
 * What a row SAYS — its switch and its `config`, nothing else — so two rows compare by
 * the owner's decisions and not by fields a backend adds to what it stores.
 */
function said(row) {
  if (!isMap(row)) return null
  const out = {}
  if (row.enabled === false) out.enabled = false
  if (isMap(row.config) && Object.keys(row.config).length) out.config = row.config
  return out
}

/** Do two rows say the same — the switch and the whole `config`? Both absent included. */
function sameRow(a, b) {
  return stable(said(a)) === stable(said(b))
}

/**
 * The full list to send: the stored rows, with these asks applied by name.
 *
 * ⭐ A FULL LIST, because the backend replaces the `services` Section with what it is
 * sent, and deletes a service the list leaves out. A row no ask names is sent as
 * stored. A row an ask names takes the ask's switch and its `config` WHOLE — the entry
 * is sent as the file says it, so a setting removed from the file is removed
 * [Diego, 2026-10-07]. Every other field of the row is kept — a row is opaque past
 * `name`, `enabled` and `config`. ⛔ *Until then the ask's `config` was laid over the
 * stored one key by key, so a push could never remove a setting.*
 *
 * @param {object[]|null|undefined} base - the site's rows
 * @param {object[]} asks - from `readServicesRequest`
 * @returns {object[]}
 */
export function mergeServiceRows(base, asks) {
  const out = []
  const at = new Map()
  for (const row of Array.isArray(base) ? base : []) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name || at.has(row.name)) continue
    at.set(row.name, out.length)
    out.push(canonicalRow(row))
  }
  for (const ask of asks || []) {
    const index = at.get(ask.name)
    const next = index === undefined ? { name: ask.name } : { ...out[index] }
    if (ask.enabled === false) next.enabled = false
    else delete next.enabled
    if (ask.config) next.config = { ...ask.config }
    else delete next.config
    if (index === undefined) {
      at.set(ask.name, out.length)
      out.push(next)
    } else {
      out[index] = next
    }
  }
  return out
}

/**
 * Per service the file names: who moved since the last agreement, and so what to do.
 *
 * Three states — the file's asks, the site's rows now (`stored`), and the record of the
 * last agreement (`record`, from `sync.json`) — compared WHOLE, switch and `config`:
 *
 * | the file vs the record | the site vs the record | outcome |
 * |---|---|---|
 * | unchanged | unchanged | nothing |
 * | changed | unchanged | `send` |
 * | unchanged | changed | `adopt` — the site's is kept, and may be taken into the file |
 * | changed | changed, differently | `conflict` — only the owner can rank the two |
 *
 * A service the site already has exactly as the file says it is nothing, whoever moved.
 *
 * ⭐ THE RECORD SPEAKS FOR THE FILE ONLY FOR THE SERVICES THE FILE NAMED (`named`). A push
 * sends the full list, so the record also holds services the file never named — one set
 * in the app, say — and the file cannot have removed a setting it never had. A service
 * the file names for the first time is therefore `send` when the site holds nothing for
 * it, and `unseen` when the site holds it differently: the owner is asked, rather than a
 * setting made in the app being erased [Diego, 2026-10-07].
 *
 * ⛔ With the site's rows unreadable nothing is sent for a site that exists
 * (`unreadable`): the list goes whole, and the record cannot stand in for what the site
 * holds now. A site not yet created has nothing stored, so every ask is sent.
 *
 * @param {object} p
 * @param {object[]} p.asks - from `readServicesRequest`
 * @param {object[]} [p.record] - the rows last agreed
 * @param {string[]} [p.named] - the services the file named at the last agreement
 * @param {object[]} [p.stored] - the site's rows now, when they could be read
 * @param {boolean} [p.siteKnown=true] - whether the site exists on this backend
 * @returns {{ send: string[], adopt: string[], conflict: string[], unseen: string[], unreadable: boolean }}
 */
export function reconcileServices({ asks, record, named, stored, siteKnown = true }) {
  const send = []
  const adopt = []
  const conflict = []
  const unseen = []
  if (!Array.isArray(stored)) {
    return siteKnown
      ? { send, adopt, conflict, unseen, unreadable: true }
      : { send: asks.map((a) => a.name), adopt, conflict, unseen, unreadable: false }
  }
  const seen = new Set(Array.isArray(named) ? named : [])
  for (const ask of asks) {
    const now = rowNamed(stored, ask.name)
    if (sameRow(now, ask)) continue
    const then = seen.has(ask.name) ? rowNamed(record, ask.name) : undefined
    if (!then) {
      ;(now === undefined ? send : unseen).push(ask.name)
      continue
    }
    const fileMoved = !sameRow(then, ask)
    const siteMoved = !sameRow(now, then)
    if (fileMoved && !siteMoved) send.push(ask.name)
    else if (!fileMoved && siteMoved) adopt.push(ask.name)
    else if (fileMoved && siteMoved) conflict.push(ask.name)
  }
  return { send, adopt, conflict, unseen, unreadable: false }
}

/**
 * The record after a push: what this project now agrees with the site on.
 *
 * `services` — the rows sent, or, when nothing was, the site's rows now: the full list,
 * so a comparison made offline (`status`) rebuilds what was sent. ⛔ For a service left
 * OPEN (an adopt not taken, a conflict not resolved) the earlier agreement stands, or
 * the next run would read the site's change as the file's and send the stale ask.
 *
 * `servicesNamed` — the services the file names and now agrees on. A service the file
 * names for the first time and left open stays out, so it is asked about again; one it
 * named before keeps its place.
 *
 * @param {object} p
 * @param {object[]} [p.record] - the rows last agreed
 * @param {string[]} [p.named] - the services the file named at the last agreement
 * @param {object[]} [p.agreed] - the rows sent, or the site's rows now
 * @param {string[]} [p.open] - services whose decision is still open
 * @param {string[]} [p.names] - the services the file names now
 * @returns {{ services: object[], servicesNamed: string[] }|undefined} undefined when there
 *   is nothing to record
 */
export function recordAfter({ record, named, agreed, open = [], names = [] }) {
  if (!Array.isArray(agreed)) return undefined
  const keep = new Set(open)
  const services = agreed.filter((r) => isMap(r) && !keep.has(r.name)).map(canonicalRow)
  for (const name of open) {
    const then = rowNamed(record, name)
    if (then) services.push(canonicalRow(then))
  }
  const before = new Set(Array.isArray(named) ? named : [])
  const servicesNamed = [...new Set(names)].filter((n) => !keep.has(n) || before.has(n)).sort()
  return { services, servicesNamed }
}
