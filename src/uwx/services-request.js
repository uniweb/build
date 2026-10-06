/**
 * A site's services request — `site.yml::services`, a map from service name to
 * what the owner asks their host for.
 *
 * ```yaml
 * services:
 *   search: true       # turn it on
 *   submit: false      # turn it off
 *   api:               # turn it on, with the service's own settings
 *     grade: pro
 * ```
 *
 * ⭐ ONE REQUEST, WHICHEVER BACKEND A COMMAND TALKS TO. The rows a backend holds
 * for the site are kept apart from it, in that backend's entry in `sync.json` — the
 * CLI's record of what it last agreed with that site, which nobody edits.
 *
 * ⛔ NOT THE TOP-LEVEL `search:` / `submit:` / `assistant:` / `tracking:` KEYS.
 * Those say how the site uses a provider it brings itself; this asks the host. A
 * site's own `submit: https://forms.example.com/…` read as a request would turn on
 * the host's form handling, whose address then outranks the site's.
 *
 * Pure functions, shared by the producer (`site.js`), pull (`site-project.js`) and
 * the CLI's push and publish.
 *
 * @module
 */

/** Top-level `site.yml` keys that hold an address — named when one is misplaced here. */
const ADDRESS_KEYS = new Set(['search', 'submit', 'assistant', 'tracking', 'api'])

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

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

/**
 * `site.yml::services` → the asks, as rows in the `services` Section's shape:
 * `{ name, enabled?: false, config? }`.
 *
 * @param {*} declared - the raw `services:` value
 * @param {{ warn?: (message: string) => void }} [opts] - told about every value it
 *   ignores, with the fix
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
    if (value === true) asks.push({ name })
    else if (value === false) asks.push({ name, enabled: false })
    else if (isMap(value)) {
      const { enabled, ...settings } = value
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        warn(`\`services.${name}.enabled\` is true or false. Ignoring \`${name}\`.`)
        continue
      }
      asks.push({
        name,
        ...(enabled === false ? { enabled: false } : {}),
        ...(Object.keys(settings).length ? { config: settings } : {})
      })
    } else {
      const address =
        typeof value === 'string' && ADDRESS_KEYS.has(name)
          ? ` An address for the site's own ${name} goes in the top-level \`${name}:\` key.`
          : ''
      warn(`\`services.${name}\` is true, false, or a map of its settings. Ignoring it.${address}`)
    }
  }
  return asks.length ? asks : null
}

/**
 * The site's stored rows → the `site.yml::services` map — what pull writes.
 *
 * A row becomes `true` or `false`, or a map of its settings with `enabled: false`
 * when it is off.
 *
 * @param {object[]} rows
 * @returns {object|null} null when there is nothing to write
 */
export function servicesRequestFromRows(rows) {
  if (!Array.isArray(rows)) return null
  const out = {}
  for (const row of rows) {
    if (!isMap(row) || typeof row.name !== 'string' || !row.name) continue
    out[row.name] = requestValue(row)
  }
  return Object.keys(out).length ? out : null
}

/** One stored row → its value in the `site.yml::services` map. */
function requestValue(row) {
  const off = row.enabled === false
  const settings = isMap(row.config) && Object.keys(row.config).length ? row.config : null
  if (!settings) return !off
  return off ? { enabled: false, ...settings } : { ...settings }
}

/**
 * The `site.yml::services` map with these services taken from the site's rows — a
 * service the site holds no row for leaves the map.
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
    if (row) out[name] = requestValue(row)
    else delete out[name]
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
