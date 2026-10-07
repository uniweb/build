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
 * ⭐ ONE REQUEST, WHICHEVER BACKEND A COMMAND TALKS TO. What a push sends is what the
 * file says, plus OFF for each service this copy holds that the file no longer lists
 * (`statedServices`); the services it holds are named, `{ name: $uuid }`, in that
 * backend's entry in `sync.json`, which nobody edits. The backend decides per service.
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
 * The site's rows → the `site.yml::services` map — what a pull writes.
 *
 * ⭐ AN OFF SERVICE WITH NO SETTINGS IS WRITTEN ONLY WHERE `site.yml` ALREADY NAMES IT
 * [Diego, 2026-10-07]. Every service is on or off, and off by default, so a `false` line
 * adds nothing — and writing one for every service switched off in the app, or for each
 * line the file dropped, would fill the file with them. So a pull writes a service that is
 * on, or that has settings (an own provider's address); and one that is off, as `false`,
 * where the file names it — a file listing a service the site has since switched off must
 * say so, or its next push switches it back on. The rows it leaves out are still held
 * (`sync.json`), and a push states them off, as the site has them (`statedServices`).
 * ⛔ *Until then every row was written, an off one as `false`.*
 *
 * ⚖️ What it gives up: a `false` an author wrote does not reach a fresh clone, whose
 * `site.yml` names nothing yet. It still means off there.
 *
 * @param {object} p
 * @param {object[]} [p.rows] - the `services` Section: the site's rows
 * @param {object} [p.local] - the `services:` the pull writes over — which services it
 *   names, and the credentials a push never sends (`keepCredentials`)
 * @returns {object|null} null when there is nothing to write
 */
export function servicesFromDocument({ rows, local } = {}) {
  const before = isMap(local) ? local : {}
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name || row.name in out) continue
    const entry = entryFromRow(row)
    if (entry === false && !(row.name in before)) continue
    out[row.name] = keepCredentials(entry, before[row.name])
  }
  return Object.keys(out).length ? out : null
}

/**
 * The `services` Section a push sends: every service `site.yml` lists, as it says it, and
 * OFF for every service this copy holds that the file does not list.
 *
 * ⭐ A PUSH STATES, AND THE BACKEND DECIDES PER SERVICE [Diego, 2026-10-07 —
 * kb/framework/plans/services-exchange.md]. Every service is on or off, off by default.
 *
 *   - A service the file lists goes WHOLE — its switch, and the entry as its `config` — so
 *     a setting removed from the file is removed.
 *   - A service this copy holds — a pull returned it, or a push sent it — and the file
 *     does not list is stated `{ name, enabled: false }`, with no settings. Deleting the
 *     line turns it off and removes its settings, which would otherwise stay live on the
 *     page, since a row's `config` reaches it whether the row is on or off, and come back
 *     with the next pull.
 *   - A service this copy never saw is not sent, and the site keeps it.
 *
 * A held service carries its `$uuid`, and the push sends the version of every item it
 * holds (`withBaseVersion`), so a service changed on the site since is kept when the file
 * left it as it was, and refused when the file changed it too.
 *
 * ⛔ *Until then a push sent the site's whole list, read just before it, with the file's
 * changed asks applied — a service left out was deleted — and the CLI kept its own copy
 * of the list in `sync.json` to tell who had changed what.*
 *
 * @param {object[]|null} asks - from `readServicesRequest`
 * @param {object} [held] - `{ <name>: <$uuid> }`, the services this copy holds (`sync.json`)
 * @returns {object[]} the rows; `[]` when there is nothing to state
 */
export function statedServices(asks, held = {}) {
  const ids = isMap(held) ? held : {}
  const uuidOf = (name) => (typeof ids[name] === 'string' && ids[name] ? ids[name] : null)
  const rows = []
  const listed = new Set()
  for (const ask of asks || []) {
    listed.add(ask.name)
    const row = { name: ask.name }
    if (ask.enabled === false) row.enabled = false
    if (ask.config) row.config = { ...ask.config }
    if (uuidOf(ask.name)) row.$uuid = uuidOf(ask.name)
    rows.push(row)
  }
  for (const name of Object.keys(ids).sort()) {
    if (listed.has(name) || !uuidOf(name)) continue
    rows.push({ name, enabled: false, $uuid: uuidOf(name) })
  }
  return rows
}

/**
 * The services this copy holds after a push or a pull — `{ <name>: <$uuid> }`, read from
 * the document the backend returned.
 *
 * A pull returns every service the site has, all seen (`sent` absent). A push returns the
 * site's rows after the write, which may include services added since this copy's last
 * pull: those were neither sent nor held before, so they are left out — held, a later
 * push would state them off, switching off a service nobody here has seen.
 *
 * @param {object} p
 * @param {object[]} [p.written] - the `services` rows the backend returned
 * @param {object[]} [p.sent] - the rows the push sent; absent for a pull
 * @param {object} [p.prior] - the services held before
 * @returns {object} the services now held
 */
export function heldServices({ written, sent, prior } = {}) {
  const before = isMap(prior) ? prior : {}
  const stated = Array.isArray(sent) ? new Set(sent.filter(isMap).map((r) => r.name)) : null
  const out = {}
  for (const row of Array.isArray(written) ? written : []) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name) continue
    if (typeof row.$uuid !== 'string' || !row.$uuid) continue
    if (stated && !stated.has(row.name) && !(row.name in before)) continue
    out[row.name] = row.$uuid
  }
  // Sorted: it is written to `sync.json`, a committed file that must not reorder itself.
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]))
}

/** What a row SAYS — its switch and its `config` — not the fields a backend adds to it. */
function said(row) {
  if (!isMap(row)) return null
  const out = {}
  if (row.enabled === false) out.enabled = false
  if (isMap(row.config) && Object.keys(row.config).length) out.config = row.config
  return out
}

/**
 * Whether the site holds a service as a push sent it: the switch and the WHOLE
 * `config`. ⛔ Not "equal on the keys we sent", which units use: an `on` row sends no
 * `enabled` and an entry with no settings no `config`, so a row the app switched off,
 * or gave settings, would read as ours.
 *
 * @param {object} sent - the row a push sent
 * @param {object} written - the site's row after it
 * @returns {boolean}
 */
export function sameServiceRow(sent, written) {
  return isMap(sent) && isMap(written) && stable(said(sent)) === stable(said(written))
}
