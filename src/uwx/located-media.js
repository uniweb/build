/**
 * MEDIA BESIDE A PAGE, ON THE SYNC LANE — how a push uploads a co-located file (`./team.jpg`) and
 * a pull writes its reference back.
 *
 * A `/x` reference names one file wherever it is written, so a push uploads it under that name and
 * `sync.json`'s asset map remembers its identity by it. `./team.jpg` names a different file beside
 * every page, so the push keys it by the file's path in the site's tree — `pages/home/team.jpg` —
 * as a file record is keyed (`file-records.js`). The tree is the site's folder with its `paths:` laid
 * over it (`siteTree`): a folder mounted at `pages/docs` holds `pages/docs/…`, wherever it is on disk,
 * and a pages folder `paths:` moves elsewhere still holds `pages/…`. The key goes into the upload and into `sync.json`,
 * and into a document only where the emit was handed the upload that names it, which swaps it for
 * the served URL in the same pass (`rewriteEntityAssets`): a document no upload went with keeps the
 * reference as written. A pull writes the author's reference back, relative to the file the
 * section is written to (`writtenRefs`).
 *
 * ⛔ Until 2026-10-28 a push uploaded only `/x` media and skipped a co-located file with a warning,
 * so a site that showed its media under `uniweb dev` and in a static build lost it when published.
 *
 * ⚠️ A file outside both the site's folder and every folder its `paths:` names has no such key, and
 * stays warned and skipped. Two files with the same bytes are one asset, so a pull may write either
 * one's path.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * The site's tree, as its `paths:` lay it out: each folder mounted at `pages/<segment>`, the pages
 * folder and the layout folder, by the path they hold in the site — `[path in the tree, folder]`.
 * The site's own folder holds everything else.
 *
 * @param {string} siteRoot
 * @param {{ pagesDir?: string, layoutDir?: string, mounts?: Map<string,string>|null }} dirs -
 *   `site-dirs.js::siteContentDirs`'s folders, and the build's mounts (route segment → folder)
 * @returns {Array<[string, string]>}
 */
export function siteTree(siteRoot, { pagesDir, layoutDir, mounts = null } = {}) {
  const tree = []
  for (const [segment, dir] of mounts || []) tree.push([`pages/${segment}`, dir])
  if (pagesDir) tree.push(['pages', pagesDir])
  if (layoutDir) tree.push(['layout', layoutDir])
  return tree
}

/**
 * The key a push uploads a site's file under: its path in the site's tree — in the most specific
 * folder of `tree` that holds it, else in the site's own folder — or null for a file in neither.
 *
 * @param {string} siteRoot
 * @param {string} file - absolute
 * @param {Array<[string, string]>} [tree] - `siteTree`
 * @returns {string|null} `pages/home/team.jpg`
 */
export function siteFileKey(siteRoot, file, tree = []) {
  const holders = [...tree].sort((a, b) => b[1].length - a[1].length)
  for (const [prefix, dir] of holders) {
    const rel = pathBelow(dir, file)
    if (rel) return `${prefix}/${rel}`
  }
  return pathBelow(siteRoot, file)
}

/** The file a key names — the inverse of `siteFileKey`. */
export function siteFileOf(siteRoot, key, tree = []) {
  const prefixes = [...tree].sort((a, b) => b[0].length - a[0].length)
  for (const [prefix, dir] of prefixes) {
    if (key.startsWith(`${prefix}/`)) return join(dir, key.slice(prefix.length + 1))
  }
  return join(siteRoot, key)
}

/** `file`'s path below `dir`, `/`-separated, or null when it is not inside it. */
function pathBelow(dir, file) {
  const rel = relative(dir, file)
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === '..') return null
  return rel.split(sep).join('/')
}

/**
 * Collects what a push makes of a site's co-located media: each file to upload, by its key, and
 * one warning for each reference it cannot upload.
 *
 * @param {Object<string,string>|null} [uploaded] - the emit's upload map (`assetRewrite`): a
 *   reference whose key it names is replaced by the key, for the rewrite to swap
 */
export function locatedMediaSink(uploaded = null) {
  // `tree` is the site's, set where its folders are known (`site.js::siteProjectToDocument`).
  return { uploaded, tree: [], files: new Map(), refs: new Set(), warned: new Set(), warnings: [] }
}

/**
 * A section's co-located media, as a push takes it.
 *
 * @param {{ uses?: Array<{ ref: string, resolved: string, set: Function }> }} assetCollection -
 *   what the build's collection resolved, with a setter for where each reference is written
 *   (`site/assets.js::collectSectionAssets`)
 * @param {{ siteRoot: string, filePath: string, sink: ReturnType<typeof locatedMediaSink> }} where
 */
export function locateSectionMedia(assetCollection, { siteRoot, filePath, sink }) {
  if (!sink) return
  const named = siteFileKey(siteRoot, filePath, sink.tree) || relative(siteRoot, filePath).split(sep).join('/')
  for (const use of assetCollection?.uses || []) {
    const key = siteFileKey(siteRoot, use.resolved, sink.tree)
    if (!key || !existsSync(use.resolved)) {
      if (!sink.warned.has(use.ref)) {
        sink.warned.add(use.ref)
        sink.warnings.push(
          key
            ? `local-media: ${use.ref} (in ${named}) names no file — not uploaded`
            : `local-media: ${use.ref} (in ${named}) is outside the site and the folders it mounts, so a push ` +
                `does not upload it — put it in public/ and write it as /${use.ref.split('/').pop()}`
        )
      }
      continue
    }
    sink.files.set(key, use.resolved)
    sink.refs.add(use.ref)
    if (sink.uploaded?.[key]) use.set(key)
  }
}

/**
 * A section's references as a pull writes them: each key the restore put back that names a site
 * file (`keys` — `sync.json`'s keys that are not a `/x` path) made relative to the file the section
 * is written to. Anything else is returned as it is. Never mutates `value`.
 *
 * @param {*} value - a section's content or params
 * @param {{ siteRoot: string, filePath: string, keys: Set<string>, tree?: Array<[string, string]> }} where
 * @returns {*}
 */
export function writtenRefs(value, { siteRoot, filePath, keys, tree = [] }) {
  if (!keys?.size) return value
  const fromDir = dirname(filePath)
  const ref = (key) => {
    const rel = relative(fromDir, siteFileOf(siteRoot, key, tree)).split(sep).join('/')
    return rel.startsWith('../') ? rel : `./${rel}`
  }
  const map = (v) => {
    if (typeof v === 'string') return keys.has(v) ? ref(v) : v
    if (Array.isArray(v)) return v.map(map)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]))
    return v
  }
  return map(value)
}

/** `sync.json`'s asset keys that name a site file — every key that is not a `/x` path. */
export function siteFileKeys(assetMap) {
  return new Set(Object.keys(assetMap || {}).filter((k) => !k.startsWith('/')))
}
