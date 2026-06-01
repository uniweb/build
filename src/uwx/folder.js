// Build the one `@uniweb/folder` entity that organizes a site's collection records.
//
// A site sync carries the site-content entity, the collection-record entities, and
// — when the site has collections — ONE `@uniweb/folder` entity describing how those
// records are organized. The folder holds REFERENCES, never content:
//
//   - a LEAF references one record entity, by `$ref: "<collection>/<slug>"` when the
//     record has no `$uuid` yet (resolved within this payload), or `entry: <uuid>`
//     when it was minted on an earlier sync (back-filled into the record's file).
//   - a BRANCH is a sub-folder (`path_segment` + nested `entries`).
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

// One record → a `ref` leaf. Known uuid → `entry`; brand-new → `$ref` handle.
function refLeaf(entity) {
  const leaf = { kind: 'ref', path_segment: entity.slug }
  if (entity.uuid) leaf.entry = entity.uuid
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
function defaultEntries(groups) {
  const entries = []
  for (const [collection, records] of groups) {
    entries.push({
      kind: 'branch',
      path_segment: collection,
      entries: records.map(refLeaf),
    })
  }
  return entries
}

// Virtual org from `collections.yml::folders`. Each node is either a collection
// NAME (string — expands to that collection's record leaves under a branch named
// after it) or a `{ segment, label?, entries: [...] }` branch (recursively).
function virtualEntries(folders, groups) {
  const buildNode = (node) => {
    if (typeof node === 'string') {
      const records = groups.get(node) || []
      return {
        kind: 'branch',
        path_segment: node,
        entries: records.map(refLeaf),
      }
    }
    if (node && typeof node === 'object') {
      const segment = node.segment ?? node.path_segment
      const branch = { kind: 'branch', path_segment: segment }
      if (node.label !== undefined) branch.label = node.label
      const children = Array.isArray(node.entries) ? node.entries : []
      branch.entries = children.flatMap((child) => {
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
 * Build the `@uniweb/folder` entity descriptor, or null when there are no records.
 *
 * Carries no `$uuid`: the backend owns the site's folder (resolved from the
 * site-content uuid), so the framework never mints, holds, or sends a folder uuid.
 *
 * @param {object} params
 * @param {object[]} params.recordEntities - the collection-record entities (full
 *        set, BEFORE send-only-changed filtering), each `{ id, uuid, slug, collection? }`
 * @param {Array|null} [params.folders] - `collections.yml::folders` virtual org
 * @returns {{ id, uuid, model, file, document, collection: '@folder' }|null}
 */
export function buildFolderEntity({ recordEntities, folders = null }) {
  if (!Array.isArray(recordEntities) || recordEntities.length === 0) return null
  const groups = groupByCollection(recordEntities)
  const entries = folders ? virtualEntries(folders, groups) : defaultEntries(groups)

  const document = {
    $id: FOLDER_ENTITY_KEY,
    $model: FOLDER_MODEL_NAME,
    entries,
  }

  return {
    id: FOLDER_ENTITY_KEY,
    uuid: null,
    slug: FOLDER_ENTITY_KEY,
    model: FOLDER_MODEL_NAME,
    file: 'entities/folder.json',
    document,
  }
}
