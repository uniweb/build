// Build the one `@uniweb/folder` entity that organizes a site's collection records.
//
// A site sync carries the site-content entity, the collection-record entities, and
// — when the site has collections — ONE `@uniweb/folder` entity describing how those
// records are organized. `@uniweb/folder` is a normal section-keyed entity (the
// "structured content all the way down" invariant): its document is `{ info?, contents }`.
//   - `contents` is the self-nesting tree (an array), nesting via `$children` — the
//     same mechanism site-content pages/sections use. Each node holds REFERENCES,
//     never content:
//       - a LEAF references one record entity: `{ kind: 'ref', path_segment, ... }`
//         with `entry: <uuid>` once the record was minted (back-filled into its file),
//         or `$ref: "<collection>/<slug>"` while brand-new (resolved within this payload).
//       - a BRANCH is a sub-folder: `{ kind: 'branch', path_segment, name?, $children }`.
//
// Organization comes from `collections.yml::folders` (a VIRTUAL tree, decoupled from
// the on-disk layout) when present; otherwise the default is one branch per
// collection, its records as leaves — mirroring the `collections/` subfolders.
//
// The folder carries NO `$uuid` of its own: the backend owns the site's
// `@uniweb/folder` and resolves it from the site-content uuid (the folder sync lane
// is keyed by `site.yml::$uuid`). The framework never holds a folder uuid.

export const FOLDER_MODEL_NAME = '@uniweb/folder'
export const FOLDER_ENTITY_KEY = '@folder'

// One record → a `ref` leaf. The folder's `contents` field is polymorphic (it can
// reference any Model), so the ref uses the entity_ref OPEN form `{ model, entity }`
// — not a bare uuid (a bare uuid is only valid when the field pins a single model).
// Known uuid → `entry: { model, entity: <uuid> }`; brand-new → `$ref` handle
// (resolved within this payload to the minted entity).
//
// TODO: the sync lane is uuid-keyed, so `model` should be the resolved Model UUID;
// it currently carries the Model NAME (e.g. `@std/article`). Wire the name→uuid
// resolution (a registry data-schema read) as a follow-up.
function refLeaf(entity) {
  const leaf = { kind: 'ref', path_segment: entity.slug }
  if (entity.uuid) leaf.entry = { model: entity.model, entity: entity.uuid }
  else leaf.$ref = entity.id // the `<collection>/<slug>` payload-local handle
  return leaf
}

// Group record entities by their collection (the `<collection>` prefix of `$id`).
function groupByCollection(recordEntities) {
  const groups = new Map()
  for (const e of recordEntities) {
    const collection = e.collection ?? String(e.id).split('/')[0]
    if (!groups.has(collection)) groups.set(collection, [])
    groups.get(collection).push(e)
  }
  return groups
}

// Default org: one branch per collection (declaration order), records as leaves.
function defaultContents(groups) {
  const contents = []
  for (const [collection, records] of groups) {
    contents.push({
      kind: 'branch',
      path_segment: collection,
      $children: records.map(refLeaf),
    })
  }
  return contents
}

// Virtual org from `collections.yml::folders`. Each node is either a collection
// NAME (string — expands to that collection's record leaves under a branch named
// after it) or a `{ segment, label?, entries: [...] }` branch (recursively).
function virtualContents(folders, groups) {
  const buildNode = (node) => {
    if (typeof node === 'string') {
      const records = groups.get(node) || []
      return {
        kind: 'branch',
        path_segment: node,
        $children: records.map(refLeaf),
      }
    }
    if (node && typeof node === 'object') {
      const segment = node.segment ?? node.path_segment
      const branch = { kind: 'branch', path_segment: segment }
      if (node.label !== undefined) branch.name = node.label
      const children = Array.isArray(node.entries) ? node.entries : []
      branch.$children = children.flatMap((child) => {
        // A bare collection name inside `entries:` expands to its leaves directly
        // (so the records sit in THIS branch, not a nested one).
        if (typeof child === 'string' && groups.has(child)) {
          return (groups.get(child) || []).map(refLeaf)
        }
        return [buildNode(child)]
      })
      return branch
    }
    return null
  }
  return folders.map(buildNode).filter(Boolean)
}


/**
 * Walk a folder document's `contents` tree, visiting every item with the
 * slash-joined `path_segment` chain that addresses it.
 *
 * ⛔ IT MUST RECURSE INTO `$children`. `contents` is SELF-NESTING: a walk of the
 * top level sees the branches and misses every record under them — which is 6 of
 * the 7 entries in a two-collection site. *(Named by the backend lane, 2026-08-27,
 * before it could be got wrong.)*
 */
function walkFolderItems(contents, cb, prefix = '') {
  for (const item of contents || []) {
    if (!item || typeof item !== 'object') continue
    const seg = typeof item.path_segment === 'string' ? item.path_segment : null
    const path = seg ? (prefix ? `${prefix}/${seg}` : seg) : prefix
    if (seg) cb(path, item)
    walkFolderItems(item.$children, cb, path)
  }
}

/**
 * Harvest per-item identity from the folder document the backend returns.
 *
 * ⭐ THE KEY IS THE `path_segment` CHAIN, and it is the right one because the
 * backend's own model declares `path_segment` SIBLING-UNIQUE — so the chain is
 * unique within the folder, stable across pushes, and derivable identically on
 * both sides without either lane holding the other's ids.
 *
 * @param {object} doc - a stored `@uniweb/folder` document (`{ contents: [...] }`)
 * @returns {Record<string,string>} path → `$uuid`
 */
export function collectFolderItemUuids(doc) {
  const out = {}
  walkFolderItems(doc?.contents, (path, item) => {
    if (typeof item.$uuid === 'string' && item.$uuid) out[path] = item.$uuid
  })
  return out
}

/**
 * Stamp known `$uuid`s onto a folder document about to be sent, so the backend
 * matches its stored rows instead of reading every item as new.
 *
 * ⛔ WHY THIS EXISTS. `contents` is a `multi` section: an item without a `$uuid`
 * is a new row, so re-sending the folder without identity would replace every
 * placement. The backend refuses that outright (`identity_required`) — correctly
 * — and the refusal is what a `publish` after a `push` used to hit, because
 * send-only-changed skips the unchanged RECORDS and re-sends the FOLDER alone.
 *
 * ⚠️ The folder ENTITY still carries no `$uuid` — that stays the backend's, keyed
 * from the site-content uuid. This is about its ITEMS, and the two were conflated
 * by a comment in this file that was true of the entity and false of its contents.
 *
 * @returns {{ stamped: number, unknown: number }}
 */
export function stampFolderItemUuids(doc, pathToUuid = {}) {
  let stamped = 0
  let unknown = 0
  walkFolderItems(doc?.contents, (path, item) => {
    const uuid = pathToUuid[path]
    if (uuid) {
      item.$uuid = uuid
      stamped++
    } else {
      unknown++
    }
  })
  return { stamped, unknown }
}

/**
 * Build the `@uniweb/folder` entity descriptor, or null when there are no records.
 *
 * Carries no `$uuid`: the backend owns the site's folder (resolved from the
 * site-content uuid), so the framework never mints, holds, or sends a folder uuid.
 *
 * @param {object} params
 * @param {object[]} params.recordEntities - the collection-record entities (full
 *        set, BEFORE send-only-changed filtering), each `{ id, uuid, slug, collection? }`
 * @param {Array|null} [params.folders] - `collections.yml::folders` virtual org
 * @param {Record<string,string>} [params.itemUuids] - path → `$uuid`, harvested
 *        from the folder document a previous push returned. Absent on a first
 *        push, where every item is genuinely new.
 * @returns {{ id, uuid, model, file, document, collection: '@folder' }|null}
 */
export function buildFolderEntity({ recordEntities, folders = null, itemUuids = null }) {
  if (!Array.isArray(recordEntities) || recordEntities.length === 0) return null
  const groups = groupByCollection(recordEntities)
  const contents = folders ? virtualContents(folders, groups) : defaultContents(groups)

  const document = {
    $id: FOLDER_ENTITY_KEY,
    $model: FOLDER_MODEL_NAME,
    contents,
  }
  // Re-arm placement identity. Without it a second send reads as "every item is
  // new" and the backend refuses rather than replacing them all.
  if (itemUuids && Object.keys(itemUuids).length) stampFolderItemUuids(document, itemUuids)

  return {
    id: FOLDER_ENTITY_KEY,
    uuid: null,
    slug: FOLDER_ENTITY_KEY,
    model: FOLDER_MODEL_NAME,
    file: 'entities/folder.json',
    document,
  }
}
