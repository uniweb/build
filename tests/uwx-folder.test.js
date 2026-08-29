import { buildFolderEntity, collectFolderItemUuids } from '../src/uwx/folder.js'

// The @uniweb/folder entity: one per site sync, a tree of REFERENCES to the record
// entities. A brand-new record is pointed at by `$ref` (its payload-local pool-id
// handle); an already-minted one by the entity_ref open form
// `entry: { model, entity: uuid }`.
// The folder carries NO `$uuid` of its own — the backend owns the site's folder,
// keyed by the site-content uuid, so the framework never holds a folder uuid.
//
// ⭐ THE TREE IS AUTHORED, in `records.yml`, and `folderNodes` is what its resolver
// produced. It used to be DERIVED — one branch per collection — so these tests used
// to pass record entities alone and get a shape back. There is no default now: a
// site with no `records.yml` has no folder, which is the model's `missing ⇒ inert`
// ruling rather than an empty one.

// Minimal record-entity descriptors (the shape buildCollectionEntities emits).
// `id` is the entity's POOL id — `<schema dirs>/<slug>` — which is what a folder
// leaf references.
function rec(dir, slug, uuid = null) {
  return { id: `${dir}/${slug}`, slug, uuid, model: '@acme/x' }
}

// A resolved `records.yml` branch holding the given entities as leaves.
const branch = (segment, ids, label) => ({
  kind: 'branch',
  path_segment: segment,
  ...(label ? { name: label } : {}),
  $children: ids.map((id) => ({ kind: 'ref', $entityId: id })),
})
const leaves = (ids) => ids.map((id) => ({ kind: 'ref', $entityId: id }))

describe('buildFolderEntity', () => {
  it('returns null when the folder declares nothing', () => {
    expect(buildFolderEntity({ recordEntities: [rec('article', 'hello')], folderNodes: [] })).toBeNull()
    expect(buildFolderEntity({ recordEntities: [], folderNodes: [] })).toBeNull()
  })

  it('builds the authored tree, records as leaves ($ref when new)', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello'), rec('articles', 'world'), rec('team', 'ada')],
      folderNodes: [
        branch('articles', ['articles/hello', 'articles/world']),
        branch('team', ['team/ada']),
      ],
    })
    expect(folder.model).toBe('@uniweb/folder')
    expect(folder.document.$id).toBe('@folder')
    expect(folder.document).not.toHaveProperty('$uuid') // the framework holds no folder uuid
    const branches = folder.document.contents
    expect(branches.map((b) => b.path_segment)).toEqual(['articles', 'team'])
    const articles = branches[0]
    expect(articles.kind).toBe('branch')
    expect(articles.$children).toEqual([
      { kind: 'ref', path_segment: 'hello', $ref: 'articles/hello' },
      { kind: 'ref', path_segment: 'world', $ref: 'articles/world' },
    ])
  })

  it('uses entry: uuid for an already-minted record, $ref for a new one', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello', 'uuid-1'), rec('articles', 'world')],
      folderNodes: [branch('articles', ['articles/hello', 'articles/world'])],
    })
    const leaves = folder.document.contents[0].$children
    expect(leaves[0]).toEqual({ kind: 'ref', path_segment: 'hello', entry: { model: '@acme/x', entity: 'uuid-1' } })
    expect(leaves[1]).toEqual({ kind: 'ref', path_segment: 'world', $ref: 'articles/world' })
  })

  it('carries no folder $uuid — the backend owns it (keyed by the site-content uuid)', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello')],
      folderNodes: leaves(['articles/hello']),
    })
    expect(folder.uuid).toBeNull()
    expect(folder.document).not.toHaveProperty('$uuid')
    expect(Object.keys(folder.document)).toEqual(['$id', '$model', 'contents'])
  })

  it('nests branches to any depth, decoupled from the pool layout', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello'), rec('team', 'ada')],
      folderNodes: [
        branch('blog', ['articles/hello'], 'Blog'),
        {
          kind: 'branch',
          path_segment: 'about',
          $children: [branch('people', ['team/ada'])],
        },
      ],
    })
    const [blog, about] = folder.document.contents
    expect(blog.path_segment).toBe('blog')
    expect(blog.name).toBe('Blog')
    expect(blog.$children).toEqual([{ kind: 'ref', path_segment: 'hello', $ref: 'articles/hello' }])
    expect(about.$children[0].kind).toBe('branch')
    expect(about.$children[0].path_segment).toBe('people')
    expect(about.$children[0].$children[0]).toEqual({
      kind: 'ref',
      path_segment: 'ada',
      $ref: 'team/ada',
    })
  })

  // ⛔ A placement whose entity never materialized is DROPPED AND REPORTED, never
  // emitted as a ref pointing at nothing. The backend cannot resolve such a leaf,
  // so the failure would surface there, as somebody else's error.
  it('drops and reports a placement with no record entity', () => {
    const folder = buildFolderEntity({
      recordEntities: [rec('articles', 'hello')],
      folderNodes: leaves(['articles/hello', 'articles/vanished']),
    })
    expect(folder.document.contents).toHaveLength(1)
    expect(folder.warnings).toHaveLength(1)
    expect(folder.warnings[0]).toContain('articles/vanished')
  })
})

// ─── placement identity — the defect that made `publish` after `push` refuse ──
//
// `contents` is a `multi` section: an item without a `$uuid` is a NEW row. So a
// re-send of the folder without identity would replace every placement, and the
// backend refuses outright (`identity_required`).
//
// ⛔ That refusal is exactly what a `publish` after a `push` hit, because
// send-only-changed skips the unchanged RECORDS and re-sends the FOLDER ALONE —
// making the folder the one payload whose item identity has to survive.
// Reproduced on a live manor 2026-08-27; the identities were on the wire all along
// and framework simply never harvested them.
describe('folder placement identity', () => {
  const records = [
    { id: 'members/alice', slug: 'alice', model: '@acme/member', uuid: 'R1' },
    { id: 'members/bob', slug: 'bob', model: '@acme/member', uuid: 'R2' },
  ]
  const membersFolder = [branch('members', ['members/alice', 'members/bob'])]

  it('harvests every level — branches AND the records under $children', () => {
    // ⛔ A walk of the top level alone sees the branch and misses every record
    // under it. Named by the backend lane before it could be got wrong.
    const stored = {
      contents: [
        {
          kind: 'branch',
          path_segment: 'members',
          $uuid: 'B1',
          $children: [
            { kind: 'ref', path_segment: 'alice', $uuid: 'I1' },
            { kind: 'ref', path_segment: 'bob', $uuid: 'I2' },
          ],
        },
      ],
    }
    expect(collectFolderItemUuids(stored)).toEqual({
      members: 'B1',
      'members/alice': 'I1',
      'members/bob': 'I2',
    })
  })

  it('stamps banked identity back onto a folder about to be sent', () => {
    const folder = buildFolderEntity({
      recordEntities: records,
      folderNodes: membersFolder,
      itemUuids: { members: 'B1', 'members/alice': 'I1', 'members/bob': 'I2' },
    })
    const branch = folder.document.contents[0]
    expect(branch.$uuid).toBe('B1')
    expect(branch.$children.map((c) => c.$uuid)).toEqual(['I1', 'I2'])
  })

  it('⛔ CONTROL — a first push carries NO identity, because every item is new', () => {
    // Without this the suite cannot tell "stamps what it was given" from "always
    // stamps something", and a first push must mint rather than address.
    const folder = buildFolderEntity({ recordEntities: records, folderNodes: membersFolder })
    const node = folder.document.contents[0]
    expect(node.$uuid).toBeUndefined()
    expect(node.$children.every((c) => c.$uuid === undefined)).toBe(true)
  })

  it('leaves an unknown placement unstamped rather than guessing', () => {
    const folder = buildFolderEntity({
      recordEntities: records,
      folderNodes: membersFolder,
      itemUuids: { 'members/alice': 'I1' }, // bob absent — genuinely new
    })
    const kids = folder.document.contents[0].$children
    expect(kids[0].$uuid).toBe('I1')
    expect(kids[1].$uuid).toBeUndefined()
  })
})

/**
 * ⛔ MINTING A RECORD MUST NOT MOVE THE FOLDER'S CONTENT HASH.
 *
 * The folder is the one entity whose document depends on OTHER entities' identity
 * state: `refLeaf` writes `$ref: "<collection>/<slug>"` while a record is new and
 * `entry: { model, entity: <uuid> }` once it is minted. Both denote the same
 * record.
 *
 * That made the folder's banked hash unreproducible, because a push does all three
 * of these in one function, in this order:
 *
 *   1. emit + hash          (records new  → `$ref`)
 *   2. submit, back-fill    (writes each record's `$uuid` into its source file)
 *   3. bank the step-1 hash (now describes a document that no longer exists)
 *
 * So `uniweb status` reported the folder changed immediately after a successful
 * push, permanently. Measured on the matinee manor 2026-08-29; stripping the
 * back-filled uuids from the record sources reproduced the banked hash exactly,
 * which is what identified the encoding as the variable rather than the content.
 *
 * ⭐ Records escape this because `$uuid` is already stripped before hashing. This
 * is the same principle reaching the one place it had not: identity is not content.
 * Sibling incident, same class, different injection: `uwx-applied-injections.test.js`.
 *
 * ⚠️ The second and third cases are the point. Excluding the reference could have
 * made the folder blind to real changes; it does not, because a leaf's
 * `path_segment` and its position in the tree still carry which record sits where.
 */
describe('folder hash is identity-independent', () => {
  const hashOf = async (recordEntities) => {
    const { entityContentHash } = await import('../src/uwx/collections.js')
    const nodes = [branch('team', recordEntities.map((r) => r.id))]
    return entityContentHash(buildFolderEntity({ recordEntities, folderNodes: nodes }).document)
  }

  const nu = [rec('team', 'ada'), rec('team', 'grace')]
  const minted = [
    rec('team', 'ada', '01a0-aaaa'),
    rec('team', 'grace', '01a0-bbbb'),
  ]

  it('is unchanged when records are minted ($ref → entry)', async () => {
    expect(await hashOf(minted)).toBe(await hashOf(nu))
  })

  it('still moves when a record is RENAMED', async () => {
    const renamed = [rec('team', 'adalovelace', '01a0-aaaa'), rec('team', 'grace', '01a0-bbbb')]
    expect(await hashOf(renamed)).not.toBe(await hashOf(minted))
  })

  it('still moves when a record is REMOVED', async () => {
    expect(await hashOf([rec('team', 'ada', '01a0-aaaa')])).not.toBe(await hashOf(minted))
  })

  it('still moves when records are REORDERED', async () => {
    expect(await hashOf([minted[1], minted[0]])).not.toBe(await hashOf(minted))
  })
})

/**
 * ⛔ A PROJECTION MUST INVERT THE BUILD'S RESOLUTION, NOT COPY IT.
 *
 * A `fetch:` declaration has three shapes and they accept different keys. The build
 * resolves a `query:` shorthand into a concrete location, so the declaration on
 * the sync wire carries BOTH the authored `collection` and the derived `path`.
 * Writing that back verbatim produces a file that is neither shape cleanly:
 * `collection` wins the classification and the `path` beside it is unrecognized.
 *
 * ⚠️ Measured on matinee 2026-08-29 — `push → pull → push`, where the third step was
 * rejected by our own validator against a file our own projector had just written:
 * "unrecognized key \"path\" … recognized: collection, detailPage, filter, limit,
 * merge, prerender, schema, sort, transform, where."
 *
 * ⭐ `/data/<name>.json` is a materialization of a collection, never its definition,
 * so it is exactly what an authored file should not contain.
 *
 * ⚖️ The last case is the one that keeps this honest: dropping everything
 * unrecognized would make every pull quietly lossy for a key a newer producer wrote.
 * Only derivable keys go.
 */
describe('authorableFetch', () => {
  it('drops the derived location from a resolved collection fetch', async () => {
    const { authorableFetch } = await import('../src/site/fetch-shapes.js')
    expect(
      authorableFetch({ path: '/data/members.json', schema: 'members', query: 'members' })
    ).toEqual({ schema: 'members', query: 'members' })
  })

  it('keeps path on a source-shaped fetch, where it is what the author wrote', async () => {
    const { authorableFetch } = await import('../src/site/fetch-shapes.js')
    const source = { path: '/data/custom.json', schema: 'things' }
    expect(authorableFetch(source)).toEqual(source)
  })

  it('keeps a key it does not recognize, rather than making the pull lossy', async () => {
    const { authorableFetch } = await import('../src/site/fetch-shapes.js')
    expect(authorableFetch({ query: 'members', somethingNewer: 42 })).toEqual({
      query: 'members',
      somethingNewer: 42
    })
  })
})
