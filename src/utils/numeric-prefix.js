// The `01-` filename convention — ONE rule, for pages and for records.
//
// ⛔ IT WAS PRIVATE TO THE PAGES LANE, and `records.yml` needs exactly the same
// rule: a leading `01-` orders a file and is stripped from the name it produces.
// Two copies would drift, and the drift would be invisible — a section ordering
// one way and a record another, both plausible, with nothing comparing them.
//
// ⚠️ Lifted here rather than imported from `site/content-collector.js` because
// that module reads a site's whole page tree and imports the query resolver; a
// records reader importing it would close a cycle. A naming convention is a leaf.

/**
 * Split a leading numeric prefix off a filename stem.
 *
 * Dots are sub-levels, so `1`, `1.5`, `2` order as you would read them.
 *
 * ⛔ THE RECORDS LANE USES THIS FOR ORDERING ONLY — it does NOT strip the prefix
 * from a record's slug. A record's slug is its filename stem, whole. An earlier
 * draft of the model stripped it, and implementing that surfaced why it cannot
 * work here: a leading number is a DATE at least as often as it is an order, and
 * the two are indistinguishable by shape. Measured on the model's own example
 * pool, `2026-03-nature-folding.md` became `03-nature-folding`.
 *
 * ⚖️ Sorting is unaffected and stays useful: `2025-11-…` before `2026-03-…` is
 * exactly what a date prefix should do, and `1-`, `2-`, `10-` order as written
 * rather than as strings. Reading a number to ORDER by it is safe; consuming it
 * into a name is not.
 *
 * @param {string} filename - a stem, without its extension
 * @returns {{ prefix: string|null, name: string }}
 */
export function parseNumericPrefix(filename) {
  const match = filename.match(/^(\d+(?:\.\d+)*)-?(.*)$/)
  if (match) {
    return { prefix: match[1], name: match[2] || match[1] }
  }
  return { prefix: null, name: filename }
}

/**
 * Compare two stems by their numeric prefix, falling back to locale order.
 *
 * ⚠️ Prefixed names sort BEFORE unprefixed ones. A file the author numbered is
 * one they placed deliberately; an unnumbered one has no stated position, so it
 * follows rather than interleaving at an arbitrary point.
 */
export function compareByNumericPrefix(a, b) {
  const { prefix: pa } = parseNumericPrefix(a)
  const { prefix: pb } = parseNumericPrefix(b)

  if (!pa && !pb) return a.localeCompare(b)
  if (!pa) return 1
  if (!pb) return -1

  const partsA = pa.split('.').map(Number)
  const partsB = pb.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const na = partsA[i] ?? 0
    const nb = partsB[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}
