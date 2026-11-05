/**
 * What a pull held, and what a push leaves out of it (`src/uwx/held-units.js`): a held unit whose files
 * still say what they said at the pull is not sent; one whose files changed — edited, removed, or with a
 * page or section added below a held page — stops the push, and nothing is left out then.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip, heldUnitsOf } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-held-'))
  w('site.yml', "name: S\nfoundation: '@a/b'\n")
  w('pages/home/page.yml', 'title: Home\n')
  w('pages/home/hero.md', '# Hi\n')
  w('pages/guide/folder.yml', 'title: Guide\n')
  w('pages/guide/install.md', '# Install\n\nRun it.\n')
  w('pages/guide/start.md', '# Start\n\nGo.\n')
  w('pages/docs/page.yml', 'title: Docs\n')
  w('pages/docs/one/page.yml', 'title: One\n')
  w('pages/docs/one/body.md', '# One\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function w(rel, text) {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), text)
}
const ORIGIN = 'https://b.test'
const emit = (opts = {}) => emitSyncPackages(dir, { backend: ORIGIN, sendAll: true, ...opts })
const sentDoc = (pkg) => JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))
const slugs = (list) => (list || []).map((r) => r.slug?.en ?? r.slug)
// What a pull records for held items, found by the identity the copy held.
async function held(uuids, itemUuids) {
  const base = await emit({ unitHashes: true, itemUuids })
  return heldUnitsOf({ hashes: base.unitHashes, uuids: base.unitUuids, held: uuids })
}

describe('what a pull records', () => {
  it('each held item where the files keep it, and every unit below a held page', async () => {
    const units = await held(['U-docs'], { 'pages/docs/page.yml': 'U-docs' })
    expect(Object.keys(units).sort()).toEqual(['pages/docs/one/body.md', 'pages/docs/one/page.yml', 'pages/docs/page.yml'])
  })

  it('nothing for a held item the files do not hold — one the app made', async () => {
    expect(await held(['U-new'], { 'pages/guide/install/page.yml': 'U-install' })).toEqual({})
  })
})

describe('what a push leaves out', () => {
  // ⛔ Until 2026-11-05 the site-content entity sent every version this copy held, a held page's too:
  // after a forced push had banked one, the next push left the page out with its version, a deletion.
  it('⭐ no version for a held page, nor for what is below it: leaving it out keeps it', async () => {
    const itemUuids = {
      'pages/home/page.yml': 'U-home',
      'pages/docs/page.yml': 'U-docs',
      'pages/docs/one/page.yml': 'U-one',
      'pages/docs/one/body.md': 'U-body'
    }
    const units = await held(['U-docs'], itemUuids)
    const pkg = await emit({
      heldUnits: units,
      itemUuids,
      itemBaseVersions: { 'U-home': 'v-home', 'U-docs': 'v-docs', 'U-one': 'v-one', 'U-body': 'v-body' }
    })
    expect(pkg.heldLeftOut).toEqual(['pages/docs/one/body.md', 'pages/docs/one/page.yml', 'pages/docs/page.yml'])
    const manifest = JSON.parse(readZip(pkg.siteContent.buffer).get('manifest.json').toString('utf8'))
    const sent = manifest.entries.find((e) => e.file === 'entities/site-content.json').item_base_versions
    expect(sent).toEqual({ 'U-home': 'v-home' })
  })

  it('CONTROL — with nothing held, every version this copy holds is sent', async () => {
    const pkg = await emit({ itemUuids: { 'pages/home/page.yml': 'U-home' }, itemBaseVersions: { 'U-home': 'v-home', 'U-gone': 'v-gone' } })
    const manifest = JSON.parse(readZip(pkg.siteContent.buffer).get('manifest.json').toString('utf8'))
    expect(manifest.entries.find((e) => e.file === 'entities/site-content.json').item_base_versions).toEqual({ 'U-home': 'v-home', 'U-gone': 'v-gone' })
  })

  it('⭐ a held page whose files say what they said: not sent, and said', async () => {
    const units = await held(['U-install'], { 'pages/guide/install/page.yml': 'U-install' })
    const pkg = await emit({ heldUnits: units })
    expect(pkg.heldChanged).toEqual([])
    expect(pkg.heldLeftOut).toEqual(['pages/guide/install/install.md', 'pages/guide/install/page.yml'])
    expect(slugs(sentDoc(pkg).pages.find((p) => p.$id === 'guide').$children)).toEqual(['start'])
  })

  it('a held page edited since: named, and nothing left out', async () => {
    const units = await held(['U-install'], { 'pages/guide/install/page.yml': 'U-install' })
    w('pages/guide/install.md', '# Install\n\nRun it, now.\n')
    const pkg = await emit({ heldUnits: units })
    expect(pkg.heldChanged).toEqual(['pages/guide/install/install.md'])
    expect(pkg.heldLeftOut).toEqual([])
    expect(slugs(sentDoc(pkg).pages.find((p) => p.$id === 'guide').$children)).toEqual(['install', 'start'])
  })

  it('a held page removed from the files since: named', async () => {
    const units = await held(['U-install'], { 'pages/guide/install/page.yml': 'U-install' })
    rmSync(join(dir, 'pages/guide/install.md'))
    expect((await emit({ heldUnits: units })).heldChanged).toEqual(['pages/guide/install/install.md', 'pages/guide/install/page.yml'])
  })

  it('a page added below a held page since: named, since leaving the page out would take it too', async () => {
    const units = await held(['U-docs'], { 'pages/docs/page.yml': 'U-docs' })
    w('pages/docs/two/page.yml', 'title: Two\n')
    w('pages/docs/two/body.md', '# Two\n')
    expect((await emit({ heldUnits: units })).heldChanged).toEqual(['pages/docs/two/body.md', 'pages/docs/two/page.yml'])
  })

  it('compared on what the files say, before media is rewritten: a served picture is no change', async () => {
    w('pages/docs/one/body.md', '# One\n\n![A picture](/images/a.png)\n')
    w('public/images/a.png', 'png')
    const units = await held(['U-docs'], { 'pages/docs/page.yml': 'U-docs' })
    const assetRewrite = { '/images/a.png': 'https://assets.test/a.png' }
    // CONTROL — the push names the served picture where it sends the page.
    expect(JSON.stringify(sentDoc(await emit({ assetRewrite })))).toContain('https://assets.test/a.png')
    const pkg = await emit({ heldUnits: units, assetRewrite })
    expect(pkg.heldChanged).toEqual([])
    expect(slugs(sentDoc(pkg).pages)).not.toContain('docs')
  })

  it('CONTROL — with no held units, every page is sent', async () => {
    const pkg = await emit()
    expect(pkg.heldLeftOut).toEqual([])
    expect(slugs(sentDoc(pkg).pages.find((p) => p.$id === 'guide').$children)).toEqual(['install', 'start'])
  })
})
