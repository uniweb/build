// WHERE EACH PAGE OF A SITE IS KEPT — found in its files by the build's own rules, never computed from
// a document (`kb` pulling-into-mounted-folders, P1 and P2). A pull writes a page where this says it
// lives: `2-about/` holds /about, and `guide/1-install.md` holds /guide/install.
//
// ⛔ Until 2026-11-04 a pull named a page's folder by its slug (`pageDirName`): `pages/2-about/` came
// back as `pages/about/`, the numbered folder pruned. And it could not write a folder-mode `.md` page
// at all, so it left every one alone (`git-authored.js`, which this replaces), and an edit made to one
// in the app was undone by the next push.
//
// The pages a pull leaves alone are now those it may not or cannot write:
//   · every page under a `paths: { pages/<segment>: <dir> }` mount. Its files are another
//     repository's, or a folder outside the site; the local folder of that name holds only how this
//     site presents them, and a pull writing the mounted pages into it would grow a second copy there;
//   · a route the files give two pages for — a file and a folder of one name, `topics.md` beside
//     `topics/` — since a page in the document cannot say which of the two it is.
// A pull deletes neither, nor a folder that holds one (`holds`): a pull never deletes what it does not
// write.
//
// A leaf, read synchronously as the pull projects (`site-project.js`), through the rules the push's
// walk reads with — `folderContentMode`, `folderModePageFiles`, `parseNumericPrefix`, `mountEntriesOf`
// — so the pages it finds are the ones the push sends (`tests/uwx-page-files.test.js`).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { isIgnoredFolder } from '../utils/content-files.js'
import { extractH1, folderContentMode, folderModePageFiles, parseNumericPrefix, prettifySlug } from '../site/content-collector.js'
import { mountEntriesOf } from '../site/mount-entries.js'
import { unwrapLocalized } from './backfill.js'
import { isProseMirrorDoc } from './locale-sync.js'

const DYNAMIC_RE = /^\[(.+)\]$/

// The collector's own reading of a config file (`parseYaml`): absent or unreadable is empty.
function readYaml(filePath) {
  try {
    return yaml.load(readFileSync(filePath, 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return {}
  }
}

/**
 * A folder's mode as the build reads it now (`readFolderConfig`): `pages` — its `.md` files are pages —
 * or `sections` — they are its page's sections. A folder with no config of its own inherits.
 *
 * @param {string} dir
 * @param {'pages'|'sections'} inheritedMode
 * @returns {'pages'|'sections'}
 */
export function folderModeOf(dir, inheritedMode) {
  const folderYml = readYaml(join(dir, 'folder.yml'))
  const pageYml = Object.keys(folderYml).length > 0 ? {} : readYaml(join(dir, 'page.yml'))
  return folderContentMode(folderYml, pageYml, existsSync(join(dir, 'folder.yml')), inheritedMode).mode
}

/**
 * The pages of a site, each by its route — a slug path with no leading slash (`docs/start/install`),
 * as the pull composes a page's route from the document — and where it is kept:
 *
 * - `{ kind: 'folder', dir }`: a page folder, with its `page.yml` or `folder.yml` and its sections;
 * - `{ kind: 'md', file, dir }`: a folder-mode `.md` file in the level `dir` — the page and its one section;
 * - `{ kind: 'mounted', segment }`: a route under a mount, left alone;
 * - `{ kind: 'twice', dir, file }`: a route the files give two pages for, left alone.
 *
 * @param {object|null} siteYml - the parsed `site.yml`
 * @param {string} pagesDir - the site's pages directory (`siteContentDirs`)
 * @param {{ seen?: Set<string>|null }} [opts] - `seen`, the routes of the pages this copy has seen the
 *   backend hold: a folder holding an `.md` page it never saw is one a prune keeps (`holds`)
 * @returns {{
 *   page: (route: string) => object|null,
 *   levelMode: (dir: string) => 'pages'|'sections'|undefined,
 *   mounted: Set<string>,
 *   holds: (dir: string) => boolean,
 * }}
 */
export function sitePageFiles(siteYml, pagesDir, { seen = null } = {}) {
  const mounted = new Set(mountEntriesOf(siteYml?.paths).map(([segment]) => segment))
  const places = new Map()
  const modes = new Map()
  const put = (route, place) => {
    const had = places.get(route)
    if (!had) return places.set(route, place)
    // A file and a folder of one name: both stay, as the push sends both.
    places.set(route, { kind: 'twice', dir: had.kind === 'folder' ? had.dir : place.dir, file: had.kind === 'md' ? had.file : place.file })
  }
  const walk = (dir, prefix, inheritedMode) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const mode = folderModeOf(dir, inheritedMode)
    modes.set(dir, mode)
    if (mode === 'pages') {
      for (const { file, name } of folderModePageFiles(entries.map((e) => e.name)).files) {
        put(prefix + name, { kind: 'md', file: join(dir, file), dir })
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || isIgnoredFolder(e.name)) continue
      if (!prefix && mounted.has(e.name)) continue // the whole route is the mount's
      const dyn = e.name.match(DYNAMIC_RE)
      const route = prefix + (dyn ? dyn[1] : parseNumericPrefix(e.name).name)
      put(route, { kind: 'folder', dir: join(dir, e.name) })
      walk(join(dir, e.name), `${route}/`, mode)
    }
  }
  if (existsSync(pagesDir)) walk(pagesDir, '', 'sections')

  // Each folder holding a page a prune must not take, and each one above it, up to the pages directory:
  // removing any of them would remove that page with it. Those are the pages a pull leaves alone, and an
  // `.md` page this copy never saw the backend hold — ⛔ a push before 2026-10-23 sent no folder-mode
  // page, so a backend can lack one the files have always held, and read as deleted it would go.
  const holding = new Set()
  const hold = (dir) => {
    for (let d = dir; d && d !== pagesDir && d.startsWith(pagesDir); d = dirname(d)) holding.add(d)
  }
  for (const [route, place] of places) {
    if (place.kind === 'twice') {
      hold(place.dir)
      hold(dirname(place.file))
    } else if (place.kind === 'md' && !seen?.has(route)) hold(place.dir)
  }
  return {
    page: (route) => {
      const segment = String(route).split('/')[0]
      if (mounted.has(segment)) return { kind: 'mounted', segment }
      return places.get(route) ?? null
    },
    levelMode: (dir) => modes.get(dir),
    mounted,
    holds: (dir) => holding.has(dir),
  }
}

// The page fields a push sends for a folder-mode `.md` page are its title and `hidden`
// (`folderModePageRecords`, `site.js`), and `is_index` where it is the homepage. A page carrying any of
// these needs a page folder to hold it.
const NOT_IN_AN_MD_PAGE = ['description', 'label', 'keywords', 'hide_in', 'knowledge', 'track_sections', 'redirect', 'rewrite', 'layout', 'og_title', 'og_description', 'seo', 'fetch']

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

// Does a field carry a value, its source locale's for a localized one?
function holdsValue(value, sourceLocale) {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) {
    if (Object.prototype.hasOwnProperty.call(value, sourceLocale)) return holdsValue(value[sourceLocale], sourceLocale)
    return Object.keys(value).length > 0
  }
  return true
}

/**
 * What of a page a folder-mode `.md` file cannot hold — none, when it can be written as one. The file is
 * the page and its one section: its title is its first heading, else its name prettified, and its
 * frontmatter's `hidden:` drafts it. A second section, pages below it, a route parameter, a title its
 * heading does not give, or any other page setting, it cannot say.
 *
 * ⚖️ A setting such a page might hold in its frontmatter is project-file-organization's §10 decision 1,
 * not settled; until it is, a pull writes none.
 *
 * @param {object} record - the page's record
 * @param {{ name: string, sourceLocale: string }} opts - `name`, the file's page name (`1-install.md` → `install`)
 * @returns {string[]} what it cannot hold, in words
 */
export function mdPageCannotHold(record, { name, sourceLocale }) {
  const out = []
  const sections = Array.isArray(record?.page_sections) ? record.page_sections : []
  if (sections.length !== 1) out.push(sections.length ? 'more than one section' : 'no section')
  if (Array.isArray(record?.$children) && record.$children.length) out.push('pages below it')
  if (record?.is_dynamic) out.push('a route parameter')
  // Its id is its file's name; one the name does not give needs a page folder's `id:`.
  if (typeof record?.stable_id === 'string' && record.stable_id && record.stable_id !== name) out.push('an id its file name does not give')
  for (const key of NOT_IN_AN_MD_PAGE) if (holdsValue(record?.[key], sourceLocale)) out.push(key)
  if (sections.length === 1) {
    const content = sections[0]?.content
    const doc = isProseMirrorDoc(content) ? content : unwrapLocalized(content, sourceLocale)
    const given = extractH1(doc) || prettifySlug(name)
    const title = unwrapLocalized(record?.title, sourceLocale)
    if (typeof title === 'string' && title && title !== given) out.push('a title its first heading does not give')
  }
  return out
}
