// `@/x` — a Model ref in the site's foundation's own scope — and its qualified form.
//
// `@/member` names a data schema in the foundation's own `schemas/`. It is
// AUTHORING shorthand: a backend resolves Models by name and never mints one, so a
// ref that leaves the CLI must be the name the Model was stored under,
// `@<scope>/member`. Everything that reads a ref off the wire matches it exactly —
// the entity store at restore, and a records service answering a hosted page's
// query.
//
// ⭐ ONE RULE FOR EVERY PATH THAT SHIPS A REF FROM ONE PUBLISH, and its inverse:
//
//   - a record's `$schema`            `records.js::buildRecordEntities`
//   - a query's `schema`              `site.js::queriesNested` (the `queries` Section)
//   - the author's spelling, on pull  `records-project.js` (placement and declarations)
//
// ⛔ They must agree on one scope. When the query path shipped `@/member` verbatim
// while the records beside it were qualified, the query named a Model its own
// records were not stored under: a hosted page's question named a Model that does
// not exist, the records service refused that key, and the section rendered
// nothing — the key absent from `content.data`, the reason only on
// `block.dataError`, the console clean. Nothing on either side was malformed; the
// two paths disagreed.
//
// ⭐ THE SCOPE IS THE FOUNDATION'S — the one in its name (`@acme/marketing`), which is
// the scope `register` stored the foundation's own data schemas under
// (`registry-package.js`). ⛔ Until 2026-09-22 every path above qualified with the org
// that owns the SITE instead — a stand-in that holds only when one org owns both, and
// a foundation may be registered under any org its author belongs to [Diego]. A site
// owned by `@client` on a foundation registered as `@acme/fnd` shipped its records as
// `@client/member`, a Model `register` never stored; a personal site shipped
// `@/member` unresolved (both measured). `siteSelfScope` is where the scope comes from.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { isStandardSchema } from '@uniweb/schemas'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { detectFoundationType, parseCatalogRef } from '../site/foundation-ref.js'
import { readFoundationName } from '../schema.js'
import { splitFoundationName } from '../foundation-name.js'

/**
 * A scope as it may be written — `@acme`, `acme`, or `@acme/…` — reduced to the bare
 * handle, or `''`.
 *
 * @param {unknown} scope
 * @returns {string}
 */
export function bareOrg(scope) {
  return typeof scope === 'string' ? scope.replace(/^@/, '').replace(/\/.*$/, '') : ''
}

/**
 * `@/x` → `@<scope>/x`. Any other ref (`@std/x`, `@acme/x`) passes through, and so
 * does `@/x` when no scope is known — callers that ship an unresolved alias say so
 * themselves (`buildRecordEntities` warns per query).
 *
 * @param {unknown} ref
 * @param {unknown} scope - the site's foundation's scope (`siteSelfScope`)
 * @returns {unknown}
 */
export function resolveSelfScope(ref, scope) {
  const handle = bareOrg(scope)
  return typeof ref === 'string' && ref.startsWith('@/') && handle
    ? `@${handle}/${ref.slice(2)}`
    : ref
}

/**
 * The inverse, for a pull: `@<scope>/x` → `@/x` — when `x` is one of the foundation's
 * OWN data schemas.
 *
 * ⛔ WITHOUT THIS THE ROUND TRIP IS NOT A FIXED POINT, and the failure is silent
 * on both ends. A record authored under `records/article/` comes back as
 * `@acme/article` and, placed literally, lands under `records/acme/article/` — a
 * different schema folder, which the next build reads as a different schema. A
 * query declared `schema: '@/member'` comes back as `@acme/member`, and one that
 * relied on the query-name default comes back with an explicit schema it never
 * had.
 *
 * ⛔ AND NOT EVERY `@<scope>/x` WAS AN `@/x`: the forward rule is not one-to-one. A
 * foundation in `@std` — every template's — whose site also uses the STANDARD
 * `@std/person` ships both its own `@/specimen` and that `@std/person` as `@std/…`.
 * Inverted whole, as it was until 2026-09-25, the standard schema came back as the
 * foundation's own: a clone put `@std/person` records in `records/person/` and
 * rewrote the query to `@/person`, and a pull into a working copy wrote them BESIDE
 * the author's `records/std/person/`, after which every reference to a person named
 * two records and the next push was refused. So `x` is written back as `@/x` only
 * when it is the foundation's own: one of `own`, the names its declarations define
 * (`ownSchemaNames`) — or, when those cannot be read here (its foundation is not in
 * this project, as after a clone), any name that is not a standard schema of `@std`.
 *
 * A model scoped to ANY OTHER scope is left alone: it genuinely is that org's, and
 * `@/` would be a lie.
 *
 * @param {unknown} ref
 * @param {unknown} scope - the scope the pulled records were qualified with
 * @param {Set<string>|null} [own] - the names of the data schemas the foundation
 *        defines, when known
 * @returns {unknown}
 */
export function unresolveSelfScope(ref, scope, own = null) {
  const handle = bareOrg(scope)
  if (typeof ref !== 'string' || !handle || !ref.startsWith(`@${handle}/`)) return ref
  const name = ref.slice(handle.length + 2)
  const isOwn = own ? own.has(name) : !(handle === 'std' && isStandardSchema(name))
  return isOwn ? `@/${name}` : ref
}

/**
 * The names of the data schemas a foundation DEFINES — the `@/x` keys of its built
 * declarations (`dist/meta/schema.json` → `dataSchemas`), which is what `register`
 * registers. A schema it only references keeps its scope there (`@std/person`) and is
 * not one of them. Null when there are no declarations to read.
 *
 * @param {object|null} dataSchemas - a foundation's `dataSchemas` map
 * @returns {Set<string>|null}
 */
export function ownSchemaNames(dataSchemas) {
  if (!dataSchemas || typeof dataSchemas !== 'object') return null
  return new Set(
    Object.keys(dataSchemas)
      .filter((ref) => ref.startsWith('@/'))
      .map((ref) => ref.slice(2))
  )
}

/**
 * The scope a site's `@/x` refs resolve into: its foundation's, `@org` — or null
 * when it has none yet.
 *
 * - `foundation` given (a pull passes the pinned ref the pushed site carries) — a
 *   catalog ref's scope, or a local foundation's, resolved from that value.
 * - else `foundationDir` — that local foundation's; when its name has none, the scope of
 *   the release `site.yml::foundation` pins for it, if that names the same foundation.
 * - else `site.yml::foundation`, the same way.
 *
 * A local foundation's scope is the one in its name, read by the one rule
 * (`readFoundationName`, the reader `register` and `push` use), so what a push pins
 * and what it qualifies with cannot differ. A bare name has no scope until `register`
 * gives it one; a URL foundation has none.
 *
 * ⚠️ A foundation whose name cannot be read (a leftover `uniweb.scope`, a `main.js`
 * that fails to load) answers null here. `register` — which a push and a publish run
 * first — says why; this only qualifies.
 *
 * @param {string} siteRoot
 * @param {{ foundation?: unknown, foundationDir?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export async function siteSelfScope(siteRoot, { foundation, foundationDir } = {}) {
  if (foundation === undefined && foundationDir) {
    const dir = resolve(foundationDir)
    return (await localFoundationScope(dir)) ?? (await pinnedReleaseScope(siteRoot, dir))
  }
  const declared = foundation !== undefined ? foundation : readDeclaredFoundation(siteRoot)
  const value = declared && typeof declared === 'object' ? declared.name : declared
  if (typeof value !== 'string' || !value) return null
  const ref = parseCatalogRef(value)
  if (ref) return ref.scope
  let info = null
  try {
    info = detectFoundationType(value, siteRoot)
  } catch {
    return null
  }
  return info?.type === 'local' && info.path ? localFoundationScope(info.path) : null
}

async function localFoundationScope(dir) {
  try {
    const { name } = await readFoundationName(dir)
    return splitFoundationName(name).scope
  } catch {
    return null
  }
}

// ⭐ A LOCAL FOUNDATION WHOSE NAME CARRIES NO SCOPE, handed in as the source of the release
// the site pins (`site.yml::foundation: '@std/lab@0.1.0'`, the same name): that release's
// scope. The site's pin IS the foundation's name with its scope, and the local folder is its
// source. It arises when a registration was written to a file (`register --scope @std -o`),
// which writes nothing into the source — so a push given the source (`--foundation <dir>`)
// found a bare name and shipped every `@/x` unresolved (measured 2026-09-25: records of `@/team`
// shipped as static files). ⛔ Only for the same name: a pin of another foundation says
// nothing about this one's scope.
async function pinnedReleaseScope(siteRoot, dir) {
  const declared = readDeclaredFoundation(siteRoot)
  const ref = parseCatalogRef(declared && typeof declared === 'object' ? declared.name : declared)
  if (!ref?.scope) return null
  try {
    const { name } = await readFoundationName(dir)
    return splitFoundationName(name).bare === ref.name ? ref.scope : null
  } catch {
    return null
  }
}

function readDeclaredFoundation(siteRoot) {
  try {
    const siteYml = yaml.load(readFileSync(join(siteRoot, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
    return siteYml.foundation ?? null
  } catch {
    return null
  }
}

/**
 * Refuse the retired `org` option.
 *
 * ⛔ It carried the org that owns the SITE, and qualified a site's `@/x` refs with it
 * (until 2026-09-22). Ignoring it would be silent, so a caller still passing it is told
 * what replaced it: the foundation's scope, derived — or `scope`, to state it.
 *
 * @param {object|undefined} opts
 * @param {string} where - the function, for the message
 */
export function refuseOrgOption(opts, where) {
  if (opts && opts.org !== undefined) {
    throw new Error(
      `${where}: \`org\` is no longer read — a site's \`@/x\` refs resolve into its ` +
        `foundation's scope (the one in the foundation's name). Pass \`scope\` to state it.`
    )
  }
}
