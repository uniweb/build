// ⭐ A FILE RECORD — `@uniweb/file` (2026-09-28 [Diego]). The file itself is the record: any file
// placed in `<records>/uniweb/file/` (`entity-pool.js::FILE_RECORD_DIRS`) is a record named by its
// stem, and its label and tags are its `folder.yml` entry's.
//
// ⭐ ITS VALUE IS AN ASSET, the same object on every lane:
//
//     { url, name, mime, size, preview? }
//
// — `url` where the file is served, `name` its file name, `mime` and `size` from the file, and for a
// PDF a `preview` image. Uploaded to a host, the asset's identity rides beside each URL as media's
// does (`assetId`/`assetExt`, `previewAssetId`/`previewAssetExt` — `@uniweb/semantic-parser`'s
// `ASSET_SLOTS`), so a host that moves its assets costs a config edit, not a migration. A component
// reads `file.url` wherever it renders.
//
// ⚠️ A PDF's preview is a PLACEHOLDER card ("PDF · N pages", `advanced-processors.js::
// generatePdfThumbnail`), not a render of the page — and none at all without `pdf-lib`.

import { statSync } from 'node:fs'
import { extname } from 'node:path'
import { mimeFor } from '@uniweb/semantic-parser'
import { generatePdfThumbnail } from './advanced-processors.js'

export const FILE_MODEL = '@uniweb/file'

// What a file is, by its extension — for the `mime` a file record carries and the type its upload
// declares. ⭐ The table is `@uniweb/semantic-parser`'s: the parser reads it for a document's `mime`,
// and could not reach one here — it has no dependencies. One table; anything not in it is
// `application/octet-stream`.
export { mimeFor }

/** Is this file a PDF — the one type a preview is made for? */
export function isPdfFile(name) {
  return extname(String(name || '')).toLowerCase() === '.pdf'
}

/**
 * A file record's value: `{ url, name, mime, size }`, with `preview` when one is given.
 *
 * @param {object} params
 * @param {string} params.absPath - the file
 * @param {string} params.name - its file name (`brochure.pdf`)
 * @param {string} params.url - where it is served, or the key a push rewrites to that
 * @param {string} [params.preview] - where its preview is served, or the key a push rewrites
 * @returns {{ url: string, name: string, mime: string, size: number, preview?: string }}
 */
export function fileRecordValue({ absPath, name, url, preview }) {
  const value = { url, name, mime: mimeFor(name), size: statSync(absPath).size }
  if (preview) value.preview = preview
  return value
}

/**
 * Make a PDF's preview image at `outputPath` — a placeholder card, not a render of the page — or
 * report that none was made (not a PDF, or `pdf-lib` not installed).
 *
 * @returns {Promise<boolean>} whether a preview now exists at `outputPath`
 */
export async function makeFilePreview(absPath, outputPath) {
  if (!isPdfFile(absPath)) return false
  const result = await generatePdfThumbnail(absPath, outputPath)
  return Boolean(result?.success)
}
