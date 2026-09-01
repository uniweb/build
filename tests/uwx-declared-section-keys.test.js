/**
 * Every file-authoritative section key is emitted, empty included.
 *
 * ⭐ THIS IS A CROSS-LANE INVARIANT, not a style preference. The backend's sync
 * door runs DECLARED-SECTION SCOPING (site-services-file-contract.md §9.1): host-side
 * deletion is confined to the sections a document's top-level keys DECLARE, so
 *
 *     an ABSENT key  →  "I am not telling you about this"  →  stored rows preserved
 *     an EMPTY key   →  an explicit clear                  →  stored rows deleted
 *
 * That is what makes framework's `$services` / `$secrets` design safe: those two are
 * emitted only when the file declares them, so a never-pulled project's push cannot
 * wipe a service the operator configured in the app.
 *
 * ⛔ THE SAME RULE INVERTS FOR EVERY OTHER SECTION. `extensions`, `queries` and the
 * folder's `contents` ARE file-authoritative — the file is the whole truth — so
 * "the author deleted the last one" must reach the backend as an empty key, not as
 * silence. Drop the key and the clear stops propagating: the deleted extension stays
 * live on the site, and nothing reports it.
 *
 * Backend asked framework to confirm this (§9.1, "tell us which"). The answer is
 * "we always emit managed keys, even empty" — and this file is what keeps that true,
 * because it is now load-bearing on their side and was previously accidental.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument } from '../src/uwx/site.js'

describe('the sync document always declares its file-authoritative sections', () => {
  let siteRoot

  afterEach(async () => {
    if (siteRoot) await rm(siteRoot, { recursive: true, force: true })
    siteRoot = undefined
  })

  async function bareSite() {
    siteRoot = await mkdtemp(join(tmpdir(), 'uniweb-declared-keys-'))
    await mkdir(join(siteRoot, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteRoot, 'site.yml'), "name: S\nfoundation: '@a/base'\n")
    await writeFile(join(siteRoot, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteRoot
  }

  it('emits extensions and queries as empty lists when the site declares none', async () => {
    // The site whose LAST extension was deleted produces exactly this document. If
    // the key were dropped, that deletion would never reach the backend.
    const doc = await siteProjectToDocument(await bareSite())

    expect(doc.extensions).toEqual([])
    expect(doc.queries).toEqual([])
    expect('extensions' in doc).toBe(true)
    expect('queries' in doc).toBe(true)
  })

  it('always declares info, pages and layout_sections', async () => {
    const doc = await siteProjectToDocument(await bareSite())

    for (const key of ['info', 'pages', 'layout_sections']) {
      expect(doc[key]).toBeDefined()
    }
  })

  it('omits ONLY services and secrets — the two absence-means-preserve sections', async () => {
    const doc = await siteProjectToDocument(await bareSite())

    // The whole invariant in one assertion: whatever keys this document grows, a
    // missing one must be a deliberate member of this list. A new conditional key
    // added without thought fails here rather than silently disabling a clear.
    const OMITTABLE = new Set(['services', 'secrets', '$uuid'])
    const declared = new Set(Object.keys(doc))
    const missing = ['info', 'pages', 'layout_sections', 'extensions', 'queries'].filter(
      (k) => !declared.has(k)
    )
    expect(missing).toEqual([])
    for (const key of OMITTABLE) expect(declared.has(key)).toBe(false)
  })
})
