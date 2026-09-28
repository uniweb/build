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
import { generatePdfThumbnail } from './advanced-processors.js'

export const FILE_MODEL = '@uniweb/file'

// What a file is, by its extension — for the `mime` a file record carries and the type its upload
// declares. Anything not here is `application/octet-stream`.
const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/**
 * The media type of a file, by its extension.
 *
 * @param {string} name - a file name or path
 * @returns {string}
 */
export function mimeFor(name) {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

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
