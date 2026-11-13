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
import { parseNumericPrefix } from '../utils/numeric-prefix.js'
import { isMarkdownFile } from '../utils/content-files.js'

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
