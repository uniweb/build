/**
 * A page's `mode` on the site-content document: what the page itself is, which the app honours, read from
 * the page and never from its parent [Diego, 2026-11-05]:
 *
 * - `atomic`: a page that holds exactly one section and no child page, as the files hold it, one `.md`
 *   file in folder mode;
 * - `atomic-parent`: a page with no section whose child pages are atomic pages or atomic-parents, as the
 *   files hold it, a directory in folder mode — its own `folder.yml`, or below one;
 * - `regular`: every other page, a page with no section yet included.
 *
 * A push writes each page's own value from where its files keep it (`site.js::walkPagesNested`). A pull
 * places a page the files don't hold yet by it, and follows the app's switch of an empty page between
 * `atomic-parent` and `regular` (`site-project.js`). A value it doesn't know reads as `regular`.
 * ⛔ Until 2026-11-05 the value was the parent's: `single-section` on a page whose child pages were in
 * folder mode, and `page` on every other, the pages under it included.
 *
 * A leaf, with no imports.
 */
export const REGULAR = 'regular'
export const ATOMIC = 'atomic'
export const ATOMIC_PARENT = 'atomic-parent'

/** The page's own mode, or null for a value this framework doesn't know, which reads as `regular`. */
export function knownMode(record) {
  const mode = record?.mode
  return mode === REGULAR || mode === ATOMIC || mode === ATOMIC_PARENT ? mode : null
}
