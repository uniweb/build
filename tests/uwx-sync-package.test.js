import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitSyncPackages,
  siteProjectToDocument,
  writeSiteEntityUuid,
  readZip,
  computeUnitHashes,
} from '../src/uwx/index.js'

// The two directional sync lanes: site-content (static) and collections (folder +
// records). Each fires independently on "send only changed"; the entity uuids live
// in files (site.yml / collections.yml / record files). Site-content items carry a
// per-item `$uuid` when the caller supplies `itemUuids` — without it the backend
// recreates every row — so the no-identity cases below are the un-stamped path.

let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-sync-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  mkdirSync(SITE, { recursive: true })

  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing@1"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { foundation: 'file:../foundation' } }))
  // pages
  w('pages/1-home/page.yml', ['id: home', 'nest:', '  hero: [detail]', ''].join('\n'))
  w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n')
  w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# More\n')
  w('layout/header.md', '---\ntype: Header\n---\n# H\n')
  // a syncable collection (resolvable @/article schema) + collections.yml
  w('collections/collections.yml', 'collections:\n  articles:\n    schema: "@/article"\n    sort: date desc\n')
  w('collections/articles/hello.md', '---\ntitle: Hello\ndate: 2026-01-01\n---\nBody\n')
  w('collections/articles/world.md', '---\ntitle: World\ndate: 2026-02-01\n---\nBody2\n')
  writeFileSync(
    join(fdn, 'dist', 'meta', 'schema.json'),
    JSON.stringify({
      _self: { name: '@acme/marketing', version: '1', role: 'foundation' },
      dataSchemas: {
        '@/article': {
          name: 'article',
          sections: {
            main: { brief: true, fields: { title: { type: 'string' }, date: { type: 'date' }, body: { type: 'text', format: 'markdown' } } },
          },
        },
      },
    })
  )
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('emitSyncPackages — two directional lanes', () => {
  it('first build: both lanes fire (folder + records, folder first)', async () => {
    const pkg = await emitSyncPackages(SITE)

    // site-content lane: one entity
    expect(pkg.siteContent).toBeTruthy()
    expect(pkg.siteContent.entityCount).toBe(1)
    expect(pkg.siteContent.models).toEqual(['@uniweb/site-content'])
    expect(pkg.siteContent.index).toEqual([{ kind: 'site' }])

    // collections lane: folder + 2 records, folder first (the leading { kind: 'folder' }
    // is a positional placeholder so record back-fill stays aligned)
    expect(pkg.collections).toBeTruthy()
    expect(pkg.collections.entityCount).toBe(3)
    expect(pkg.collections.models).toContain('@uniweb/folder')
    expect(pkg.collections.index[0]).toEqual({ kind: 'folder' })
    expect(pkg.collections.index.slice(1).map((e) => e.id)).toEqual(['articles/hello', 'articles/world'])

    // the folder references both records by $ref (uuid-less first push) and carries no
    // $uuid of its own (the backend owns it, keyed by the site-content uuid)
    const folder = JSON.parse(readZip(pkg.collections.buffer).get('entities/folder.json').toString('utf8'))
    expect(folder.$model).toBe('@uniweb/folder')
    expect(folder).not.toHaveProperty('$uuid')
    const leaves = folder.contents[0].$children
    expect(leaves.map((l) => l.$ref)).toEqual(['articles/hello', 'articles/world'])
  })

  it('the site-content .uwx carries $id but no per-item $uuid', async () => {
    const pkg = await emitSyncPackages(SITE)
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.$model).toBe('@uniweb/site-content')
    expect(body).not.toHaveProperty('$uuid')
    const home = body.pages.find((p) => p.slug?.en === 'home')
    expect(home.$id).toBe('home')
    expect(home).not.toHaveProperty('$uuid')
    expect(home.page_sections[0].$children[0].$id).toBe('detail') // @-nested
  })

  it('send-only-changed: an unchanged second build pushes nothing on either lane', async () => {
    const first = await emitSyncPackages(SITE)
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
    expect(second.collections).toBeNull()
    expect(second.skipped).toBe(4) // site + folder + 2 records
  })

  it('editing a record fires ONLY the collections lane', async () => {
    const first = await emitSyncPackages(SITE)
    w('collections/articles/hello.md', '---\ntitle: Hello edited\ndate: 2026-01-01\n---\nBody\n')
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
    expect(second.collections).toBeTruthy()
    // folder (always, for $ref closure) + the one changed record
    expect(second.collections.index.map((e) => e.kind ?? e.id)).toEqual(['folder', 'articles/hello'])
  })

  it('editing a page fires ONLY the site-content lane', async () => {
    const first = await emitSyncPackages(SITE)
    w('pages/1-home/@detail.md', '---\ntype: Detail\nid: detail\n---\n# Much more\n')
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeTruthy()
    expect(second.collections).toBeNull()
  })

  it('the folder never carries a $uuid, even when collections.yml has one', async () => {
    // A stray collections.yml::$uuid (e.g. left over from an old project) is ignored —
    // the backend owns the folder, keyed by the site-content uuid.
    w('collections/collections.yml', '$uuid: folder-existing\ncollections:\n  articles:\n    schema: "@/article"\n')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.collections).not.toHaveProperty('bind')
    const folder = JSON.parse(readZip(pkg.collections.buffer).get('entities/folder.json').toString('utf8'))
    expect(folder).not.toHaveProperty('$uuid')
  })

  it('a collection that resolves no schema is reported in `schemaless`, WITH the model it looked for', async () => {
    // `notes` declares no schema and the foundation defines none → it resolves via
    // the subfolder-name convention, finds nothing, and soft-skips the sync. It
    // surfaces in `schemaless` so the composite deploy can deliver it via the ball.
    w('collections/collections.yml', 'collections:\n  articles:\n    schema: "@/article"\n  notes: {}\n')
    w('collections/notes/first.md', '---\ntitle: First\n---\nNote body\n')
    const pkg = await emitSyncPackages(SITE)

    // `model` carries the name the convention looked for and did not find. The CLI
    // needs it to tell the author what to declare — a bare name cannot say that,
    // and this entry replaced a prose warning precisely so the message could.
    // ⭐ Note the SINGULARIZATION: collection `notes` looks for model `@/note`.
    // That is exactly why the name has to travel — an author told only "no data
    // schema" would declare `@/notes` and still not resolve.
    expect(pkg.schemaless).toEqual([{ name: 'notes', model: '@/note' }])

    // ⛔ And it is NOT also a prose warning. It used to push
    // `"… — not synced"` into `warnings`, printed dim; that read as "my data did
    // not upload" when the data ships as static files. One signal, reported by
    // the CLI at warn level — see cli/src/utils/schemaless-report.js.
    expect((pkg.warnings || []).join('\n')).not.toMatch(/not synced/i)
    // articles still syncs as entities — the partition routes each collection to one lane
    expect(pkg.collections.index.slice(1).map((e) => e.id)).toEqual(['articles/hello', 'articles/world'])
  })

  it('the folder lane declares referenced Models even when their records are cache-filtered (re-push)', async () => {
    // Articles with embedded $uuid → the folder references them by `entry.model` (minted form).
    w('collections/articles/hello.md', '---\n$uuid: 0192-hello\ntitle: Hello\ndate: 2026-01-01\n---\nBody\n')
    w('collections/articles/world.md', '---\n$uuid: 0192-world\ntitle: World\ndate: 2026-02-01\n---\nBody2\n')

    const first = await emitSyncPackages(SITE)
    const articleModel = first.collections.models.find((m) => m !== '@uniweb/folder')
    expect(articleModel).toBeTruthy()

    // Re-emit with the RECORD hashes cached but the folder's dropped → the folder fires
    // (no prior hash) while the article records are cache-hits (filtered from the package).
    const priorHashes = { ...first.hashes }
    for (const k of Object.keys(priorHashes)) if (k.startsWith('@uniweb/folder ')) delete priorHashes[k]
    const second = await emitSyncPackages(SITE, { priorHashes })

    expect(second.collections).toBeTruthy()
    // the package carries only the folder (records filtered) …
    expect(second.collections.index.filter((e) => e.kind !== 'folder').length).toBe(0)
    // … yet the article Model the folder references is still declared in models_required.
    expect(second.collections.models).toContain(articleModel)
  })
})

describe('site-content entity uuid → site.yml', () => {
  it('writeSiteEntityUuid records the uuid, preserving the file; re-read carries it', async () => {
    writeSiteEntityUuid(SITE, 'u-entity-1')
    const after = readFileSync(join(SITE, 'site.yml'), 'utf8')
    expect(after).toMatch(/^\$uuid: u-entity-1$/m)
    expect(after).toContain('name: Acme')
    const doc = await siteProjectToDocument(SITE)
    expect(doc.$uuid).toBe('u-entity-1')
    expect(doc.pages.find((p) => p.slug?.en === 'home')).not.toHaveProperty('$uuid')
  })

  it('the producer surfaces siteContentUuid for collections binding', async () => {
    writeSiteEntityUuid(SITE, 'u-entity-9')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.siteContentUuid).toBe('u-entity-9')
  })
})

describe('emitSyncPackages — injectInfo (deploy-derived info)', () => {
  it('stamps injectInfo fields (data_bundle) onto the site-content document info', async () => {
    const pkg = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/abc/base.json' } })
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.info.data_bundle).toBe('http://h/asset/dist/abc/base.json')
    // it is part of the hashed content, so changing the bundle URL re-fires the lane
    const same = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/abc/base.json' }, priorHashes: pkg.hashes })
    expect(same.siteContent).toBeNull()
    const changed = await emitSyncPackages(SITE, { injectInfo: { data_bundle: 'http://h/asset/dist/DEF/base.json' }, priorHashes: pkg.hashes })
    expect(changed.siteContent).toBeTruthy()
  })

  it('without injectInfo, the site-content info carries no data_bundle', async () => {
    const pkg = await emitSyncPackages(SITE)
    const body = JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    expect(body.info.data_bundle).toBeUndefined()
  })
})

describe('emitSyncPackages — baseVersions (the push staleness gate)', () => {
  const manifestOf = (buffer) => JSON.parse(readZip(buffer).get('manifest.json').toString('utf8'))

  it('stamps a TOP-LEVEL base_version on a synced entity whose $uuid the map knows', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg = await emitSyncPackages(SITE, { baseVersions: { 'u-site-1': '2026-07-25T21:09:44.120388Z' } })
    const entry = manifestOf(pkg.siteContent.buffer).entries[0]
    expect(entry.base_version).toBe('2026-07-25T21:09:44.120388Z')
    // Nesting it under `extra` is what shipped first and it disarmed the gate
    // silently — the backend's `extra` is #[serde(flatten)] and never on the wire.
    expect(entry.extra).toBeUndefined()
  })

  it('leaves entries[].uuid as the $id handle — the backend correlates via the body', async () => {
    // Writing a real uuid here looks helpful and is wrong: the field would mean
    // two different things by sync state, and the gate reads the body's $uuid.
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg = await emitSyncPackages(SITE, { baseVersions: { 'u-site-1': 'V1' } })
    const z = readZip(pkg.siteContent.buffer)
    const entry = manifestOf(pkg.siteContent.buffer).entries[0]
    expect(entry.uuid).toBe('site-content')
    expect(JSON.parse(z.get(entry.file).toString('utf8')).$uuid).toBe('u-site-1')
  })

  it('omits base_version with no map — the unconditional (force) path', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg = await emitSyncPackages(SITE)
    expect(manifestOf(pkg.siteContent.buffer).entries[0].base_version).toBeUndefined()
  })

  it('omits it for a never-synced entity — no $uuid means no state to be stale against', async () => {
    const pkg = await emitSyncPackages(SITE, { baseVersions: { 'u-site-1': 'V1' } })
    expect(manifestOf(pkg.siteContent.buffer).entries[0].base_version).toBeUndefined()
  })

  it('does not perturb the entity body or its content hash — the token is manifest-only', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const plain = await emitSyncPackages(SITE)
    const gated = await emitSyncPackages(SITE, { baseVersions: { 'u-site-1': 'V1' } })
    expect(readZip(gated.siteContent.buffer).get('entities/site-content.json').toString('utf8')).toBe(
      readZip(plain.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    )
    // A changing base_version must never re-fire send-only-changed.
    expect(gated.hashes).toEqual(plain.hashes)
  })

  it('keeps package_sha256 self-consistent when the token is present', async () => {
    // The consumer verifies by blanking package_sha256 over OUR bytes, so the extra
    // field must be inside the hashed preimage — not appended after hashing.
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg = await emitSyncPackages(SITE, { baseVersions: { 'u-site-1': 'V1' } })
    const withToken = manifestOf(pkg.siteContent.buffer)
    const plain = manifestOf((await emitSyncPackages(SITE)).siteContent.buffer)
    expect(withToken.package_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(withToken.package_sha256).not.toBe(plain.package_sha256)
  })
})

describe('emitSyncPackages — local-media (Slice 5)', () => {
  it('collects site-root local asset refs in localAssets; co-located refs warn + skip', async () => {
    w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![banner](/images/banner.png)\n\n![local](./co.png)\n')
    const pkg = await emitSyncPackages(SITE)
    expect(pkg.localAssets).toContain('/images/banner.png')
    expect(pkg.localAssets).not.toContain('./co.png')
    expect(pkg.warnings.some((m) => m.includes('co.png') && m.includes('co-located'))).toBe(true)
  })

  it('assetRewrite swaps the entity content refs for serve URLs (opt-in)', async () => {
    w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![banner](/images/banner.png)\n')
    const serve = 'https://cdn.example/dist/abc123/base.png'
    const pkg = await emitSyncPackages(SITE, { assetRewrite: { '/images/banner.png': serve } })
    const json = readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    expect(json).toContain(serve)
    expect(json).not.toContain('/images/banner.png')
  })

  it('without assetRewrite the entity keeps the raw ref (the f225 path is unchanged)', async () => {
    w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![banner](/images/banner.png)\n')
    const pkg = await emitSyncPackages(SITE)
    const json = readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    expect(json).toContain('/images/banner.png')
  })

  it('a ref the assetRewrite map omits is left untouched (no broken URL)', async () => {
    w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![a](/images/a.png)\n\n![b](/images/b.png)\n')
    const pkg = await emitSyncPackages(SITE, { assetRewrite: { '/images/a.png': 'https://cdn/x/base.png' } })
    const json = readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    expect(json).toContain('https://cdn/x/base.png') // mapped → rewritten
    expect(json).toContain('/images/b.png') // unmapped → preserved
  })
})

describe('emitSyncPackages — per-item preconditions (item_base_versions)', () => {
  const manifestOf = (buffer) => JSON.parse(readZip(buffer).get('manifest.json').toString('utf8'))

  it('sends only the tokens for records THIS package carries', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    // Identity first — tokens are keyed by record uuid, so they can only be sent
    // for records whose uuid we know.
    const pkg0 = await emitSyncPackages(SITE, { itemUuids: {} })
    const uuids = {}
    for (const p of Object.keys(computeUnitHashes(JSON.parse(readZip(pkg0.siteContent.buffer).get('entities/site-content.json').toString('utf8'))))) {
      uuids[p] = `u-${p.replace(/[^a-z0-9]/gi, '-')}`
    }
    const tokens = Object.fromEntries(Object.values(uuids).map((u) => [u, `v-${u}`]))
    tokens['u-not-in-this-package'] = 'v-stale'

    const pkg = await emitSyncPackages(SITE, { itemUuids: uuids, itemBaseVersions: tokens })
    const sent = manifestOf(pkg.siteContent.buffer).entries[0].item_base_versions
    expect(Object.keys(sent).length).toBe(Object.keys(uuids).length)
    expect(sent['u-not-in-this-package']).toBeUndefined()
  })

  it('omits the field entirely with no tokens — unconditional, the force path', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg = await emitSyncPackages(SITE, { itemUuids: {} })
    expect(manifestOf(pkg.siteContent.buffer).entries[0].item_base_versions).toBeUndefined()
  })

  it('rides TOP-LEVEL on the entry, beside base_version — not under `extra`', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const pkg0 = await emitSyncPackages(SITE, { itemUuids: {} })
    const doc = JSON.parse(readZip(pkg0.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    const uuids = Object.fromEntries(Object.keys(computeUnitHashes(doc)).map((p, i) => [p, `u-${i}`]))
    const pkg = await emitSyncPackages(SITE, {
      itemUuids: uuids,
      itemBaseVersions: Object.fromEntries(Object.values(uuids).map((u) => [u, 'v'])),
      baseVersions: { 'u-site-1': 'V-entity' },
    })
    const entry = manifestOf(pkg.siteContent.buffer).entries[0]
    expect(entry.base_version).toBe('V-entity')
    expect(entry.item_base_versions).toBeTruthy()
    expect(entry.extra).toBeUndefined()
  })

  it('does not perturb the content hash — adopting tokens must not re-push a site', async () => {
    writeSiteEntityUuid(SITE, 'u-site-1')
    const plain = await emitSyncPackages(SITE, { itemUuids: {} })
    const doc = JSON.parse(readZip(plain.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
    const uuids = Object.fromEntries(Object.keys(computeUnitHashes(doc)).map((p, i) => [p, `u-${i}`]))
    const gated = await emitSyncPackages(SITE, {
      itemUuids: uuids,
      itemBaseVersions: Object.fromEntries(Object.values(uuids).map((u) => [u, 'v'])),
    })
    expect(gated.hashes).toEqual(plain.hashes)
  })
})

describe('asset identity rides BESIDE the URL', () => {
  // The interim's whole safety property. The id is what survives — a URL is a
  // host's route layout frozen into content that outlives it. The URL is what
  // RENDERS today — no deployment emits config.assets.url yet, so a resolver
  // handed an id alone would resolve nothing. Writing both means content
  // authored now stays correct whichever order the halves arrive in.
  const REF = '/images/hero.png'
  const SERVE = '/gateway/asset/dist/9f2c/base.png'

  const emit = async () =>
    emitSyncPackages(SITE, {
      assetRewrite: { [REF]: SERVE },
      assetIds: { [REF]: { id: '9f2c', ext: 'png' } }
    })

  const siteDocOf = (pkg) =>
    JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

  const findWith = (node, pred, hits = []) => {
    if (Array.isArray(node)) node.forEach((n) => findWith(n, pred, hits))
    else if (node && typeof node === 'object') {
      if (pred(node)) hits.push(node)
      Object.values(node).forEach((v) => findWith(v, pred, hits))
    }
    return hits
  }

  beforeEach(() => {
    // An image node carrying the local ref, and a section background carrying
    // the same one — the two shapes framework resolves.
    w('pages/1-home/1-hero.md',
      '---\ntype: Hero\nid: hero\nbackground:\n  image:\n    src: ' + REF +
      '\n---\n# Hi\n\n![Hero](' + REF + ')\n')
  })

  it('stamps assetId/assetExt AND keeps the resolved URL', async () => {
    const doc = siteDocOf(await emit())
    const stamped = findWith(doc, (n) => n.assetId === '9f2c')
    expect(stamped.length).toBeGreaterThan(0)
    for (const n of stamped) {
      expect(n.assetExt).toBe('png')
      // the URL is still there — this is what renders until a host declares a template
      expect(n.src ?? n.url).toBe(SERVE)
    }
  })

  it('reaches a section background as well as an image node', async () => {
    const doc = siteDocOf(await emit())
    const raw = JSON.stringify(doc)
    // both shapes carry identity; neither lost its URL
    expect(raw).toContain('"assetId":"9f2c"')
    expect(raw).toContain(SERVE)
    expect(raw).not.toContain(REF) // the local ref itself is fully rewritten
  })

  it('CONTROL: without assetIds nothing is stamped, and the URL rewrite still happens', async () => {
    const pkg = await emitSyncPackages(SITE, { assetRewrite: { [REF]: SERVE } })
    const raw = JSON.stringify(siteDocOf(pkg))
    expect(raw).not.toContain('assetId')
    expect(raw).toContain(SERVE)
  })
})

describe('an assetId already on the node survives push untouched', () => {
  // The no-download case. A project that declines downloads records a plain URL
  // rather than a local path — so on push-back there is no local ref, nothing to
  // hash, no dedup hit and no id to RECOVER.
  //
  // ⭐ Nothing needs recovering, because the id never left. `pull` writes the id
  // beside the URL exactly as `push` does, so the durable half is already on the
  // node and the rewrite — which only touches strings matching a local ref —
  // walks straight past it.
  //
  // ⇒ The invariant this pins: `assetId` is never dropped by a transform, in
  // either direction or either mode. The URL is the volatile half; the id is the
  // durable half; they travel together. Durability does NOT depend on the
  // committed map (that is for restoring authored PATHS) — it depends on this.
  beforeEach(() => {
    w('pages/1-home/1-hero.md',
      '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Hero](https://cdn.example/dist/9f2c/base.png)\n')
  })

  it('a remote URL with identity keeps its identity through a push', async () => {
    // Simulate what a no-download pull leaves behind: a plain URL, plus identity.
    const pkg = await emitSyncPackages(SITE, {
      assetRewrite: { '/images/other.png': '/served/other.png' },
      assetIds: { '/images/other.png': { id: 'OTHER', ext: 'png' } }
    })
    const doc = JSON.parse(
      readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    )
    const raw = JSON.stringify(doc)
    // The unrelated rewrite did not disturb the remote URL…
    expect(raw).toContain('https://cdn.example/dist/9f2c/base.png')
    // …and stamping is keyed on local refs, so it neither adds nor removes
    // identity on a node the map does not cover.
    expect(raw).not.toContain('"assetId":"OTHER"')
  })
})

describe('push stamps every asset slot, not just the primary', () => {
  it('⭐ stamps a poster through its own identity attrs', async () => {
    w('pages/1-home/1-hero.md',
      '---\ntype: Hero\nid: hero\n---\n# Hi\n\n![Clip](/video/clip.mp4){role=video poster=/images/poster.png}\n')
    const pkg = await emitSyncPackages(SITE, {
      assetRewrite: {
        '/video/clip.mp4': '/served/clip.mp4',
        '/images/poster.png': '/served/poster.png'
      },
      assetIds: {
        '/video/clip.mp4': { id: 'VID', ext: 'mp4' },
        '/images/poster.png': { id: 'POS', ext: 'png' }
      }
    })
    const raw = readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8')
    expect(raw).toContain('"assetId":"VID"')
    expect(raw).toContain('"posterAssetId":"POS"')
    expect(raw).toContain('"posterAssetExt":"png"')
    // both URLs still there — identity rides beside, never instead
    expect(raw).toContain('/served/clip.mp4')
    expect(raw).toContain('/served/poster.png')
  })
})
