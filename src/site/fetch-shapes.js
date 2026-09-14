// What shape a `fetch:` declaration is, and what a PROJECTION may write back.
//
// ⛔ WHY THIS EXISTS. A `fetch:` declaration is a BINDING — it names a query — and
// accepts `query · as · where · sort · limit · current · …`, NOT `path`/`url`
// (`data-fetcher.js` RECOGNIZED_FETCH_KEYS). A string is a query name.
//
// (The source shape — `{ path }`, `{ url }` — and `refine: true` were retired on
// 2026-09-13; the build refuses both. `source` below classifies what a store may
// still hold from before, so a pull passes it through rather than guessing.)

//
// The build RESOLVES a `query:` shorthand into a concrete location, so the
// declaration that rides the sync wire carries BOTH the authored `query` and the
// derived `path`. Projecting that back verbatim writes a file that is neither
// shape cleanly: `collection` wins the classification, and the `path` beside it is
// then an unrecognized key on its own declaration.
//
// ⚠️ Measured on matinee 2026-08-29 — `push → pull → push`, where the third step is
// rejected by our OWN validator against a file our OWN projector had just written:
//
//   fetch:
//     path: /data/members.json     ← derived; also a build artifact path
//     schema: members
//     query: members               ← what the author actually wrote
//
//   [uniweb] fetch: unrecognized key "path" was ignored. Keys recognized on this
//   declaration: detailPage, filter, limit, merge, prerender, query, schema,
//   sort, transform, where.
//
// (That list is the one recognized on that date. `filter`, `schema`, `transform`
// and `merge` have been retired since.)
//
// ⭐ The round trip has to invert the resolution, not copy it. `/data/<name>.json`
// is a materialization of a query, never its definition — so it is precisely the
// thing an authored file should not contain.
//
// ⚖️ DROPS ONLY WHAT IS DERIVABLE, not everything unrecognized. A key we do not know
// might be one a newer producer authored, and silently discarding it on every pull
// would make the round trip lossy in a way nothing reports. `path` and `url` beside
// a `query` are recoverable from the query itself; anything else survives and the
// validator's warning stays the honest signal.
//
// ⛔ THE ONE EXCEPTION IS A RETIRED KEY THE BUILD REFUSES. `merge` (retired
// 2026-09-14) rode every section's fetch on the wire as `merge: false` — the parse
// emitted it as a default — so a site synced before then holds it in store. Written
// back, it would stop the next build; so it is dropped, whatever its value.

/** Which shape a declaration is — the same order `data-fetcher` uses. */
export function fetchShapeOf(fetch) {
  if (!fetch || typeof fetch !== 'object') return null
  if (fetch.query) return 'query'
  return 'source'
}

/** Keys a shape derives rather than the author writing them. */
const DERIVED_BY_SHAPE = {
  query: ['path', 'url'],
  source: []
}

/** Retired keys a store may still hold, which the build refuses — dropped from every shape. */
const RETIRED_KEYS = ['merge']

/**
 * The declaration as an author would have written it — the wire's resolved form
 * minus what the build derived, and minus a retired key the build would refuse.
 *
 * @param {object} fetch a `fetch:` declaration off the sync wire
 * @returns {object} the same declaration, safe to write into authored config
 */
export function authorableFetch(fetch) {
  const shape = fetchShapeOf(fetch)
  if (!shape) return fetch
  const drop = [...DERIVED_BY_SHAPE[shape], ...RETIRED_KEYS]
  const out = {}
  for (const [k, v] of Object.entries(fetch)) {
    if (drop.includes(k)) continue
    out[k] = v
  }
  return out
}

// ── `query:` or `fetch:` — the key a projection writes back ─────────────────────
//
// An author declares a level's data with `fetch:` or with its shorthand, `query:`
// (`query: team` ≡ `fetch: { query: team }`). The wire carries only the desugared
// form, so it cannot say which key was typed — and a pull must give back the
// authored KEY as well as the value (the round-trip law of the sync format). So a
// projection writes back the key the file already uses, and a file it creates gets
// `query:` whenever the declaration is nothing but query names — the form the
// docs teach. The declaration keys are one group: exactly one is written, and a
// file holding both is refused by the build.

/** The keys that declare a level's data: the long form, its shorthand, and the retired shorthand. */
export const DECLARATION_KEYS = Object.freeze(['query', 'fetch', 'data'])

/**
 * The query names a declaration consists of, when that is ALL it says — what
 * `query:` can express. Keys the build derives or defaults beside a query (`path`,
 * `url`, `as` equal to the name, `prerender: true`) say nothing an author wrote, and
 * a retired `merge` of any value is not written back at all; any other key makes it a
 * `fetch:`.
 *
 * @param {object|object[]} fetch - a declaration (or a list) off the wire
 * @returns {string|string[]|null} the name(s), or null when `query:` cannot say it
 */
export function queryNamesOf(fetch) {
  const nameOf = (one) => {
    if (typeof one === 'string' && one !== '') return one
    if (!one || typeof one !== 'object' || typeof one.query !== 'string' || one.query === '') return null
    for (const [key, value] of Object.entries(one)) {
      if (value === undefined) continue
      if (key === 'query' || key === 'path' || key === 'url') continue
      if (key === 'as' && value === one.query) continue
      if (key === 'prerender' && value === true) continue
      if (RETIRED_KEYS.includes(key)) continue
      return null
    }
    return one.query
  }
  if (!Array.isArray(fetch)) return nameOf(fetch)
  const names = fetch.map(nameOf)
  return names.length > 0 && names.every((n) => n !== null) ? names : null
}

/**
 * The declaration to write back, and under which key.
 *
 * @param {object|object[]} wireFetch - the level's `fetch` off the wire
 * @param {object|null} [existing] - the authored file's current keys; null for a new file
 * @returns {{ key: 'query'|'fetch', value: string|string[]|object|object[] }}
 */
export function authorableDeclaration(wireFetch, existing = null) {
  const fetch = Array.isArray(wireFetch) ? wireFetch.map((one) => authorableFetch(one)) : authorableFetch(wireFetch)
  const names = queryNamesOf(fetch)
  const typedFetch = !!existing && typeof existing === 'object' && existing.fetch !== undefined
  return names !== null && !typedFetch ? { key: 'query', value: names } : { key: 'fetch', value: fetch }
}
