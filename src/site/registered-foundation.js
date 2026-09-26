/**
 * A REGISTERED FOUNDATION, AS A PROJECT THAT NAMES IT BY CATALOG REF KEEPS IT.
 *
 * A site whose foundation is a catalog ref (`@acme/fnd@1.2.0`) — every clone — has no build of it
 * to read from. What the project's own tools need from it is its section types' `data:`, which is
 * what types a query named for a data key (`uwx/data-key-types.js`). The CLI reads the registered
 * version from the backend the site is on and keeps the reply here, under `.uniweb/`; the build,
 * the push and the pull read it back through `foundationSchemaJson`.
 *
 * ⭐ A registered version never changes, so the copy never goes stale, and losing it costs a round
 * trip, never a wrong answer: the next push or pull reads it again. That is what makes `.uniweb/`
 * (gitignored, per copy) the right home for it.
 *
 * The reply is kept whole, as the backend answered it — its `schema` is the foundation schema a
 * build would emit, less its data schemas, which travel as Models.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCatalogRef } from './foundation-ref.js'

/** Where a project keeps a registered foundation's reply — null for anything but a catalog ref. */
export function registeredFoundationPath(siteRoot, ref) {
  const parsed = parseCatalogRef(ref)
  if (!parsed) return null
  return join(siteRoot, '.uniweb', 'foundations', parsed.scope, `${parsed.name}@${parsed.version}.json`)
}

/** The kept reply for a catalog ref, or null when the project keeps none. */
export function readRegisteredFoundation(siteRoot, ref) {
  const path = registeredFoundationPath(siteRoot, ref)
  if (!path || !existsSync(path)) return null
  try {
    const reply = JSON.parse(readFileSync(path, 'utf8'))
    return reply && typeof reply === 'object' ? reply : null
  } catch {
    return null
  }
}

/** Keep a registered foundation's reply. Returns whether it was written. */
export function writeRegisteredFoundation(siteRoot, ref, reply) {
  const path = registeredFoundationPath(siteRoot, ref)
  if (!path || !reply || typeof reply !== 'object') return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(reply, null, 2) + '\n')
  return true
}
