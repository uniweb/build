/**
 * Send-only-changed: a RE-WRAPPED paragraph is no change, so a push sends nothing.
 *
 * Measured 2026-10-16 on a published CLI: a section's paragraph re-wrapped — one plain newline put
 * between two words, no word changed — was pushed as `site-content: 1 changed`, and an author typing
 * in that section in the app had their typing refused. A plain newline inside a paragraph reads as
 * a space (ruled 2026-10-16; `@uniweb/content-reader`), so the document a re-wrap produces is the
 * one the push already sent.
 *
 * ⭐ The word change is a CONTROL: "nothing to send" proves nothing unless the gate can be shown to
 * fire on this same section.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages } from '../src/uwx/index.js'

let ROOT, SITE
function w(rel, body) {
  const p = join(SITE, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

const cta = (body) => `---\ntype: Hero\nid: cta\n---\n# Ready?\n\n${body}\n`

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uwx-rewrap-'))
  SITE = join(ROOT, 'site')
  const fdn = join(ROOT, 'foundation')
  mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
  mkdirSync(SITE, { recursive: true })

  w('site.yml', ['name: Acme', 'foundation: "@acme/marketing@1"', 'index: home', ''].join('\n'))
  w('package.json', JSON.stringify({ name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } }))
  w('pages/home/page.yml', ['id: home', ''].join('\n'))
  w('pages/home/cta.md', cta('Start your project today and ship it by Friday.'))

  writeFileSync(
    join(fdn, 'dist', 'meta', 'schema.json'),
    JSON.stringify({ _self: { name: '@acme/marketing', version: '1', role: 'foundation' } })
  )
})
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

describe('send-only-changed — a re-wrapped paragraph', () => {
  it.each([
    ['one newline between two words', 'Start your project today\nand ship it by Friday.'],
    ['a space kept before the newline', 'Start your project today \nand ship it by Friday.'],
    ['an indented continuation, wrapped twice', 'Start your\n  project today and\n  ship it by Friday.'],
  ])('⭐ sends nothing (%s)', async (_label, rewrapped) => {
    const first = await emitSyncPackages(SITE)
    expect(first.siteContent).toBeTruthy()

    w('pages/home/cta.md', cta(rewrapped))
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeNull()
  })

  it('CONTROL — a changed word in the same section is sent', async () => {
    const first = await emitSyncPackages(SITE)
    w('pages/home/cta.md', cta('Start your project today\nand ship it by Monday.'))
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeTruthy()
  })

  it('CONTROL — a line break written on purpose is sent', async () => {
    const first = await emitSyncPackages(SITE)
    w('pages/home/cta.md', cta('Start your project today\\\nand ship it by Friday.'))
    const second = await emitSyncPackages(SITE, { priorHashes: first.hashes })
    expect(second.siteContent).toBeTruthy()
  })
})
