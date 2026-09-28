// Page-visibility helpers — the two orthogonal axes a page carries:
//   • Reachability — `hidden: bool`. `true` = excluded from the PUBLISHED output
//     entirely (see `dropUnpublishedPages`, and `dropHiddenSections` for a section).
//     Still previewable in `uniweb dev`.
//   • Nav placement — `hideIn: string[]`. Which nav areas suppress the page while
//     it IS routed (see `normalizeHideIn`). `['*']` = suppressed from every area.

/**
 * Normalize a page/folder config's navigation visibility into a `hideIn` array —
 * the list of named nav areas a page is suppressed from (layout-area names like
 * 'header', 'footer', or any foundation-declared area). The canonical form behind
 * the runtime `hideIn`, the sync `hide_in` field, and `getPageHierarchy({ for })`.
 * The sentinel `'*'` means "suppressed from every nav area" (still routed) — it is
 * a normal array element, interpreted by the runtime, not special-cased here.
 *
 * Reads the canonical `hideIn` (an array, or a single string for convenience) and
 * folds in the legacy `hideInHeader` / `hideInFooter` booleans for back-compat.
 * Deduped; declaration order preserved. `hidden` (reachability) is a separate axis.
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

/**
 * Drop unpublished pages — the reachability axis. A page with `hidden: true` is
 * excluded from the PUBLISHED output entirely, and the exclusion CASCADES to its
 * whole subtree: drafting a container drafts the branch. Applied only on the
 * published build paths (`uniweb build` / link-mode deploy); `uniweb dev` keeps
 * hidden pages so in-progress work stays previewable by direct URL.
 *
 * Cascade is resolved via the parent-route chain (the same `parent` route strings
 * the hierarchy is built from), so no surviving page is ever left pointing at a
 * pruned parent — this is what avoids orphaned routes / dangling parent references
 * that a per-node drop would create.
 *
 * @param {Array<object>} pages - collected page data (each with `route`, `parent`)
 * @returns {Array<object>} pages with hidden pages and their descendants removed
 */
export function dropUnpublishedPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return pages
  const byRoute = new Map(pages.map((p) => [p.route, p]))
  const cache = new Map()
  const isUnpublished = (page, seen = new Set()) => {
    if (!page) return false
    if (cache.has(page.route)) return cache.get(page.route)
    if (seen.has(page.route)) return false // defensive cycle guard (trees don't cycle)
    seen.add(page.route)
    const parent = page.parent ? byRoute.get(page.parent) : null
    const result = page.hidden ? true : (parent ? isUnpublished(parent, seen) : false)
    cache.set(page.route, result)
    return result
  }
  return pages.filter((p) => !isUnpublished(p))
}

/**
 * Drop hidden sections — the same reachability axis, one level down. A section with
 * `hidden: true` in its frontmatter is a draft: left out of the PUBLISHED output together
 * with its child sections, and kept by `uniweb dev` so it stays previewable. Applied where
 * `dropUnpublishedPages` is, to a page's sections and a layout area's alike.
 *
 * @param {Array<object>} sections - collected sections (each may hold `subsections`)
 * @returns {Array<object>} the sections without the hidden ones, at every depth
 */
export function dropHiddenSections(sections) {
  if (!Array.isArray(sections)) return sections
  return sections
    .filter((section) => section?.hidden !== true)
    .map((section) =>
      Array.isArray(section.subsections) && section.subsections.length > 0
        ? { ...section, subsections: dropHiddenSections(section.subsections) }
        : section
    )
}
