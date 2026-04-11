/**
 * Split Content Helper
 *
 * Shared utility to determine whether a site should use split page content.
 * Used by the site plugin, prerender, and unicloud.
 *
 * @module @uniweb/build/site
 */

const THRESHOLD = 100 * 1024 // 100KB uncompressed JSON

/**
 * Determine whether site content should be split into per-page files.
 *
 * @param {boolean|string|undefined} splitConfig - Value from site.yml build.splitContent
 *   - true: always split
 *   - false: never split
 *   - 'auto' or undefined: split when total sections payload > 100KB
 * @param {Array} pages - Array of page objects with sections arrays
 * @returns {boolean} Whether to split content
 */
export function shouldSplitContent(splitConfig, pages) {
  if (splitConfig === true) return true
  if (splitConfig === false) return false

  // auto (default): measure total sections payload
  if (!pages?.length) return false

  let totalSize = 0
  for (const page of pages) {
    if (!page.sections?.length) continue
    totalSize += JSON.stringify(page.sections).length
    if (totalSize > THRESHOLD) return true // Early exit
  }
  return false
}
