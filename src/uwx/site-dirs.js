// Where a site's content lives — ONE definition for the push, which reads the tree from here
// (`site.js`), the pull, which writes it back here (`site-project.js`), and every check that asks
// what a push would send or a pull would merge (the CLI's `utils/site-roots.js`). A leaf module so the
// pull does not import the push.

import { join, relative, resolve, sep } from 'node:path'
import { mountEntriesOf } from '../site/mount-entries.js'

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
 * file both readers use. And it is the project's own: no document carries `paths` since
 * 2026-11-04, so a pull never moves where a project keeps its files.
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

/**
 * Every place a push reads the site's content from, each relative to the site in POSIX form — a
 * mount's may lead out of it (`../docs`):
 *
 * - `config`: `site.yml`, `theme.yml`, `head.html`, `queries.yml`;
 * - `translations`: `locales`;
 * - `pages`, `layout`, `records`: where `paths:` puts them, else their own names;
 * - `media`: `public`, where the files a page names are kept;
 * - `mount`: each `paths: { pages/<segment>: <dir> }` folder, with its `segment` and `abs`.
 *
 * ⭐ ONE ANSWER, and the readers that kept their own drifted (2026-11-04): the push's
 * committed-content check named no mount, so it let a mounted folder's uncommitted edits go out,
 * while `uniweb status` counted that folder among what waits to be pushed. Which repository holds a
 * mount — the site's own, one of its own, or none — is git's question, and the CLI's to ask.
 *
 * ⛔ What the walk reads and this lists must not part: `tests/site-content-roots.test.js` changes
 * every file outside these roots and asks whether the push's document moved.
 *
 * @param {string} siteRoot
 * @param {object|null} siteYml - the parsed `site.yml`
 * @returns {Array<{ path: string, kind: 'config'|'translations'|'pages'|'layout'|'records'|'media'|'mount', segment?: string, abs: string }>}
 */
export function siteContentRoots(siteRoot, siteYml) {
  const paths = siteYml?.paths
  const at = (dir) => {
    const abs = resolve(siteRoot, String(dir))
    return { abs, path: relative(siteRoot, abs).split(sep).join('/') || '.' }
  }
  const roots = []
  for (const file of ['site.yml', 'theme.yml', 'head.html', 'queries.yml']) roots.push({ ...at(file), kind: 'config' })
  roots.push({ ...at('locales'), kind: 'translations' })
  roots.push({ ...at(paths?.pages || 'pages'), kind: 'pages' })
  roots.push({ ...at(paths?.layout || 'layout'), kind: 'layout' })
  roots.push({ ...at(paths?.records || 'records'), kind: 'records' })
  roots.push({ ...at('public'), kind: 'media' })
  for (const [segment, dir] of mountEntriesOf(paths)) {
    if (typeof dir !== 'string' || !dir) continue
    roots.push({ ...at(dir), kind: 'mount', segment })
  }
  return roots
}
