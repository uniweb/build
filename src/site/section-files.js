/**
 * ONE SECTION, ONE FILE.
 *
 * A section's name is its file's stem without the number that orders it (`parseNumericPrefix`):
 * `1-lost.md` holds the section `lost`, and so does `lost.md`. Two such files in one page are one
 * section twice. A merge leaves them side by side without a word when each side added the section
 * under its own name, and the page then shows it twice. A build draws both and says so: a static site
 * has nothing to lose by it, and a site build gives a note, never a gate. A push refuses the page
 * (`uwx/sync-package.js`), since a synced site's sections are known by their names, and a pull names
 * both files the moment its merge leaves them (`uniweb pull`).
 *
 * ⛔ That happened on 2026-11-12. A pull merged a teammate's `pages/404/1-lost.md` with the backend's
 * `pages/404/lost.md`, the same hero, and nothing said so: it was found by looking at the files.
 *
 * A child section keeps its `@` apart: `@card.md` is a child, `card.md` a section of the page's own.
 */
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { parseNumericPrefix } from '../utils/numeric-prefix.js'
import { isMarkdownFile, isIgnoredFolder } from '../utils/content-files.js'

/**
 * The sections a page directory holds in more than one file.
 *
 * @param {string[]} files - the directory's entries
 * @returns {Array<{ name: string, files: string[] }>} each such section, `@` kept for a child, its files sorted
 */
export function sectionFilesNamedTwice(files) {
  const byName = new Map()
  for (const file of files) {
    if (!isMarkdownFile(file)) continue
    const stem = file.slice(0, -'.md'.length)
    const at = stem.match(/^@+/)?.[0] || ''
    const bare = stem.slice(at.length)
    const key = `${at}${parseNumericPrefix(bare).name || bare}`
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(file)
  }
  return [...byName].filter(([, list]) => list.length > 1).map(([name, list]) => ({ name, files: list.sort() }))
}

/**
 * Say which sections a page holds twice, in the words the build and a pull both use.
 *
 * @param {string} dir - the page's directory, as the person knows it (`pages/404`)
 * @param {Array<{ name: string, files: string[] }>} twice - `sectionFilesNamedTwice`'s answer
 * @returns {string}
 */
export function describeSectionsNamedTwice(dir, twice) {
  return twice
    .map(({ name, files }) => `${dir} holds the section "${name.replace(/^@+/, '')}" in ${files.length} files: ${files.join(', ')}`)
    .join('\n')
}

async function markdownFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isIgnoredFolder(entry.name)) out.push(...(await markdownFiles(join(dir, entry.name))))
    } else if (isMarkdownFile(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out.sort()
}

/**
 * Every section file of a site, each one section: a page's under `pages/` and a layout's under
 * `layout/`, with the directories and files the collector leaves out left out here too
 * (`isIgnoredFolder`, `isMarkdownFile`). For a tool that works on a section's file, which a
 * collected section doesn't name.
 *
 * @param {string} siteRoot
 * @returns {Promise<Array<{ file: string, area: 'pages'|'layout' }>>} absolute paths, sorted
 */
export async function sectionFilesOf(siteRoot) {
  const out = []
  for (const area of ['pages', 'layout']) {
    for (const file of await markdownFiles(join(siteRoot, area))) out.push({ file, area })
  }
  return out
}

/**
 * The route of the page a section file belongs to, read from its directories as the collector reads
 * them: each through `parseNumericPrefix`, a file in a folder-mode directory (`folder.yml`) a page of
 * its own, and the site's `index:` page at `/`.
 *
 * @param {string} file - the section's file
 * @param {string} pagesDir - the site's `pages/`
 * @param {string} [siteIndex] - `site.yml`'s `index:`
 * @returns {string}
 */
export function routeOfSection(file, pagesDir, siteIndex) {
  const dir = dirname(file)
  const segments = relative(pagesDir, dir).split(/[\\/]/).filter(Boolean).map((s) => parseNumericPrefix(s).name)
  if (existsSync(join(dir, 'folder.yml'))) segments.push(parseNumericPrefix(basename(file, '.md').replace(/^@/, '')).name)
  if (segments.length === 1 && segments[0] === siteIndex) return '/'
  return `/${segments.join('/')}`
}
