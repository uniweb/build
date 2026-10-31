/**
 * ⭐ TWO SECTIONS OF ONE PAGE WITH ONE ID ARE REFUSED BEFORE ANYTHING IS SENT.
 *
 * A section is named by its file without the number, so `1-hero.md` beside `hero.md` are one id.
 * Measured 2026-10-31 on a local backend: the store held both, a pull deleted one of the files, and
 * from then on a push was refused as stale while a pull said there was nothing new.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitSyncPackages } from '../src/uwx/index.js'

describe('two sections of one page with one id', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'same-id-'))
    mkdirSync(join(dir, 'pages/home'), { recursive: true })
    writeFileSync(join(dir, 'site.yml'), "name: S\nfoundation: '@a/base@1.0.0'\n")
    writeFileSync(join(dir, 'pages/home/page.yml'), 'title: Home\n')
    writeFileSync(join(dir, 'pages/home/1-hero.md'), '---\ntype: Hero\n---\n\n# Welcome\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const emit = (opts = {}) => emitSyncPackages(dir, { resolveModel: async () => null, sendAll: true, ...opts })

  it('is refused, on a first push too, and says which', async () => {
    writeFileSync(join(dir, 'pages/home/hero.md'), '---\ntype: Section\n---\n\nOne more line.\n')
    const first = await emit()
    expect(first.refusals.join('\n')).toMatch(/pages\/home\/hero\.md: two sections of this page have the id `hero`/)
    const later = await emit({ itemUuids: { 'pages/home/hero.md': 'U-1' } })
    expect(later.refusals).toHaveLength(first.refusals.length)
  })

  it('CONTROL — the file alone, or with another name, is sent', async () => {
    expect((await emit()).refusals).toEqual([])
    writeFileSync(join(dir, 'pages/home/2-more.md'), '---\ntype: Section\n---\n\nOne more line.\n')
    expect((await emit()).refusals).toEqual([])
  })
})
