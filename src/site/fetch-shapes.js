// What shape a `fetch:` declaration is, and what a PROJECTION may write back.
//
// ⛔ WHY THIS EXISTS. A `fetch:` declaration has three shapes, and the keys each one
// accepts differ (`data-fetcher.js` RECOGNIZED_FETCH_KEYS):
//
//   refine      refine · detail · limit · sort · where · filter
//   query       query · schema · … — and NOT `path`/`url`
//   source      path · url · schema · …

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
// ⭐ The round trip has to invert the resolution, not copy it. `/data/<name>.json`
// is a materialization of a query, never its definition — so it is precisely the
// thing an authored file should not contain.
//
// ⚖️ DROPS ONLY WHAT IS DERIVABLE, not everything unrecognized. A key we do not know
// might be one a newer producer authored, and silently discarding it on every pull
// would make the round trip lossy in a way nothing reports. `path` and `url` beside
// a `query` are recoverable from the query itself; anything else survives and the
// validator's warning stays the honest signal.

/** Which of the three shapes a declaration is — the same order `data-fetcher` uses. */
export function fetchShapeOf(fetch) {
  if (!fetch || typeof fetch !== 'object') return null
  if (fetch.refine === true) return 'refine'
  if (fetch.query) return 'query'
  return 'source'
}

/** Keys a shape derives rather than the author writing them. */
const DERIVED_BY_SHAPE = {
  query: ['path', 'url'],
  refine: [],
  source: []
}

/**
 * The declaration as an author would have written it — the wire's resolved form
 * minus what the build derived.
 *
 * @param {object} fetch a `fetch:` declaration off the sync wire
 * @returns {object} the same declaration, safe to write into authored config
 */
export function authorableFetch(fetch) {
  const shape = fetchShapeOf(fetch)
  const derived = DERIVED_BY_SHAPE[shape]
  if (!derived || derived.length === 0) return fetch
  const out = {}
  for (const [k, v] of Object.entries(fetch)) {
    if (derived.includes(k)) continue
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
 * `url`, `as` equal to the name, `prerender: true`, `merge: false`) say nothing an
 * author wrote; any other key makes it a `fetch:`.
 *
 * @param {object|object[]} fetch - a declaration (or a list) off the wire
 * @returns {string|string[]|null} the name(s), or null when `query:` cannot say it
 */
export function queryNamesOf(fetch) {
  const nameOf = (one) => {
    if (!one || typeof one !== 'object' || typeof one.query !== 'string' || one.query === '') return null
    for (const [key, value] of Object.entries(one)) {
      if (key === 'query' || key === 'path' || key === 'url') continue
      if (key === 'as' && value === one.query) continue
      if (key === 'prerender' && value === true) continue
      if (key === 'merge' && value === false) continue
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
