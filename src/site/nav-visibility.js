/**
 * Normalize a page/folder config's navigation visibility into a `hideIn` array —
 * the list of named nav areas a page is suppressed from (layout-area names like
 * 'header', 'footer', or any foundation-declared area). The canonical form behind
 * the runtime `hideIn`, the sync `hide_in` field, and `getPageHierarchy({ for })`.
 *
 * Reads the canonical `hideIn` (an array, or a single string for convenience) and
 * folds in the legacy `hideInHeader` / `hideInFooter` booleans for back-compat.
 * Deduped; declaration order preserved. `hidden` (all-nav exclusion) is separate.
 *
 * @param {object} config - a parsed page.yml / folder.yml config (or page data)
 * @returns {string[]}
 */
export function normalizeHideIn(config = {}) {
  const out = []
  const seen = new Set()
  const add = (a) => {
    if (typeof a === 'string' && a && !seen.has(a)) {
      seen.add(a)
      out.push(a)
    }
  }
  const raw = config.hideIn
  if (Array.isArray(raw)) raw.forEach(add)
  else add(raw)
  if (config.hideInHeader) add('header')
  if (config.hideInFooter) add('footer')
  return out
}
