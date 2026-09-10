/**
 * Is search on for this site, as the AUTHOR declared it?
 *
 * ⭐ **The build's own decision about its own output.** Deliberately not
 * `@uniweb/projections`': that package is a helper library — it derives
 * artifacts from content and must not gate on a site setting. Deciding whether
 * to generate is the caller's job *[Diego, 2026-09-10]*.
 *
 * ⛔ **The boolean form is why this is not a one-liner.**
 * `config?.search?.enabled !== false` reads `false.enabled` when an author
 * writes `search: false`, because optional chaining short-circuits on
 * `null`/`undefined` only — so `undefined !== false` is `true` and the natural
 * spelling of "off" still shipped a `search-index.json` carrying every page's
 * text. On a static export that file is world-readable. `Website.isSearchEnabled`
 * fixed the same expression in `@uniweb/core`; the copy in projections never got
 * it and now needs none. Pinned by `tests/search-declared.test.js`.
 *
 * ⚖️ **Author tier only, and that is correct here.** A host's `services` block
 * decides where queries are *answered* at render; it has no bearing on whether
 * this build emits an index. The render-time question is
 * `Website.isServiceEnabled('search')`.
 *
 * ⛔ **A leaf on purpose.** It lived in `site/plugin.js` for one commit, which
 * made `i18n/index.js` import a 26-module Vite plugin to reach four lines — and
 * put one future import in the other direction away from a cycle.
 *
 * @param {object} siteContent - parsed site content, or anything with `.config`
 * @returns {boolean}
 */
export function searchDeclaredOn(siteContent) {
  const search = siteContent?.config?.search
  if (typeof search === 'boolean') return search
  return search?.enabled !== false
}
