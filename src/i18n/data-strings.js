/**
 * Which strings inside STRUCTURED DATA are human-readable prose.
 *
 * A tagged data block (```yaml:nav, ```json:pricing) carries an arbitrary shape,
 * so there is no element to key a translation unit to — only a tree of values,
 * most of which are machinery. A nav's `label` is prose; its `href` and `icon`
 * are not. Guessing wrong in one direction leaves a site half-translated; in the
 * other it rewrites a URL into another language and breaks the link.
 *
 * The judgement was already made and tuned for collections, which have exactly
 * this problem. This module is that judgement, moved somewhere both lanes can
 * reach rather than copied — the copy is how the two would drift, and the whole
 * point is that a `label` means the same thing in a collection record and in a
 * data block.
 *
 * An ALLOWLIST of shapes is impossible here (the data is author-defined), so
 * this is necessarily a denylist, and it is deliberately conservative: a missed
 * skip shows up as a translatable string an author can leave alone, while a
 * missed field shows up as untranslated content nobody notices.
 */

/** Types that are never translatable regardless of schema. */
export const NON_TRANSLATABLE_TYPES = new Set([
  'number', 'boolean', 'date', 'datetime', 'url', 'email', 'image'
])

/** Field names skipped by the heuristic extractor (structural, not human-readable). */
export const HEURISTIC_SKIP_FIELDS = new Set([
  'slug', 'id', 'type', 'status', 'href', 'url', 'src', 'icon',
  'target', 'email', 'phone', 'orcid', 'doi', 'arxiv', 'isbn',
  'pmid', 'bibtex', 'pdf', 'code', 'data', 'slides', 'video',
  'repository', 'caseStudy', 'website', 'avatar', 'image',
  'thumbnail', 'currency', 'order', 'hidden', 'current',
  'featured', 'published', 'allDay', 'remote', 'hybrid',
  'noindex', 'corresponding', 'required', 'virtual',
  'lastModified', 'date', 'updated', 'posted', 'submitted',
  'accepted', 'startDate', 'endDate', 'deadline',
  'readTime', 'citations', 'capacity', 'volume', 'issue', 'pages',
  'time', 'timezone',
])

/** String patterns that indicate non-translatable values. */
export const HEURISTIC_SKIP_PATTERNS = [
  /^https?:\/\//,                  // URLs
  /^mailto:/,                      // mailto links
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,   // email addresses
  /^\d{4}-\d{2}-\d{2}/,           // ISO dates
  /^#[0-9a-fA-F]{3,8}$/,          // hex colors
  /^[\w./\\-]+\.\w{2,4}$/,        // file paths (e.g., ./logo.svg, /img/hero.jpg)
  /^[A-Z]{3}$/,                   // currency codes (USD, EUR)
  /^\d+(\.\d+)?$/,                // plain numbers as strings
  /^\d{1,2}:\d{2}(:\d{2})?$/,    // times (09:00, 14:30:00)
]

/** Max recursion depth for heuristic extraction. */
export const MAX_HEURISTIC_DEPTH = 5

/** Whether a string value looks structural rather than human-readable. */
export function isStructuralString(value) {
  return HEURISTIC_SKIP_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Walk structured data and hand every translatable-looking STRING to `visit`.
 *
 * One walker for both directions, the same discipline the document walk uses:
 * extraction returns nothing and collects, application returns a replacement and
 * the walker writes it back. Two copies of a rule this fiddly is how the
 * extracted set and the applied set end up different, which fails as content
 * that appears in the manifest, gets translated by a human, and still renders in
 * the source language.
 *
 * Mutates `data` in place when `visit` returns a different string, so callers
 * that must not mutate should pass a clone.
 *
 * @param {*} data - any parsed YAML/JSON value
 * @param {(value: string, path: string) => string|void} visit
 * @param {string} [path] - dotted path, for the unit's `field` metadata
 * @param {number} [depth]
 */
export function visitDataStrings(data, visit, path = '', depth = 0) {
  if (!data || typeof data !== 'object' || depth > MAX_HEURISTIC_DEPTH) return

  const isArray = Array.isArray(data)
  const keys = isArray ? data.map((_, i) => i) : Object.keys(data)

  for (const key of keys) {
    const value = data[key]
    if (value === undefined || value === null) continue

    const fieldPath = isArray
      ? `${path}[${key}]`
      : path
        ? `${path}.${key}`
        : String(key)

    if (typeof value === 'string') {
      // A skip-list entry applies to a NAMED field. Inside an array the key is
      // an index and carries no meaning, so only the value patterns apply —
      // otherwise a list of prose strings would be skipped by position.
      if (!isArray && HEURISTIC_SKIP_FIELDS.has(key)) continue
      if (isStructuralString(value)) continue
      if (!value.trim()) continue

      const replacement = visit(value, fieldPath)
      if (typeof replacement === 'string' && replacement !== value) {
        data[key] = replacement
      }
    } else if (typeof value === 'object') {
      visitDataStrings(value, visit, fieldPath, depth + 1)
    }
    // numbers and booleans are never prose
  }
}
