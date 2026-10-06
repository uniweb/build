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
 * Each entry is ROUTED, here and nowhere else:
 *
 *   - **to the site's config** (`config.<name>` in a payload, `settings.<name>` on the
 *     sync wire) — the switch, an address, and the entry's options, as the retired
 *     top-level keys carried them: a host reads some of them there too (the
 *     assistant's `system` persona). ⛔ Except `api`, whose settings are for the host
 *     that provisions it: only its switch and address are published. Never a
 *     credential.
 *   - **to the host** (the `services` Section, a request) — the switch, and every key
 *     the framework's runtime does not read (`RUNTIME_KEYS`) as the host's settings.
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
 * own vocabulary. Every other key of a known service is the host's setting, sent with
 * the request; a service the framework does not know (the registry is open) sends
 * every key, since only its reader knows which are whose.
 *
 * ⚠️ Read off the readers, and owed to them: `Website.getSearchConfig` and kit's search
 * client (search), `readEndpoint` (every `endpoint`), `wireTracker` (tracking). A key
 * one of them starts reading belongs here — or the host is sent it as a setting it
 * never asked for, and for `api`, whose settings are not published, it never reaches
 * the page at all.
 */
export const RUNTIME_KEYS = Object.freeze({
  search: Object.freeze(['enabled', 'provider', 'endpoint', 'include', 'exclude']),
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
 * `site.yml::services` → the asks to the host, as rows in the `services` Section's
 * shape: `{ name, enabled?: false, config? }`.
 *
 * `true` asks on; `false` asks off; an address asks the host to leave its own off —
 * the site brings its own; a map asks on (or off, with `enabled: false`), with every
 * key the runtime does not read as the host's settings.
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
    if (typeof value === 'string' || isMap(value)) {
      if (isMap(value) && value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        warn(`\`services.${name}.enabled\` is true or false. Ignoring \`${name}\`.`)
        continue
      }
      if (addressOf(value)) {
        if (HOST_ONLY.has(name)) {
          warn(`\`services.${name}\` has no address of its own — your host provides it. Ignoring \`${name}\`.`)
          continue
        }
        // The site brings its own provider: the host's stays off. ⚠️ Only the services
        // with a `settings` slot carry the address with the site; any other one's goes
        // nowhere on a push, which a silent off would hide.
        if (!SETTINGS_SERVICES.includes(name)) {
          warn(
            `\`services.${name}\` is an address, which a push does not carry (only search's, submit's, ` +
              `assistant's and tracking's travel with the site) — and it asks your host to leave its own ` +
              `\`${name}\` off.` +
              (name === 'api' ? " For your host's, write `api: true`; `$devApi` answers it in `uniweb dev`." : '')
          )
        }
        asks.push({ name, enabled: false })
        continue
      }
      if (typeof value === 'string') continue // an empty string asks nothing
      const { value: kept, found } = withoutCredentials(value)
      sayCredentials(name, found, warn)
      const settings = {}
      for (const [key, v] of Object.entries(kept)) {
        if (key === 'enabled' || key === 'endpoint') continue
        if (!RUNTIME_KEYS[name] || !isRuntimeKey(name, key)) settings[key] = v
      }
      asks.push({
        name,
        ...(value.enabled === false ? { enabled: false } : {}),
        ...(Object.keys(settings).length ? { config: settings } : {})
      })
      continue
    }
    warn(`\`services.${name}\` is true, false, an address, or a map. Ignoring it.`)
  }
  return asks.length ? asks : null
}

/** The `settings` slots the sync wire carries a service's runtime part in. */
export const SETTINGS_SERVICES = Object.freeze(['search', 'submit', 'assistant', 'tracking'])

/**
 * One service, as `site.yml::services` writes it, from its runtime part and its row.
 *
 * The row decides on or off — it is the site's settled request — and carries the
 * host's settings; the runtime part carries the options. An address with the host's
 * service off is the site's own provider, written as it was; with the host's on, the
 * address is dropped, because the host's offer is what answers.
 */
function composeEntry(runtime, row) {
  const address = addressOf(runtime)
  if (address && (!row || row.enabled === false)) return runtime
  const on = row ? row.enabled !== false : !(runtime === false || (isMap(runtime) && runtime.enabled === false))
  const options = {}
  if (isMap(runtime)) {
    for (const [key, v] of Object.entries(runtime)) {
      if (key === 'enabled' || (key === 'endpoint' && row && on)) continue
      options[key] = v
    }
  }
  const settings = isMap(row?.config) ? row.config : {}
  if (!Object.keys(options).length && !Object.keys(settings).length) return on
  return { ...(on ? {} : { enabled: false }), ...options, ...settings }
}

/**
 * What the wire never carries, kept from the entry a pull writes over — so a pull does
 * not delete what the author typed and a push could not send:
 *
 *   - **an address for a service with no `settings` slot** (`api`, or one the framework
 *     does not know) — a static build's own provider. The push sent only `enabled:
 *     false`, so the row comes back off; while it stays off, the file's entry stands.
 *     Once the host's is on, the host's answers and the address goes, as everywhere.
 *   - **a credential** — stripped on every push, with a warning naming the app.
 *
 * ⛔ *Until 2026-10-06 these lived in top-level keys a pull merged one level deep, which
 * kept them; `services` is replaced whole, which would not.*
 */
function keepLocal(name, entry, local, row) {
  if (local === undefined) return entry
  if (!SETTINGS_SERVICES.includes(name) && !HOST_ONLY.has(name) && addressOf(local) && row?.enabled === false) {
    return local
  }
  if (!isMap(local)) return entry
  const { found } = withoutCredentials(local)
  if (!found.length) return entry
  const kept = Object.fromEntries(found.map((k) => [k, local[k]]))
  if (entry === true) return kept
  if (entry === false) return { enabled: false, ...kept }
  if (typeof entry === 'string') return { endpoint: entry, ...kept }
  return isMap(entry) ? { ...entry, ...kept } : entry
}

/**
 * The site's stored rows and runtime parts → the `site.yml::services` map — what pull
 * writes.
 *
 * @param {object} p
 * @param {object[]} [p.rows] - the `services` Section: the site's settled request
 * @param {object} [p.settings] - the `settings` Section: each service's runtime part
 * @param {object} [p.local] - the `services:` the pull writes over, for what the wire
 *   never carries (`keepLocal`)
 * @returns {object|null} null when there is nothing to write
 */
export function servicesFromDocument({ rows, settings, local } = {}) {
  const runtime = {}
  const names = []
  for (const name of SETTINGS_SERVICES) {
    if (isMap(settings) && settings[name] !== undefined) {
      runtime[name] = settings[name]
      names.push(name)
    }
  }
  const byName = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name) continue
    byName.set(row.name, row)
    if (!names.includes(row.name)) names.push(row.name)
  }
  const out = {}
  const before = isMap(local) ? local : {}
  for (const name of names) {
    const row = byName.get(name)
    out[name] = keepLocal(name, composeEntry(runtime[name], row), before[name], row)
  }
  return Object.keys(out).length ? out : null
}

/**
 * The `site.yml::services` map with these services taken from the site's rows — the
 * offer to bring the file in line. The entry's options stay; the row's switch and
 * settings replace the file's, and an own address goes when the site's host now
 * provides the service. A service the site holds no row for leaves the map.
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
    if (!row) {
      delete out[name]
      continue
    }
    const current = out[name]
    const runtime = runtimeServiceConfig(name, current)
    out[name] = composeEntry(isMap(runtime) || typeof runtime === 'string' ? runtime : undefined, row)
  }
  return Object.keys(out).length ? out : null
}

/**
 * Does this stored row already give what the ask asks — the same switch, and every
 * setting the ask names equal?
 *
 * @param {object|undefined} row
 * @param {object} ask
 * @returns {boolean}
 */
export function satisfies(row, ask) {
  if (!isMap(row)) return false
  if ((row.enabled === false) !== (ask.enabled === false)) return false
  if (!ask.config) return true
  const stored = isMap(row.config) ? row.config : {}
  return Object.entries(ask.config).every(([key, value]) => stable(stored[key]) === stable(value))
}

/** Two rows that are the same as stored — both absent included. */
function sameRow(a, b) {
  return stable(isMap(a) ? canonicalRow(a) : null) === stable(isMap(b) ? canonicalRow(b) : null)
}

/**
 * The full list to send: the stored rows, with these asks applied by name.
 *
 * ⭐ A FULL LIST, because the backend replaces the `services` Section with what it is
 * sent: a row left out would lose its stored settings. A row no ask names is sent as
 * stored. A row an ask names takes the ask's switch, and its settings over the
 * stored ones, key by key. Every field is kept — a row is opaque past `name`,
 * `enabled` and `config`.
 *
 * @param {object[]|null|undefined} base - the site's rows (or the record of them)
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
    if (ask.config) next.config = { ...(isMap(next.config) ? next.config : {}), ...ask.config }
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
 * Three states — the file's asks, the site's rows now (`stored`), and the record of
 * the last agreement (`record`, from `sync.json`):
 *
 * | the file vs the record | the site vs the record | outcome |
 * |---|---|---|
 * | unchanged | unchanged | nothing |
 * | changed | unchanged | `send` |
 * | unchanged | changed | `adopt` — the site's is kept, and may be taken into the file |
 * | changed | changed, differently | `conflict` — only the owner can rank the two |
 *
 * A service the site already gives as asked is nothing, whoever moved. With no record
 * the two cannot be told apart: a service the site holds nothing for is sent, one it
 * holds differently is a conflict. With the site unreadable, what changed against the
 * record is sent over the record; with neither, nothing can be merged onto for a site
 * that exists — `unreadable` — while a site not yet created has nothing stored.
 *
 * @param {object} p
 * @param {object[]} p.asks - from `readServicesRequest`
 * @param {object[]} [p.record] - the rows last agreed, when the project has them
 * @param {object[]} [p.stored] - the site's rows now, when they could be read
 * @param {boolean} [p.siteKnown=true] - whether the site exists on this backend
 * @returns {{ send: string[], adopt: string[], conflict: string[], unreadable: boolean }}
 */
export function reconcileServices({ asks, record, stored, siteKnown = true }) {
  const send = []
  const adopt = []
  const conflict = []
  const haveRecord = Array.isArray(record)
  const haveStored = Array.isArray(stored)
  if (!haveRecord && !haveStored) {
    return siteKnown
      ? { send, adopt, conflict, unreadable: true }
      : { send: asks.map((a) => a.name), adopt, conflict, unreadable: false }
  }
  for (const ask of asks) {
    const now = rowNamed(stored, ask.name)
    const then = rowNamed(record, ask.name)
    if (!haveStored) {
      if (!satisfies(then, ask)) send.push(ask.name)
      continue
    }
    if (satisfies(now, ask)) continue
    if (!haveRecord) {
      ;(now === undefined ? send : conflict).push(ask.name)
      continue
    }
    const fileMoved = !satisfies(then, ask)
    const siteMoved = !sameRow(now, then)
    if (fileMoved && !siteMoved) send.push(ask.name)
    else if (!fileMoved && siteMoved) adopt.push(ask.name)
    else conflict.push(ask.name)
  }
  return { send, adopt, conflict, unreadable: false }
}

/**
 * The record after a push: what this project now agrees with the site on.
 *
 * The rows sent, or — when nothing was — the site's rows now. ⛔ For a service left
 * OPEN (an adopt not taken, a conflict not resolved) the earlier agreement stands,
 * or the next run would read the site's change as the file's and send the stale ask.
 *
 * @param {object} p
 * @param {object[]} [p.record] - the rows last agreed
 * @param {object[]} [p.agreed] - the rows sent, or the site's rows now
 * @param {string[]} [p.open] - services whose decision is still open
 * @returns {object[]|undefined} undefined when there is nothing to record
 */
export function recordAfter({ record, agreed, open = [] }) {
  if (!Array.isArray(agreed)) return undefined
  const keep = new Set(open)
  const out = agreed.filter((r) => isMap(r) && !keep.has(r.name)).map(canonicalRow)
  for (const name of open) {
    const then = rowNamed(record, name)
    if (then) out.push(canonicalRow(then))
  }
  return out
}
