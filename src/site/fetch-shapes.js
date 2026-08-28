// What shape a `fetch:` declaration is, and what a PROJECTION may write back.
//
// ⛔ WHY THIS EXISTS. A `fetch:` declaration has three shapes, and the keys each one
// accepts differ (`data-fetcher.js` RECOGNIZED_FETCH_KEYS):
//
//   refine      refine · inherit · detail · limit · sort · where · filter
//   collection  collection · schema · … — and NOT `path`/`url`
//   source      path · url · schema · …
//
// The build RESOLVES a `collection:` shorthand into a concrete location, so the
// declaration that rides the sync wire carries BOTH the authored `collection` and
// the derived `path`. Projecting that back verbatim writes a file that is neither
// shape cleanly: `collection` wins the classification, and the `path` beside it is
// then an unrecognized key on its own declaration.
//
// ⚠️ Measured on matinee 2026-08-29 — `push → pull → push`, where the third step is
// rejected by our OWN validator against a file our OWN projector had just written:
//
//   fetch:
//     path: /data/members.json     ← derived; also a build artifact path
//     schema: members
//     collection: members          ← what the author actually wrote
//
//   [uniweb] fetch: unrecognized key "path" was ignored. Keys recognized on this
//   declaration: collection, detailPage, filter, limit, merge, prerender, schema,
//   sort, transform, where.
//
// ⭐ The round trip has to invert the resolution, not copy it. `/data/<name>.json`
// is a materialization of a collection, never its definition — so it is precisely
// the thing an authored file should not contain.
//
// ⚖️ DROPS ONLY WHAT IS DERIVABLE, not everything unrecognized. A key we do not know
// might be one a newer producer authored, and silently discarding it on every pull
// would make the round trip lossy in a way nothing reports. `path` and `url` beside
// a `collection` are recoverable from the collection itself; anything else survives
// and the validator's warning stays the honest signal.

/** Which of the three shapes a declaration is — the same order `data-fetcher` uses. */
export function fetchShapeOf(fetch) {
  if (!fetch || typeof fetch !== 'object') return null
  if (fetch.refine === true || fetch.inherit === true) return 'refine'
  if (fetch.collection) return 'collection'
  return 'source'
}

/** Keys a shape derives rather than the author writing them. */
const DERIVED_BY_SHAPE = {
  collection: ['path', 'url'],
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
