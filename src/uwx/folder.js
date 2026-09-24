// Build the one `@uniweb/folder` entity that organizes a site's records.
//
// A site sync carries the site-content entity, the record entities, and — when the
// site has records — ONE `@uniweb/folder` entity describing how they are
// organized. `@uniweb/folder` is a normal section-keyed entity (the "structured
// content all the way down" invariant): its document is `{ info?, contents }`.
//   - `contents` is the self-nesting tree (an array), nesting via `$children` — the
//     same mechanism site-content pages/sections use. Each node holds REFERENCES,
//     never content:
//       - a LEAF references one record entity: `{ kind: 'ref', name, ... }` with
//         `entry: <uuid>` once the record was minted (back-filled into its file),
//         or `$ref: "<id>"` while brand-new (resolved within this payload).
//       - a BRANCH is a sub-folder: `{ kind: 'branch', name, label?, $children }`.
//
// ⭐ A LEAF'S `name` IS ITS RECORD'S HANDLE — the slug, the records service's `$name` —
// and a branch's `name` is the segment a query's `scope:` names. `label` is a branch's
// display text, a localized map (`{ en: "Blog" }`).
//
// ⛔ A FOLDER IS NOT A URL MAP, AND ITS NAMES ARE NOT UNIQUE ACROSS SCHEMAS. It is a
// content pool organized for the curator's convenience [Diego, 2026-09-21]; a slug is
// resolved by a (parametric) query over one schema, never by where a record sits, and
// mapping a URL to a folder path takes an explicit `scope: :dir` on a query. So
// `article/intro` and `person/intro` side by side in one folder is ordinary. *(This
// note called `name` "the URL segment, sibling-unique" until 2026-09-21, and that
// wording led straight to a push refusing two such records.)* The store
// renamed the pair on 2026-09-04 (`path_segment` → `name`; the old display `name`
// → `label`); this emitter writes the new shape only and the pull reader
// (`records-project.js`) reads the new shape only. No alias on either side: the
// old key's PRESENCE was the version signal, and there is no population to
// carry.
//
// ⭐ WHAT IS IN THE FOLDER IS THE RECORDS DIRECTORY; HOW IT IS ORGANIZED IS
// `records/folder.yml` (ruled 2026-09-21 [Diego]). Every file in `records/` is a
// record and sits at the top of the folder unless `folder.yml` places it in a sub-folder. The
// organization used to be DERIVED — one branch per collection, mirroring the
// `collections/` subfolders — and the difference is the point: a sub-folder is a
// thing the author states, never a shadow of the schema folders, which declare a
// model and nothing else.
//
// ⛔ A SITE WITH NO RECORDS DIRECTORY SENDS NO FOLDER, which is inert: the backend's
// folder is left as it is, so a site whose records live only there is not emptied
// by a push of its pages. A directory holding no records sends an EMPTY folder,
// which removes what is there — the CLI asks first. (Until 2026-09-21 both states
// were `records.yml`'s — missing and empty — when that file was the membership list.)
//
// The folder carries NO `$uuid` of its own: the backend owns the site's
// `@uniweb/folder` and resolves it from the site-content uuid (the folder sync lane
// is keyed by the site's uuid on that backend, from `sync.json`). The framework
// never holds a folder uuid.

export const FOLDER_MODEL_NAME = '@uniweb/folder'
export const FOLDER_ENTITY_KEY = '@folder'

// Point one authored leaf at the record entity it names. The folder's `contents`
// field is polymorphic (it can reference any data schema), so the ref uses the
// entity_ref OPEN form `{ schema, entity }` — not a bare uuid (a bare uuid is only
// valid when the field pins a single schema). Known uuid → `entry: { schema, entity
// }`; brand-new → `$ref` handle (resolved within this payload to the minted
// entity).
//
// ⭐ `schema` carries the data schema's SCOPED NAME (`@std/article`), never a Model id
// — agreed with backend 2026-09-24: a Model id is the backend's internal identity and
// does not cross `/dev`, while a scoped name is how we address a data schema in the
// registry of the backend we talk to. ⛔ Neither is an identity across backends: each
// has its own registry [Diego, 2026-09-24]. (A TODO here asked
// for the id until then; the agreement settled it the other way.) The key was `model`
// until the same date. Record: `kb/framework/build/uwx-format.md` § 8.
function refLeaf(entity) {
  const leaf = { kind: 'ref', name: entity.slug }
  if (entity.uuid) leaf.entry = { schema: entity.model, entity: entity.uuid }
  else leaf.$ref = entity.id // the payload-local handle
  return leaf
}

/**
 * Turn the placed records into folder `contents`.
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
function contentsFromNodes(nodes, byEntityId, missing, sourceLocale) {
  const out = []
  for (const node of nodes || []) {
    if (node.kind === 'branch') {
      const branch = { kind: 'branch', name: node.name }
      // The display text is a LOCALIZED field on the wire — a `{ locale: value }`
      // map, like every localized scalar this producer sends — keyed by the
      // site's source locale.
      if (node.label !== undefined) branch.label = { [sourceLocale]: String(node.label) }
      branch.$children = contentsFromNodes(node.$children, byEntityId, missing, sourceLocale)
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

// The uuid of the record a leaf references — once minted, `entry: { schema, entity }`
// (a bare uuid is tolerated). A brand-new record's leaf carries `$ref` instead.
function recordOf(item) {
  if (item?.kind !== 'ref') return null
  const e = item.entry
  const uuid = e && typeof e === 'object' ? e.entity : e
  return typeof uuid === 'string' && uuid ? uuid : null
}

/**
 * Walk a folder document's `contents` tree, visiting every item with the keys that
 * address it: its slash-joined `name` chain, whether that chain is UNIQUE among its
 * siblings, and — for a leaf — the uuid of the record it references.
 *
 * ⛔ IT MUST RECURSE INTO `$children`. `contents` is SELF-NESTING: a walk of the
 * top level sees the branches and misses every record under them — which is 6 of
 * the 7 entries in a two-collection site. *(Named by the backend lane, 2026-08-27,
 * before it could be got wrong.)*
 */
function walkFolderItems(contents, cb, prefix = '') {
  const items = (contents || []).filter((item) => item && typeof item === 'object')
  const count = new Map()
  for (const item of items) {
    if (typeof item.name === 'string') count.set(item.name, (count.get(item.name) || 0) + 1)
  }
  for (const item of items) {
    const seg = typeof item.name === 'string' ? item.name : null
    const path = seg ? (prefix ? `${prefix}/${seg}` : seg) : prefix
    if (seg) cb({ path, unique: count.get(seg) === 1, record: recordOf(item) }, item)
    walkFolderItems(item.$children, cb, path)
  }
}

/**
 * Harvest per-item identity from the folder document the backend returns.
 *
 * ⭐ A PLACEMENT IS KEYED BY THE RECORD IT REFERENCES — `@<record uuid>` — because a
 * record has one placement, so that key is unique in the folder whatever the names
 * are. A branch, and a leaf whose name no sibling shares, is ALSO keyed by its `name`
 * chain, which is what every placement map banked before 2026-09-21 holds.
 *
 * ⛔ The chain alone assumed no two siblings share a name. Two records of different
 * schemas can (`article/intro`, `person/intro`), and keyed by `intro` both would
 * have been stamped with one uuid on the next push.
 *
 * @param {object} doc - a stored `@uniweb/folder` document (`{ contents: [...] }`)
 * @returns {Record<string,string>} key → `$uuid` — `@<record uuid>`, or a `name` chain
 */
export function collectFolderItemUuids(doc) {
  const out = {}
  walkFolderItems(doc?.contents, ({ path, unique, record }, item) => {
    if (typeof item.$uuid !== 'string' || !item.$uuid) return
    if (record) out[`@${record}`] = item.$uuid
    if (unique) out[path] = item.$uuid
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
 * ⭐ A leaf takes the uuid banked under its record (`@<record uuid>`) first, and its
 * `name` chain only when no sibling shares the name — the one key an older map has.
 * ⛔ No uuid is stamped twice: two items claiming one row is the failure the record
 * key exists to prevent, so a second claimant goes out without one, as a new row.
 *
 * @returns {{ stamped: number, unknown: number }}
 */
export function stampFolderItemUuids(doc, pathToUuid = {}) {
  let stamped = 0
  let unknown = 0
  const claimed = new Set()
  walkFolderItems(doc?.contents, ({ path, unique, record }, item) => {
    let uuid = record ? pathToUuid[`@${record}`] : undefined
    if (!uuid && unique) uuid = pathToUuid[path]
    if (uuid && !claimed.has(uuid)) {
      item.$uuid = uuid
      claimed.add(uuid)
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
 * @param {Array} params.folderNodes - the placed records: `folder.yml`'s sub-folders,
 *        then every record at the top
 * @param {boolean} [params.declared] - whether the records DIRECTORY exists. See below.
 * @param {Record<string,string>} [params.itemUuids] - path → `$uuid`, harvested
 *        from the folder document a previous push returned. Absent on a first
 *        push, where every item is genuinely new.
 * @param {string} [params.sourceLocale='en'] - the locale a branch `label` is
 *        keyed under on the wire
 * @returns {{ id, uuid, model, file, document, warnings }|null}
 */
export function buildFolderEntity({ recordEntities, folderNodes = [], declared, itemUuids = null, sourceLocale = 'en' }) {
  // ⛔ `missing` AND `empty` ARE DIFFERENT, AND THE ASYMMETRY IS DELIBERATE.
  //
  //   no records directory  → null. INERT: nothing is sent, and the backend's
  //                           folder is left exactly as it is.
  //   a directory, no records → a folder with `contents: []`. DESTRUCTIVE: it says
  //                           the folder holds nothing, so the backend removes
  //                           what is there.
  //
  // ⭐ The safe state is the ABSENCE of the directory, so a site that never had
  // records — or keeps them only on the backend — cannot empty the backend's folder
  // by pushing. ⛔ Do not "simplify" these into one behaviour: that would delete a
  // capability to avoid writing a prompt. The CLI asks, with a count.
  const empty = !Array.isArray(folderNodes) || folderNodes.length === 0
  if (empty && !declared) return null

  const byEntityId = new Map()
  for (const e of recordEntities || []) byEntityId.set(e.id, e)

  const missing = []
  const contents = contentsFromNodes(folderNodes, byEntityId, missing, sourceLocale)
  // ⚠️ `id` IS THE RECORD'S PATH IN THE RECORDS DIRECTORY, NOT A FOLDER PATH — say
  // so, because the two read identically and a reader who takes it for a placement
  // concludes the emitter is dropping a branch it never had. *(Measured 2026-08-31:
  // the backend lane read `folder: "articles/outdoor-hygge"` as a placement under an
  // `articles` branch and opened a channel about a missing branch node; the string
  // was naming the file `articles/outdoor-hygge.md`.)*
  const warnings = missing.map(
    (id) =>
      `the record "${id}" — a path under the records directory — is placed in the ` +
      `folder, but no record entity was produced for it. The placement was dropped ` +
      `rather than sent pointing at nothing.`
  )

  const document = {
    $id: FOLDER_ENTITY_KEY,
    $schema: FOLDER_MODEL_NAME,
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
