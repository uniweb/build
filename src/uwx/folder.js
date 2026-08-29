// Build the one `@uniweb/folder` entity that organizes a site's records.
//
// A site sync carries the site-content entity, the record entities, and — when the
// site has records — ONE `@uniweb/folder` entity describing how they are
// organized. `@uniweb/folder` is a normal section-keyed entity (the "structured
// content all the way down" invariant): its document is `{ info?, contents }`.
//   - `contents` is the self-nesting tree (an array), nesting via `$children` — the
//     same mechanism site-content pages/sections use. Each node holds REFERENCES,
//     never content:
//       - a LEAF references one record entity: `{ kind: 'ref', path_segment, ... }`
//         with `entry: <uuid>` once the record was minted (back-filled into its file),
//         or `$ref: "<id>"` while brand-new (resolved within this payload).
//       - a BRANCH is a sub-folder: `{ kind: 'branch', path_segment, name?, $children }`.
//
// ⭐ THE ORGANIZATION IS AUTHORED, IN `records.yml`, AND IT IS THE ONLY SOURCE.
// It used to be DERIVED — one branch per collection, mirroring the `collections/`
// subfolders, with an optional `collections.yml::folders` virtual tree layered
// over it. Both are gone, and the difference is the point: a folder is a thing
// the author states, not a shadow of a directory layout. `records.yml` also
// decides WHAT syncs at all, since listing an entity is what makes it a record.
//
// ⛔ SO THERE IS NO DEFAULT. A site with no `records.yml` has no folder and syncs
// no records — which is the model's `missing ⇒ inert` ruling, not an empty folder.
// Do not reintroduce a fallback grouping: it would resurrect exactly the
// three-jobs-in-one-directory conflation the layout was changed to remove.
//
// The folder carries NO `$uuid` of its own: the backend owns the site's
// `@uniweb/folder` and resolves it from the site-content uuid (the folder sync lane
// is keyed by `site.yml::$uuid`). The framework never holds a folder uuid.

export const FOLDER_MODEL_NAME = '@uniweb/folder'
export const FOLDER_ENTITY_KEY = '@folder'

// Point one authored leaf at the record entity it names. The folder's `contents`
// field is polymorphic (it can reference any Model), so the ref uses the
// entity_ref OPEN form `{ model, entity }` — not a bare uuid (a bare uuid is only
// valid when the field pins a single model). Known uuid → `entry: { model, entity
// }`; brand-new → `$ref` handle (resolved within this payload to the minted
// entity).
//
// TODO: the sync lane is uuid-keyed, so `model` should be the resolved Model UUID;
// it currently carries the Model NAME (e.g. `@std/article`). Wire the name→uuid
// resolution (a registry data-schema read) as a follow-up.
function refLeaf(entity) {
  const leaf = { kind: 'ref', path_segment: entity.slug }
  if (entity.uuid) leaf.entry = { model: entity.model, entity: entity.uuid }
  else leaf.$ref = entity.id // the payload-local handle
  return leaf
}

/**
 * Turn the resolved `records.yml` tree into folder `contents`.
 *
 * ⛔ A LEAF WHOSE ENTITY IS MISSING IS DROPPED AND REPORTED, never emitted empty.
 * A `ref` with neither `entry` nor `$ref` is a placement pointing at nothing —
 * the backend cannot resolve it, and the failure would surface there rather than
 * here, as somebody else's error.
 *
 * @param {Array} nodes - from `site/records-config.js::resolveFolder`
 * @param {Map<string, object>} byEntityId - record entities, keyed by pool id
 * @param {string[]} missing - collects ids that resolved to no entity
 */
function contentsFromNodes(nodes, byEntityId, missing) {
  const out = []
  for (const node of nodes || []) {
    if (node.kind === 'branch') {
      const branch = { kind: 'branch', path_segment: node.path_segment }
      if (node.name !== undefined) branch.name = node.name
      branch.$children = contentsFromNodes(node.$children, byEntityId, missing)
      out.push(branch)
      continue
    }
    const entity = byEntityId.get(node.$entityId)
    if (!entity) {
      missing.push(node.$entityId)
      continue
    }
    out.push(refLeaf(entity))
  }
  return out
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
 * Build the `@uniweb/folder` entity descriptor, or null when the folder is empty.
 *
 * Carries no `$uuid`: the backend owns the site's folder (resolved from the
 * site-content uuid), so the framework never mints, holds, or sends a folder uuid.
 *
 * @param {object} params
 * @param {object[]} params.recordEntities - the record entities (full set, BEFORE
 *        send-only-changed filtering), each `{ id, uuid, slug, model }`
 * @param {Array} params.folderNodes - the resolved `records.yml` tree
 * @param {boolean} [params.declared] - whether `records.yml` EXISTS. See below.
 * @param {Record<string,string>} [params.itemUuids] - path → `$uuid`, harvested
 *        from the folder document a previous push returned. Absent on a first
 *        push, where every item is genuinely new.
 * @returns {{ id, uuid, model, file, document, warnings }|null}
 */
export function buildFolderEntity({ recordEntities, folderNodes = [], declared, itemUuids = null }) {
  // ⛔ `missing` AND `empty` ARE DIFFERENT, AND THE ASYMMETRY IS DELIBERATE.
  //
  //   no records.yml       → null. INERT: nothing is sent, and the server's
  //                          folder is left exactly as it is.
  //   records.yml, empty   → a folder with `contents: []`. DESTRUCTIVE: it says
  //                          the folder holds nothing, so the backend removes
  //                          what is there.
  //
  // ⭐ The safe state is the ABSENCE of a file and the destructive act requires
  // affirmatively CREATING one — so a live folder cannot be wiped by deleting
  // something. ⛔ Do not "simplify" these into one behaviour to avoid the
  // placeholder hazard (an empty file created meaning to fill it in): that would
  // delete a capability to avoid writing a prompt. The CLI asks, with a count.
  const empty = !Array.isArray(folderNodes) || folderNodes.length === 0
  if (empty && !declared) return null

  const byEntityId = new Map()
  for (const e of recordEntities || []) byEntityId.set(e.id, e)

  const missing = []
  const contents = contentsFromNodes(folderNodes, byEntityId, missing)
  const warnings = missing.map(
    (id) =>
      `folder: "${id}" is placed in records.yml but produced no record entity — ` +
      `the placement was dropped rather than sent pointing at nothing.`
  )

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
    warnings,
  }
}
