/**
 * A RECORD'S IDENTITY — its own, carried in its file, and mapped per backend.
 *
 * ⭐ The file's `$uuid` is the record's OWN id and travels with it, so moving or
 * renaming the file changes nothing. What a backend calls the record lives in
 * `sync.json::backends.<origin>.records`.
 *
 * ⛔ The case this file exists for is SILENT if it breaks: the back-fill's variant A
 * re-renders a record's WHOLE file from the backend's document — and that document
 * carries THAT backend's `$uuid`. Pushed to a second backend, a record would have its
 * identity quietly replaced by the second backend's, and every later push to the
 * first would send the wrong id. Nothing errors; the author's file just changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillEntityUuids } from '../src/uwx/backfill.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-record-id-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const record = (name, uuid) => {
  const file = join(dir, `${name}.yml`)
  writeFileSync(file, `${uuid ? `$uuid: ${uuid}\n` : ''}title: ${name}\n`)
  return file
}

/** The finalized entry a backend returns, carrying ITS uuid in the document too. */
const finalizedFor = (uuid) => ({
  index: 0,
  uuid,
  changed: true,
  document: { $uuid: uuid, $model: '@acme/thing', card: { title: 'x' } }
})

describe('the back-fill maps a record; it does not rename it', () => {
  it("⭐ a record that already has its own id is NOT rewritten by another backend's uuid", () => {
    const file = record('widget', 'OUR-ID')
    const before = readFileSync(file, 'utf8')

    const bf = backfillEntityUuids({
      index: [{ id: 'widget', model: '@acme/thing', slug: 'widget', sourceFile: file, format: 'yml', ownId: 'OUR-ID' }],
      finalized: [finalizedFor('MINTED-BY-B')]
    })

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(file, 'utf8')).not.toMatch(/MINTED-BY-B/)
    // …and what B calls it is recorded, keyed by the record's own id.
    expect(bf.mapped).toEqual({ 'OUR-ID': 'MINTED-BY-B' })
    expect(bf.updated).toEqual([])
  })

  it('a record new to every backend takes the first minted uuid as its own id', () => {
    // Exactly the behaviour before identity was keyed by backend — so a project that
    // only ever syncs with one backend sees no change at all.
    const file = record('gadget', null)

    const bf = backfillEntityUuids({
      index: [{ id: 'gadget', model: '@acme/thing', slug: 'gadget', sourceFile: file, format: 'yml', ownId: null }],
      finalized: [finalizedFor('FIRST-MINT')]
    })

    expect(readFileSync(file, 'utf8')).toMatch(/FIRST-MINT/)
    expect(bf.mapped).toEqual({ 'FIRST-MINT': 'FIRST-MINT' })
    expect(bf.updated).toEqual([file])
  })

  it('a record with no source file maps nothing — there is no own id to key it by', () => {
    const bf = backfillEntityUuids({
      index: [{ id: 'ghost', model: '@acme/thing', slug: 'ghost', sourceFile: null, ownId: null }],
      finalized: [finalizedFor('ORPHAN')]
    })
    expect(bf.mapped).toEqual({})
    expect(bf.deferred).toHaveLength(1)
  })
})
