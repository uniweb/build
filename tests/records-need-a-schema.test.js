/**
 * ⭐ EVERY RECORD HAS A DATA SCHEMA [Diego, 2026-11-11] — what a build can check of it.
 *
 * A build reads a site's data schemas from its foundation's source (`resolveRecordSchemas`), so it
 * can tell a folder's `@/name` is defined nowhere only when the foundation is local: its own
 * `schemas/`, and its scope's other packages (`@acme/name`), as a push qualifies the name. What it
 * cannot read — a foundation that is not local, a schema of another scope — it leaves to the push,
 * which asks the backend (`uwx/records.js`).
 *
 * ⛔ Until 2026-11-11 a folder with no data schema was "schema-less": compiled as files, which a
 * publish uploaded in one language, and which the app could not edit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRecordSchemas } from '../src/site/queries-config.js'
import { readEntityPool } from '../src/site/entity-pool.js'
import { processQueries } from '../src/site/query-processor.js'
import { emitSyncPackages } from '../src/uwx/index.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const MEMBER = 'name: member\nfields:\n  name: { type: string }\n'

/** A workspace: `press` is the site's foundation (`@acme/press`); `hub` another of its scope. */
function workspace({ pressSchemas = {}, hubSchemas = {} } = {}) {
  w('pnpm-workspace.yaml', 'packages:\n  - hub\n  - press\n  - site\n')
  for (const [dir, name, schemas] of [['hub', '@acme/hub', hubSchemas], ['press', '@acme/press', pressSchemas]]) {
    w(`${dir}/package.json`, { name: dir, type: 'module', main: './_entry.generated.js' })
    w(`${dir}/main.js`, `export default { name: '${name}' }\n`)
    for (const [file, body] of Object.entries(schemas)) w(`${dir}/schemas/${file}`, body)
  }
  w('site/package.json', { name: 'site', dependencies: { press: 'file:../press' } })
  w('site/site.yml', 'name: T\nfoundation: press\n')
  return join(ROOT, 'site')
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'records-need-a-schema-'))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('resolveRecordSchemas — what a build can find missing', () => {
  it('⭐ a `@/name` the local foundation defines nowhere is missing', async () => {
    const site = workspace()
    const { schemas, failures, missing } = await resolveRecordSchemas(site, ['@/notes'])
    expect(missing).toEqual(['@/notes'])
    expect(failures).toEqual([])
    expect(schemas).toEqual({})
  })

  it('CONTROL — one its own schemas/ defines resolves', async () => {
    const site = workspace({ pressSchemas: { 'member.yml': MEMBER } })
    const { schemas, missing } = await resolveRecordSchemas(site, ['@/member'])
    expect(missing).toEqual([])
    expect(Object.keys(schemas)).toContain('@/member')
  })

  it('CONTROL — one another package of its scope defines is not missing, as a push names it `@acme/member`', async () => {
    const site = workspace({ hubSchemas: { 'member.yml': MEMBER } })
    const { missing } = await resolveRecordSchemas(site, ['@/member'])
    expect(missing).toEqual([])
  })

  it('CONTROL — with no local foundation nothing can be checked, so nothing is missing', async () => {
    workspace()
    w('site/site.yml', "name: T\nfoundation: '@acme/press@1.0.0'\n")
    const { missing } = await resolveRecordSchemas(join(ROOT, 'site'), ['@/notes'])
    expect(missing).toEqual([])
  })

  it('CONTROL — a schema of another scope that is not on disk is never missing: it may be registered', async () => {
    const site = workspace()
    const { schemas, missing, failures } = await resolveRecordSchemas(site, ['@other/note'])
    expect(missing).toEqual([])
    expect(failures).toEqual([])
    expect(schemas).toEqual({})
  })
})

describe('a companion schema is retired', () => {
  it('⛔ `records/<query>.schema.js` is read by nothing, and the walk says so, naming what to write', async () => {
    const site = workspace()
    w('site/records/note/hi.md', '---\ntitle: Hi\n---\n')
    w('site/records/notes.schema.js', 'export default { fields: { title: { type: "string" } } }\n')
    const pool = await readEntityPool(site)
    expect(pool.errors).toEqual([expect.stringMatching(/records\/notes\.schema\.js is not read: a companion schema is retired.*schemas\//)])
    expect(pool.entities.map((e) => e.relPath)).toEqual(['records/note/hi.md'])
  })
})

describe('a refusal names the standard type a folder\'s name points to', () => {
  it('⭐ the build: `records/testimonials/` with no schema of its own points to @std/testimonial', async () => {
    const site = workspace()
    w('site/records/testimonials/ada.md', '---\nname: Ada\nquote: Hi\n---\n')
    w('site/queries.yml', 'testimonials: {}\n')
    const log = console.log
    console.log = () => {}
    try {
      await expect(processQueries(site, { testimonials: { schema: '@/testimonials' } }, undefined, '/')).rejects.toThrow(
        /records\/testimonials\/ — @\/testimonials, read by query "testimonials" — a standard type fits: @std\/testimonial, kept in records\/std\/testimonial\//
      )
    } finally {
      console.log = log
    }
  })

  it('…and the push says the same', async () => {
    const site = workspace()
    w('site/records/testimonials/ada.md', '---\nname: Ada\nquote: Hi\n---\n')
    w('site/queries.yml', 'testimonials: {}\n')
    w('site/pages/home/page.yml', 'title: Home\n')
    w('press/dist/meta/schema.json', { _self: { name: '@acme/press', version: '1.0.0', role: 'foundation' }, dataSchemas: {} })
    const pkg = await emitSyncPackages(site)
    expect(pkg.refusals).toEqual([expect.stringMatching(/A standard type fits its name: @std\/testimonial, kept in records\/std\/testimonial\//)])
  })

  it('CONTROL — a name no standard type has gets the general advice alone', async () => {
    const site = workspace()
    w('site/records/notes/hi.md', '---\ntitle: Hi\n---\n')
    const log = console.log
    console.log = () => {}
    try {
      await expect(processQueries(site, { notes: { schema: '@/notes' } }, undefined, '/')).rejects.toThrow(/records\/notes\/ — @\/notes, read by query "notes"\n/)
    } finally {
      console.log = log
    }
  })
})
