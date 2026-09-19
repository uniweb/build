// Where a site's pages and layout live — ONE definition for the push, which reads
// the tree from here (`site.js`), and the pull, which writes it back here
// (`site-project.js`). A leaf module so the pull does not import the push.

import { join, resolve } from 'node:path'

/**
 * `site.yml::paths.pages` / `paths.layout`, else `pages/` and `layout/` — resolved
 * as the build resolves them (`site/content-collector.js`).
 *
 * ⛔ The pull read this from the pulled document's `info.paths` until 2026-09-19.
 * `paths` moved to the `settings` Section on 2026-09-09 and that reader did not
 * move with it, so it read as absent: every pull wrote pages to `pages/` and layout
 * to `layout/` whatever the site declared, while the build and the next push kept
 * reading the declared directory — untouched by the pull, and recorded by it as
 * current.
 *
 * ⭐ Reading `site.yml` rather than the document is the fix, not a detour: it is the
 * file both readers use, and the pull writes the document's `settings.paths` into it
 * before it places a single page.
 *
 * @param {string} siteRoot
 * @param {object|null} siteYml - the parsed `site.yml`
 * @returns {{ pagesDir: string, layoutDir: string }}
 */
export function siteContentDirs(siteRoot, siteYml) {
  const paths = siteYml?.paths
  return {
    pagesDir: paths?.pages ? resolve(siteRoot, paths.pages) : join(siteRoot, 'pages'),
    layoutDir: paths?.layout ? resolve(siteRoot, paths.layout) : join(siteRoot, 'layout'),
  }
}
