/**
 * A route's `mode` on the site-content document: what its pages may hold, which the app honours, and
 * not how the files hold them.
 *
 * - `single-section`: each page under the route holds one section and no page of its own, as a folder
 *   in folder mode keeps them, one `.md` file each. A route under it that holds no section is
 *   `single-section` too, and the route holds no section of its own, except a page above a mounted
 *   folder of `.md` pages.
 * - `page`: any other route.
 *
 * A push writes each route's own value, so nothing says "inherit" (`site.js::walkPagesNested`). A pull
 * reads it only for a route its files do not hold yet; a route they hold takes its form from them
 * (`site-project.js`). `folder` is the old spelling, which a stored document carries until its site's
 * next push: only a unit's identity reads it (`site-diff.js::walkSiteUnits`).
 *
 * A leaf, with no imports.
 */
export const SINGLE_SECTION = 'single-section'
