/**
 * `sync.json` — what each backend minted, keyed by origin.
 *
 * ## What it is
 *
 * Every id in this file was assigned by a backend and is meaningless against any
 * other one: a site uuid, a record's uuid, an asset's content-addressed id. The
 * file is **committed**, because a teammate who clones the project otherwise holds
 * content with no way to say which site on which backend it is.
 *
 * ⭐ **If it changed, something got synced.** Nothing else writes it — which is the
 * whole reason it is separate from `deploy.yml`, whose diff means "a target changed".
 *
 * Spec: `kb/framework/reference/sync-json.md`. Why it exists at all:
 * `kb/framework/plans/backend-scoped-project-state.md`.
 *
 * ## Why it is keyed by ORIGIN, all the way down
 *
 * A project may sync with any number of backends. Nothing can be shared between
 * them, so nothing is: each origin gets its own section and they never merge.
 *
 * ⭐ **The payoff is a guard that stops existing.** Identity used to sit in
 * `site.yml` as a single `$uuid`, with `$backend` recording which backend it came
 * from and `assertSiteBackendScope` refusing a command whose origin disagreed.
 * Here there is no configuration in which backend A's ids can reach B — you read
 * A's section for A — so there is no mismatch to detect.
 *
 * ## ⛔ No dependencies, by requirement
 *
 * `clone` writes a site's identity BEFORE `pnpm install` has run, so the writer has
 * to work with nothing installed. `site.yml`'s equivalent needed a hand-rolled
 * dependency-free fallback for exactly this (`cli/utils/site-identity.js`); JSON
 * needs no parser, so this module uses `node:fs` and nothing else.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SYNC_STORE_FILE = 'sync.json'

/** Current on-disk shape. Bumped only for a breaking layout change. */
const VERSION = 1

/** Map sections — merged entry by entry. Anything else in a patch replaces. */
const MAP_SECTIONS = new Set(['records', 'items', 'queries', 'folders', 'assets'])

const storePath = (siteDir) => join(siteDir, SYNC_STORE_FILE)

/**
 * A bare origin with no trailing slash, or null when unparseable.
 *
 * Callers may pass a whole endpoint URL — `http://localhost:8080/dev/site/…` and
 * `http://localhost:8080` address the same backend. `https://x` and `http://x` do
 * not: a scheme change is a different backend, not the same one reached differently.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/**
 * The whole file, normalized. A missing, unreadable or malformed file reads as
 * empty rather than throwing: this is a record, and a corrupt one must never be the
 * reason a push fails. The next write repairs it.
 *
 * @param {string} siteDir
 * @returns {{ version: number, backends: Record<string, object> }}
 */
export function readSyncStore(siteDir) {
  const empty = { version: VERSION, backends: {} }
  const p = storePath(siteDir)
  if (!existsSync(p)) return empty
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    const backends = parsed?.backends
    if (!backends || typeof backends !== 'object' || Array.isArray(backends)) return empty
    const out = {}
    for (const [origin, state] of Object.entries(backends)) {
      const key = normalizeOrigin(origin)
      if (key && state && typeof state === 'object' && !Array.isArray(state)) out[key] = state
    }
    return { version: VERSION, backends: out }
  } catch {
    return empty
  }
}

/**
 * One backend's section, or `{}` when this project has never synced with it.
 *
 * ⛔ Returns a COPY at the top level, so a caller mutating it cannot write through
 * to the next read. The maps inside are shared — treat the whole thing as read-only
 * and go through `updateBackendMap` to change anything.
 *
 * @param {string} siteDir
 * @param {string} origin
 * @returns {object}
 */
export function readBackendState(siteDir, origin) {
  const key = normalizeOrigin(origin)
  if (!key) return {}
  const found = readSyncStore(siteDir).backends[key]
  return found ? { ...found } : {}
}

/** Every origin this project has synced with, sorted. */
export function listSyncedBackends(siteDir) {
  return Object.keys(readSyncStore(siteDir).backends).sort()
}

/**
 * Write the store, with every level sorted.
 *
 * ⛔ **Sorting is not tidiness.** A committed file that reorders itself produces a
 * diff on every push and teaches people to stop reading it — at which point a real
 * change to what a site is bound to passes unnoticed. Same rule, and the same
 * reason, as `assets.json`, which this file absorbs.
 */
function writeStore(siteDir, backends) {
  const sortedBackends = {}
  for (const origin of Object.keys(backends).sort()) {
    const state = backends[origin]
    const sortedState = {}
    for (const section of Object.keys(state).sort()) {
      const value = state[section]
      if (MAP_SECTIONS.has(section) && value && typeof value === 'object' && !Array.isArray(value)) {
        const sortedMap = {}
        for (const k of Object.keys(value).sort()) sortedMap[k] = value[k]
        sortedState[section] = sortedMap
      } else {
        sortedState[section] = value
      }
    }
    sortedBackends[origin] = sortedState
  }
  const text = JSON.stringify({ version: VERSION, backends: sortedBackends }, null, 2) + '\n'
  const p = storePath(siteDir)
  // A no-op write is worse than useless: it dirties `git status` on a push that
  // changed nothing, which is the other half of the diff-stability rule above.
  if (existsSync(p)) {
    try {
      if (readFileSync(p, 'utf8') === text) return false
    } catch {
      /* unreadable — fall through and replace it */
    }
  }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return true
}

/**
 * Merge `patch` into one backend's section.
 *
 * **Map sections merge entry by entry; everything else replaces.** A push carries
 * only what that run touched, so replacing a map would drop every entry it happened
 * not to mention — which is most of them on a partial push. `services` and
 * `secrets` are arrays and a whole projection from the backend, so replacing is
 * right for those.
 *
 * @param {string} siteDir
 * @param {string} origin
 * @param {object} patch - e.g. `{ site: { uuid }, records: { 'a.md': 'uuid' } }`
 * @returns {boolean} whether the file changed
 */
export function updateBackendState(siteDir, origin, patch) {
  const key = normalizeOrigin(origin)
  if (!key || !patch || typeof patch !== 'object') return false
  const { backends } = readSyncStore(siteDir)
  const prior = backends[key] || {}
  const next = { ...prior }

  for (const [section, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (MAP_SECTIONS.has(section) && value && typeof value === 'object' && !Array.isArray(value)) {
      next[section] = { ...(prior[section] || {}), ...value }
    } else if (section === 'site' && value && typeof value === 'object') {
      // The identity object merges too: a create knows the uuid, the org prompt
      // that follows knows the handle, and neither should erase the other.
      next[section] = { ...(prior[section] || {}), ...value }
    } else {
      next[section] = value
    }
  }

  backends[key] = next
  return writeStore(siteDir, backends)
}

/**
 * Merge entries into one map section, with an optional per-entry rule.
 *
 * `merge(next, prior)` decides what an entry becomes when one already exists, and
 * returns `undefined` to leave the stored one alone. Without it, the incoming entry
 * wins. Assets use it to carry a `served` fingerprint forward across a push that
 * learned an id without learning an address.
 *
 * @param {string} siteDir
 * @param {string} origin
 * @param {string} section - one of `records` `items` `queries` `folders` `assets`
 * @param {Record<string, *>} entries
 * @param {(next: *, prior: *) => *} [merge]
 * @returns {{ added: string[], changed: string[], written: boolean }}
 */
export function updateBackendMap(siteDir, origin, section, entries, merge) {
  const key = normalizeOrigin(origin)
  const added = []
  const changed = []
  if (!key || !MAP_SECTIONS.has(section) || !entries || typeof entries !== 'object') {
    return { added, changed, written: false }
  }

  const { backends } = readSyncStore(siteDir)
  const prior = backends[key] || {}
  const map = { ...(prior[section] || {}) }

  for (const [k, incoming] of Object.entries(entries)) {
    if (incoming === undefined || incoming === null) continue
    const was = map[k]
    const value = was !== undefined && merge ? merge(incoming, was) : incoming
    if (value === undefined) continue
    if (was === undefined) added.push(k)
    else if (JSON.stringify(was) !== JSON.stringify(value)) changed.push(k)
    else continue
    map[k] = value
  }

  if (!added.length && !changed.length) return { added, changed, written: false }
  backends[key] = { ...prior, [section]: map }
  return { added, changed, written: writeStore(siteDir, backends) }
}

/**
 * The merge rule for the `assets` section — pass it to `updateBackendMap`.
 *
 * ⭐ **One definition, because three callers need it.** A push learns an id; only an
 * UPLOAD learns the address the host serves it at. So a push that re-records the same
 * bytes must not erase the `served` fingerprint an earlier one recorded, and a push
 * whose bytes changed must drop it — the old address no longer describes them.
 * Hand-rolled at each call site this is three chances to forget the second half.
 *
 * @param {{id: string, ext?: string, served?: string}} next
 * @param {{id: string, ext?: string, served?: string}} prior
 */
export function carryServed(next, prior) {
  if (next?.served || !prior || prior.id !== next?.id) return next
  return prior.served ? { ...next, served: prior.served } : next
}

/**
 * Forget one backend entirely. Every other backend is untouched — which is the
 * point of the keying, and the reason this is safe in a way clearing the old
 * single-valued identity never was.
 *
 * @returns {boolean} whether anything was removed
 */
export function clearBackend(siteDir, origin) {
  const key = normalizeOrigin(origin)
  if (!key) return false
  const { backends } = readSyncStore(siteDir)
  if (!backends[key]) return false
  delete backends[key]
  writeStore(siteDir, backends)
  return true
}

/**
 * The local ref a given asset id is known at for one backend, or null.
 *
 * Exists for `pull`, which meets stored content carrying an id and has to put the
 * file back at the path its author wrote rather than inventing one.
 */
export function refForAssetId(siteDir, origin, id) {
  if (!id) return null
  const assets = readBackendState(siteDir, origin).assets || {}
  for (const [ref, v] of Object.entries(assets)) {
    if (v && v.id === id) return ref
  }
  return null
}
