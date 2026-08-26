/**
 * Send-only-changed: a THEME-ONLY edit must still send the site-content entity.
 *
 * The defect this guards was filed 2026-07-28 (platform, reproducible case): an author
 * edits only `theme.yml`, publishes, the publish reports `site-content: 1 changed`, and
 * the live site does not change. Nothing errors on any lane, so from the author's seat
 * it is indistinguishable from a caching problem. The hypothesis attached to it was
 * *"theme updates propagate only when page content also changed"* — which, if true at
 * the producer, would mean this lane silently skipped the entity.
 *
 * It is testable here without a backend because the producer half is self-contained:
 * `entityContentHash` hashes the WHOLE document and `info.theme` is part of it
 * (`uwx/site.js`), so a theme-only edit must perturb the hash and re-fire the lane.
 *
 * ⭐ The no-op case is a CONTROL, not a bonus. "The lane fired" proves nothing unless
 * the gate can be shown to skip at all — an always-fire gate would pass the first
 * assertion for the wrong reason.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'

let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const themeYml = (accent) =>
  ['colors:', `  accent: "${accent}"`, '  primary: "#101010"', ''].join('\n')

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-theme-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  mkdirSync(SITE, { recursive: true })

  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing@1"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } }))
  w('theme.yml', themeYml('#ff0000'))
  w('pages/1-home/page.yml', ['id: home', ''].join('\n'))
  w('pages/1-home/1-hero.md', '---\ntype: Hero\nid: hero\n---\n# Hi\n')

  writeFileSync(
    join(fdn, 'dist', 'meta', 'schema.json'),
    JSON.stringify({ _self: { name: '@acme/marketing', version: '1', role: 'foundation' } })
  )
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

const siteDocOf = (pkg) =>
  JSON.parse(readZip(pkg.siteContent.buffer).get('entities/site-content.json').toString('utf8'))

describe('send-only-changed — theme-only edits', () => {
  it('carries theme.yml into info.theme at all', async () => {
    const pkg = await emitSyncPackages(SITE)
    const doc = siteDocOf(pkg)
    expect(doc.info.theme).toBeTruthy()
    expect(doc.info.theme.colors.accent).toBe('#ff0000')
  })

  it('CONTROL: an unchanged site skips the site-content lane', async () => {
    // Without this, "the lane fired" below could just mean the gate never skips.
    const first = await emitSyncPackages(SITE)
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
    expect(second.skipped).toBeGreaterThan(0)
  })

  it('a theme-only edit re-fires the site-content lane, with the new value', async () => {
    const first = await emitSyncPackages(SITE)
    expect(first.siteContent).toBeTruthy()

    // The ONLY change. No page, no section, no site.yml.
    w('theme.yml', themeYml('#00ff00'))

    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeTruthy() // not skipped
    expect(siteDocOf(second).info.theme.colors.accent).toBe('#00ff00')
  })

  it('the hash itself moves on a theme-only edit', async () => {
    // The mechanism behind the case above, asserted directly: whatever else changes
    // about the emit, the send-only-changed key for the site entity must differ.
    const first = await emitSyncPackages(SITE)
    w('theme.yml', themeYml('#0000ff'))
    const second = await emitSyncPackages(SITE)

    const siteKey = (h) => Object.keys(h).find((k) => k.startsWith('@uniweb/site-content'))
    const k = siteKey(first.hashes)
    expect(k).toBeTruthy()
    expect(second.hashes[k]).toBeTruthy()
    expect(second.hashes[k]).not.toBe(first.hashes[k])
  })
})
