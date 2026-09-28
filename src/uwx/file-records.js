// ⭐ A FILE RECORD IS A FOLDER ENTRY OF KIND `file`, NEVER AN ENTITY — `@uniweb/file` (2026-09-28).
//
// On the file side the file itself is the record (`site/file-records.js`): any file in
// `records/uniweb/file/`, named by its stem, its label and tags on its `folder.yml` entry. On the wire
// a backend holds it as an item of the site's `@uniweb/folder`:
//
//     { kind: 'file', name, file: { url, name, mime, size, preview?, assetId, assetExt, … }, label?, tags?, $uuid? }
//
// — its value an ASSET: the file goes up through the asset lane the site's media use (owned by the
// site), and the push writes the serve URL and the asset's identity where the upload key stood,
// exactly as it does for media (`sync-package.js::rewriteEntityAssets`).
//
// ⭐ ITS IDENTITY is the entry's `$uuid`. A file cannot carry it, so the CLI banks it per backend in
// `sync.json`, keyed by the file's path in the records directory (`files`): a renamed file is a new
// record, as a renamed record file's name is a new name.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { labelOnWire } from '../site/entry-label.js'
import { FILE_RECORD_DIRS } from '../site/entity-pool.js'
import { fileRecordValue, makeFilePreview, mimeFor } from '../site/file-records.js'

export { FILE_MODEL } from '../site/file-records.js'

/** The key a push writes where a file record's URL goes, until its upload maps it to the serve URL. */
export const fileUploadKey = (poolPath) => `records/${poolPath}`
/** …and where its preview's goes. */
export const previewUploadKey = (poolPath) => `records/${poolPath}.preview.webp`

/**
 * Each file record's value as a push first writes it — upload keys where the URLs go — and the files
 * the push uploads for them: the file, and a PDF's preview made into `.uniweb/file-previews/`.
 *
 * @param {object} params
 * @param {Array<{ poolPath: string, name: string, absPath: string }>} params.files
 * @param {string} params.siteRoot
 * @returns {Promise<{ values: Map<string, object>, uploads: Array<{ ref: string, path: string, contentType: string }> }>}
 *   `values` by pool path
 */
export async function fileRecordUploads({ files = [], siteRoot }) {
  const values = new Map()
  const uploads = []
  for (const f of files) {
    const previewPath = join(siteRoot, '.uniweb', 'file-previews', `${f.poolPath}.preview.webp`)
    mkdirSync(dirname(previewPath), { recursive: true })
    const hasPreview = (await makeFilePreview(f.absPath, previewPath)) && existsSync(previewPath)
    values.set(
      f.poolPath,
      fileRecordValue({
        absPath: f.absPath,
        name: f.name,
        url: fileUploadKey(f.poolPath),
        ...(hasPreview ? { preview: previewUploadKey(f.poolPath) } : {}),
      })
    )
    uploads.push({ ref: fileUploadKey(f.poolPath), path: f.absPath, contentType: mimeFor(f.name) })
    if (hasPreview) uploads.push({ ref: previewUploadKey(f.poolPath), path: previewPath, contentType: 'image/webp' })
  }
  return { values, uploads }
}

/**
 * A file entry as the wire carries it.
 *
 * @param {{ slug: string, uuid?: string|null, value: object }} file
 * @param {{ label?: *, tags?: string[] }} node - its placement
 * @param {string} sourceLocale
 */
export function fileLeaf(file, node, sourceLocale) {
  const leaf = { kind: 'file', name: file.slug, file: { ...file.value } }
  if (file.uuid) leaf.$uuid = file.uuid
  if (node?.label !== undefined) leaf.label = labelOnWire(node.label, sourceLocale)
  if (Array.isArray(node?.tags) && node.tags.length) leaf.tags = [...node.tags]
  return leaf
}

/**
 * Every file entry in a folder document.
 *
 * @param {object} folderDoc - `{ contents }`, nesting through `$children`
 * @returns {object[]}
 */
export function fileItems(folderDoc) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue
      if (node.kind === 'branch') walk(node.$children)
      else if (node.kind === 'file') out.push(node)
    }
  }
  walk(folderDoc?.contents)
  return out
}

/**
 * After a push: the uuid the backend holds each file entry under, by the file's path — what the CLI
 * banks in `sync.json` (`files`). Matched by name: a file record's name is its file's stem, and no
 * two share one.
 *
 * @param {object} params
 * @param {Array<{ slug: string, poolPath: string }>} params.files
 * @param {object} params.folderDoc - the folder document the backend returned
 * @returns {Object<string,string>} pool path → the backend's uuid
 */
export function bankedFileUuids({ files = [], folderDoc }) {
  const bySlug = new Map(files.map((f) => [f.slug, f]))
  const out = {}
  for (const item of fileItems(folderDoc)) {
    const file = bySlug.get(item.name)
    if (file && typeof item.$uuid === 'string' && item.$uuid) out[file.poolPath] = item.$uuid
  }
  return out
}

/**
 * A pull: where each file entry of the folder lands in `records/uniweb/file/`, and which files have
 * to be fetched — a file the project already holds under that entry's identity is kept, one whose
 * asset has changed is fetched again, and one it does not hold is fetched to `<its name>`.
 *
 * ⛔ A FILE OF THAT NAME HOLDING ANOTHER RECORD IS NOT WRITTEN OVER — reported, and left out.
 *
 * @param {object} params
 * @param {object} params.folderDoc
 * @param {string} params.recordsRoot - the records directory, absolute
 * @param {Object<string,string>} [params.fileMap] - pool path → the backend's uuid (`sync.json` `files`)
 * @param {Object<string,{ id: string }>} [params.assetMap] - upload key → the asset it last uploaded as
 * @returns {{ pathByUuid: Map<string,string>, downloads: Array<{ url: string, path: string, poolPath: string, ref: string, assetId?: string, assetExt?: string }>, learned: Object<string,string>, warnings: string[] }}
 *   a download's `ref` is the key its asset is recorded under (`sync.json` `assets`), as a push records it
 */
export function filesToPull({ folderDoc, recordsRoot, fileMap = {}, assetMap = {} }) {
  const pathByTheirs = new Map(Object.entries(fileMap).map(([poolPath, theirs]) => [theirs, poolPath]))
  const pathByUuid = new Map()
  const downloads = []
  const learned = {}
  const warnings = []
  for (const item of fileItems(folderDoc)) {
    const theirs = typeof item.$uuid === 'string' && item.$uuid ? item.$uuid : null
    const url = typeof item.file?.url === 'string' ? item.file.url : null
    const fileName = fileNameFor(item)
    if (!theirs || !url || !fileName) {
      warnings.push(`the folder holds a file ("${item.name ?? '?'}") with no identity, url or name — not written.`)
      continue
    }
    let poolPath = pathByTheirs.get(theirs) || null
    const held = poolPath && existsSync(join(recordsRoot, ...poolPath.split('/')))
    if (!held) {
      poolPath = [...FILE_RECORD_DIRS, fileName].join('/')
      const at = join(recordsRoot, ...poolPath.split('/'))
      if (existsSync(at) && fileMap[poolPath] !== theirs) {
        warnings.push(`${poolPath} holds another file than the folder's "${item.name}" — it was not written over.`)
        continue
      }
    }
    const path = join(recordsRoot, ...poolPath.split('/'))
    const current = assetMap[fileUploadKey(poolPath)]?.id
    if (!held || (item.file.assetId && current !== item.file.assetId)) {
      downloads.push({
        url,
        path,
        poolPath,
        ref: fileUploadKey(poolPath),
        ...(item.file.assetId ? { assetId: item.file.assetId, assetExt: item.file.assetExt || '' } : {}),
      })
    }
    pathByUuid.set(theirs, poolPath)
    learned[poolPath] = theirs
  }
  return { pathByUuid, downloads, learned, warnings }
}

/** The name a pulled file is written under: its value's `name`, else the entry's name and the asset's extension. */
function fileNameFor(item) {
  const named = typeof item.file?.name === 'string' ? item.file.name.trim() : ''
  if (named && !named.includes('/') && !named.includes('\\') && !named.startsWith('.')) return named
  const ext = typeof item.file?.assetExt === 'string' && item.file.assetExt ? `.${item.file.assetExt}` : ''
  return typeof item.name === 'string' && item.name ? `${item.name}${ext}` : null
}
