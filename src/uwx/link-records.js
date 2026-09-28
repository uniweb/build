// ⭐ A LINK RECORD IS A FOLDER ENTRY, NEVER AN ENTITY — `@uniweb/link` (2026-09-28).
//
// On the file side a link is a record like any other: a file in `records/uniweb/link/`, holding its
// `url` (and, once it has reached a backend, its `$uuid`), placed in the folder by
// `records/folder.yml`, which also gives its `label` and `tags` — they are its ENTRY's, not the
// Model's. A static build compiles it like any record (`@uniweb/schemas/system`).
//
// On the wire a link is not an entity at all: a backend holds it as an item of the site's
// `@uniweb/folder` of kind `link`, its data on the item — `{ kind: 'link', name, url, label?, tags? }`
// — and the item's `$uuid` is the record's identity. A push that sent an entity of `@uniweb/link`
// would be refused. So the push lowers each link record into such an entry (`folder.js`), the CLI
// banks the uuid the backend gives it the way a record's is banked — in the file the first time,
// mapped per backend after that — and a pull writes each link entry back as its file.
//
// `@uniweb/file` is not built: how a file reference is stored is still open.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { labelOnWire } from '../site/entry-label.js'
import { poolDirsForSchema } from '../site/entity-pool.js'
import { backfillUuid } from './backfill.js'

export const LINK_MODEL = '@uniweb/link'

/** Where link records live, below the records directory: `uniweb/link`. */
export const LINK_DIRS = poolDirsForSchema(LINK_MODEL)

/**
 * Why a link record cannot be sent as written, or null when it can.
 *
 * @param {{ data?: object, body?: string }} record - a record as its file reader returns it
 * @param {string} where - the file, for the message
 * @returns {string|null}
 */
export function linkRecordRefusal(record, where) {
  const data = record?.data && typeof record.data === 'object' ? record.data : {}
  if (typeof record?.body === 'string' && record.body.trim()) {
    return `${where}: a link record has no body — it holds its \`url\` alone.`
  }
  if (data.draft !== undefined) {
    return (
      `${where}: a link cannot be kept off a published site yet, so a draft link is not sent. ` +
      `Remove \`draft:\` to send it, or the file to leave it out.`
    )
  }
  const placement = ['label', 'tags'].filter((k) => data[k] !== undefined)
  if (placement.length) {
    const keys = placement.map((k) => `\`${k}:\``).join(' and ')
    return (
      `${where}: a link's ${keys} ${placement.length === 1 ? 'is' : 'are'} its folder entry's, not the ` +
      `record's — give ${placement.length === 1 ? 'it' : 'them'} in records/folder.yml, on the entry ` +
      `\`- path: ${LINK_DIRS.join('/')}/<file>\`.`
    )
  }
  const extra = Object.keys(data).filter((k) => k !== 'url' && k !== '$uuid')
  if (extra.length) {
    return `${where}: a link record holds its \`url\` and nothing else — not ${extra.map((k) => `\`${k}:\``).join(', ')}.`
  }
  if (typeof data.url !== 'string' || !data.url.trim()) return `${where}: a link record needs a \`url\`.`
  return null
}

/**
 * A link entry as the wire carries it: `{ kind: 'link', name, url }`, with the uuid this backend
 * holds it under, and the label and tags its placement gives.
 *
 * @param {{ slug: string, url: string, uuid?: string|null }} link
 * @param {{ label?: *, tags?: string[] }} node - its placement (`records-config.js::resolveFolder`)
 * @param {string} sourceLocale
 */
export function linkLeaf(link, node, sourceLocale) {
  const leaf = { kind: 'link', name: link.slug, url: link.url }
  if (link.uuid) leaf.$uuid = link.uuid
  if (node?.label !== undefined) leaf.label = labelOnWire(node.label, sourceLocale)
  if (Array.isArray(node?.tags) && node.tags.length) leaf.tags = [...node.tags]
  return leaf
}

/**
 * Every link entry in a folder document, with the branch it sits in.
 *
 * @param {object} folderDoc - `{ contents }`, nesting through `$children`
 * @returns {Array<{ item: object, branch: string }>}
 */
export function linkItems(folderDoc) {
  const out = []
  const walk = (nodes, branch) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue
      if (node.kind === 'branch') walk(node.$children, branch ? `${branch}/${node.name}` : node.name)
      else if (node.kind === 'link') out.push({ item: node, branch })
    }
  }
  walk(folderDoc?.contents, '')
  return out
}

/**
 * After a push: the uuid the backend holds each link entry under, banked as a record's is.
 *
 * A link that has an own id maps it to this backend's uuid. A link with none — the first backend it
 * reaches — takes that uuid as its own: it is written into the file, and the map is identity.
 * Matched by name: a link's name is its file's, so no two links share one.
 *
 * @param {object} params
 * @param {Array<{ slug: string, ownId: string|null, sourceFile: string|null }>} params.links
 * @param {object} params.folderDoc - the folder document the backend returned
 * @returns {{ mapped: Object<string,string>, updated: string[], warnings: string[] }}
 */
export function backfillLinkUuids({ links = [], folderDoc }) {
  const bySlug = new Map(links.map((l) => [l.slug, l]))
  const mapped = {}
  const updated = []
  const warnings = []
  for (const { item } of linkItems(folderDoc)) {
    const link = bySlug.get(item.name)
    if (!link || typeof item.$uuid !== 'string' || !item.$uuid) continue
    if (link.ownId) {
      mapped[link.ownId] = item.$uuid
      continue
    }
    if (!link.sourceFile) continue
    const res = backfillUuid(link.sourceFile, item.$uuid)
    if (res.status === 'error' || res.status === 'deferred') {
      warnings.push(`${link.sourceFile}: ${res.message}`)
      continue
    }
    if (res.status === 'updated') updated.push(link.sourceFile)
    mapped[item.$uuid] = item.$uuid
  }
  return { mapped, updated, warnings }
}

/** A link file's `$uuid` and `url`, or null when it does not read as one. */
function readLinkFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const data = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : yaml.load(text, YAML_OPTIONS)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

const LINK_EXTENSIONS = ['.yml', '.yaml', '.json']

/**
 * A pull: each link entry of the folder written as its record file in `records/uniweb/link/` —
 * `$uuid` (the link's own id) and `url` — the inverse of what a push sends.
 *
 * ⛔ A FILE OF THAT NAME HOLDING ANOTHER LINK IS NOT WRITTEN OVER: the entry is reported and left
 * out, rather than one link taking another's file.
 *
 * @param {object} params
 * @param {object} params.folderDoc
 * @param {string} params.recordsRoot - the records directory, absolute
 * @param {Map<string,string>} params.ownIdByTheirs - this backend's uuid → the record's own id
 * @returns {{ pathByUuid: Map<string,string>, learned: Object<string,string>, placed: string[], updated: string[], unchanged: string[], warnings: string[] }}
 *   `pathByUuid` — the backend's uuid → the file, relative to the records directory
 */
export function writeLinkRecords({ folderDoc, recordsRoot, ownIdByTheirs = new Map() }) {
  const dir = join(recordsRoot, ...LINK_DIRS)
  const pathByUuid = new Map()
  const learned = {}
  const placed = []
  const updated = []
  const unchanged = []
  const warnings = []

  // The link files already here, by own id.
  const held = new Map()
  const files = existsSync(dir)
    ? readdirSync(dir).sort().filter((name) => !name.startsWith('_') && LINK_EXTENSIONS.includes(extname(name).toLowerCase()))
    : []
  for (const name of files) {
    const data = readLinkFile(join(dir, name))
    if (typeof data?.$uuid === 'string' && data.$uuid) held.set(data.$uuid, name)
  }

  for (const { item } of linkItems(folderDoc)) {
    const theirs = typeof item.$uuid === 'string' && item.$uuid ? item.$uuid : null
    if (!theirs || typeof item.name !== 'string' || !item.name || typeof item.url !== 'string') {
      warnings.push(`the folder holds a link ("${item.name ?? '?'}") with no identity or no url — not written.`)
      continue
    }
    const ownId = ownIdByTheirs.get(theirs) || theirs
    let name = held.get(ownId)
    let status
    if (name) {
      const path = join(dir, name)
      const data = readLinkFile(path) || {}
      if (data.url === item.url) {
        status = 'unchanged'
      } else {
        writeLinkFile(path, { ...data, $uuid: ownId, url: item.url })
        status = 'updated'
      }
    } else {
      name = `${item.name}.yml`
      const path = join(dir, name)
      const there = existsSync(path) ? readLinkFile(path) : null
      if (there) {
        warnings.push(
          `${[...LINK_DIRS, name].join('/')} holds another link than the folder's "${item.name}" — ` +
            `it was not written over, and the folder's link was not written.`
        )
        continue
      }
      mkdirSync(dir, { recursive: true })
      writeLinkFile(path, { $uuid: ownId, url: item.url })
      status = 'placed'
    }
    const path = join(dir, name)
    ;(status === 'placed' ? placed : status === 'updated' ? updated : unchanged).push(path)
    pathByUuid.set(theirs, [...LINK_DIRS, name].join('/'))
    learned[ownId] = theirs
  }
  return { pathByUuid, learned, placed, updated, unchanged, warnings }
}

function writeLinkFile(path, data) {
  const { $uuid, url, ...rest } = data
  const ordered = { ...($uuid ? { $uuid } : {}), url, ...rest }
  const text = extname(path).toLowerCase() === '.json' ? JSON.stringify(ordered, null, 2) + '\n' : yaml.dump(ordered)
  writeFileSync(path, text)
}
