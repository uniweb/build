/**
 * Which files and folders in a site's content tree are content.
 *
 * One home for the two rules, so the page collector and the layout folder reader
 * (`site/layout-folder.js`) cannot disagree about them.
 *
 * @module @uniweb/build/utils/content-files
 */

/**
 * Check if a file is a markdown file that should be processed.
 * Excludes:
 * - Files not ending in .md
 * - Files starting with _ (drafts/private)
 * - README.md (repo documentation, not site content)
 */
export function isMarkdownFile(filename) {
  if (!filename.endsWith('.md')) return false
  if (filename.startsWith('_')) return false
  if (filename.toLowerCase() === 'readme.md') return false
  return true
}

/**
 * Check if a folder should be ignored.
 *
 * Excludes folders starting with `_` (drafts/private) and with `.` (hidden).
 *
 * Hidden folders matter more than they look. A site's own `pages/` never holds
 * one, but a mount target routinely does: point `paths:` at a directory that is
 * also a git working tree — a sibling clone, which the docs suggest — and `.git`
 * is a directory sitting right next to the content. Walked as content it
 * contributed hundreds of routes. (A submodule hides this: there, `.git` is a
 * file, so only the plain-clone case ever showed it.)
 */
export function isIgnoredFolder(name) {
  return name.startsWith('_') || name.startsWith('.')
}
