/**
 * MEDIA BESIDE A PAGE, ON THE SYNC LANE — how a push uploads a co-located file (`./team.jpg`) and
 * a pull writes its reference back.
 *
 * A `/x` reference names one file wherever it is written, so a push uploads it under that name and
 * `sync.json`'s asset map remembers its identity by it. `./team.jpg` names a different file beside
 * every page, so the push keys it by the file's path from the site root — `pages/home/team.jpg` —
 * as a file record is keyed (`file-records.js`). The key goes into the upload and into `sync.json`,
 * and into a document only where the emit was handed the upload that names it, which swaps it for
 * the served URL in the same pass (`rewriteEntityAssets`): a document no upload went with keeps the
 * reference as written. A pull writes the author's reference back, relative to the file the
 * section is written to (`writtenRefs`).
 *
 * ⛔ Until 2026-10-28 a push uploaded only `/x` media and skipped a co-located file with a warning,
 * so a site that showed its media under `uniweb dev` and in a static build lost it when published.
 *
 * ⚠️ A file outside the site's folder — a mounted folder's — has no such key, and stays warned and
 * skipped. Two files with the same bytes are one asset, so a pull may write either one's path.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * The key a push uploads a site's file under: its path from the site root, or null for a file
 * outside it.
 *
 * @param {string} siteRoot
 * @param {string} file - absolute
 * @returns {string|null} `pages/home/team.jpg`
 */
export function siteFileKey(siteRoot, file) {
  const rel = relative(siteRoot, file)
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
  return { uploaded, files: new Map(), refs: new Set(), warned: new Set(), warnings: [] }
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
  const named = siteFileKey(siteRoot, filePath) || relative(siteRoot, filePath).split(sep).join('/')
  for (const use of assetCollection?.uses || []) {
    const key = siteFileKey(siteRoot, use.resolved)
    if (!key || !existsSync(use.resolved)) {
      if (!sink.warned.has(use.ref)) {
        sink.warned.add(use.ref)
        sink.warnings.push(
          key
            ? `local-media: ${use.ref} (in ${named}) names no file — not uploaded`
            : `local-media: ${use.ref} (in ${named}) is outside the site's folder, so a push does not upload it — ` +
                `put it in public/ and write it as /${use.ref.split('/').pop()}`
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
 * @param {{ siteRoot: string, filePath: string, keys: Set<string> }} where
 * @returns {*}
 */
export function writtenRefs(value, { siteRoot, filePath, keys }) {
  if (!keys?.size) return value
  const fromDir = dirname(filePath)
  const ref = (key) => {
    const rel = relative(fromDir, join(siteRoot, key)).split(sep).join('/')
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
