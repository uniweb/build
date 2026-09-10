// `@/x` — a Model ref in the site's own foundation scope — and its qualified form.
//
// `@/member` names a data schema in the foundation's own `schemas/`. It is
// AUTHORING shorthand: a backend resolves Models by name and never mints one, so a
// ref that leaves the CLI must be the name the Model was stored under,
// `@<org>/member`. Everything that reads a ref off the wire matches it exactly —
// the entity store at restore, and a records service answering a hosted page's
// query.
//
// ⭐ ONE RULE FOR EVERY PATH THAT SHIPS A REF FROM ONE PUBLISH, and its inverse:
//
//   - a record's `$model`             `records.js::buildRecordEntities`
//   - a query's `schema`              `site.js::queriesNested` (the `queries` Section)
//   - the author's spelling, on pull  `records-project.js` (placement and declarations)
//
// ⛔ They must agree on one alias. When the query path shipped `@/member` verbatim
// while the records beside it were qualified, the query named a Model its own
// records were not stored under: a hosted page's question named a Model that does
// not exist, the records service refused that key, and the section rendered
// nothing — the key absent from `content.data`, the reason only on
// `block.dataError`, the console clean. Nothing on either side was malformed; the
// two paths disagreed.
//
// Registering a foundation qualifies its declarations separately, from the
// foundation's publish scope (`registry-package.js`). That is a different input
// (the foundation's scope, not the site's publish org) and stays there.

/**
 * An org handle as `--org` or `site.yml::$org` gives it — `@acme`, `acme`, or
 * `@acme/…` — reduced to the bare handle, or `''`.
 *
 * @param {unknown} org
 * @returns {string}
 */
export function bareOrg(org) {
  return typeof org === 'string' ? org.replace(/^@/, '').replace(/\/.*$/, '') : ''
}

/**
 * `@/x` → `@<org>/x`. Any other ref (`@std/x`, `@acme/x`) passes through, and so
 * does `@/x` when no org is known — callers that ship an unresolved alias say so
 * themselves (`buildRecordEntities` warns per query).
 *
 * @param {unknown} ref
 * @param {unknown} org
 * @returns {unknown}
 */
export function resolveSelfScope(ref, org) {
  const handle = bareOrg(org)
  return typeof ref === 'string' && ref.startsWith('@/') && handle
    ? `@${handle}/${ref.slice(2)}`
    : ref
}

/**
 * The inverse, for a pull: `@<org>/x` → `@/x` for the site's own org.
 *
 * ⛔ WITHOUT THIS THE ROUND TRIP IS NOT A FIXED POINT, and the failure is silent
 * on both ends. A record authored under `entities/article/` comes back as
 * `@acme/article` and, placed literally, lands under `entities/acme/article/` — a
 * different schema folder, which the next build reads as a different schema. A
 * query declared `schema: '@/member'` comes back as `@acme/member`, and one that
 * relied on the query-name default comes back with an explicit schema it never
 * had.
 *
 * ⭐ The site records its own org at create (`site.yml::$org` — "whose this is"),
 * which is exactly the inverse. A model scoped to ANOTHER org is left alone: it
 * genuinely is that org's, and `@/` would be a lie.
 *
 * @param {unknown} ref
 * @param {unknown} org
 * @returns {unknown}
 */
export function unresolveSelfScope(ref, org) {
  const handle = bareOrg(org)
  if (typeof ref !== 'string' || !handle) return ref
  return ref.startsWith(`@${handle}/`) ? `@/${ref.slice(handle.length + 2)}` : ref
}
