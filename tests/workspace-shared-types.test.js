/**
 * ⭐ A type another package of the workspace defines is read with nothing configured.
 *
 * Foundations developed together share a data schema by its full name, `@acme/member`, and a local
 * build reads it from the foundation whose name gives the `@acme` scope and whose own `schemas/`
 * defines it — no `schemas.config.js`, no package to install, nothing registered. Sharing a type never
 * needs a backend [Diego, 2026-11-08: "it should be easy and good DX to share schemas"].
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSchemaRef, buildDataSchemaMap, SCHEMA_NOT_FOUND } from '../src/resolve-data-schema.js'
import { workspaceTypeFiles } from '../src/foundation/shared-types.js'

let ROOT
const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const foundation = (dir, name, schemas = {}) => {
  w(`${dir}/package.json`, { name: dir.replace(/\//g, '-'), main: './_entry.generated.js' })
  w(`${dir}/main.js`, `export default { name: '${name}' }\n`)
  for (const [file, body] of Object.entries(schemas)) w(`${dir}/schemas/${file}`, body)
  return join(ROOT, dir)
}
const MEMBER = 'name: member\nfields:\n  name: { type: string }\n'
const OTHER_MEMBER = 'name: member\nfields:\n  email: { type: email }\n'

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'workspace-types-'))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('a type another foundation of the workspace defines', () => {
  it('⭐ resolves by its full name, with no schemas.config.js', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - hub\n  - press\n')
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const press = foundation('press', '@acme/press')
    const schema = await resolveSchemaRef('@acme/member', { srcDir: press, aliases: {} })
    expect(schema.name).toBe('member')
    expect(Object.keys(schema.fields)).toEqual(['name'])
    // …and through the entry every caller uses
    const map = await buildDataSchemaMap(['@acme/member'], { srcDir: press })
    expect(Object.keys(map['@acme/member'].fields)).toEqual(['name'])
  })

  it('reads the package list as pnpm does: a copy kept outside it is never read', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - hub\n  - press\n')
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    foundation('backup/hub', '@acme/hub', { 'member.yml': OTHER_MEMBER })
    const press = foundation('press', '@acme/press')
    expect(await workspaceTypeFiles('@acme/member', press)).toEqual([join(ROOT, 'hub/schemas/member.yml')])
  })

  it('two packages defining it are refused, naming both', async () => {
    w('pnpm-workspace.yaml', "packages:\n  - '*'\n")
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    foundation('crm', '@acme/crm', { 'member.yml': OTHER_MEMBER })
    const press = foundation('press', '@acme/press')
    await expect(resolveSchemaRef('@acme/member', { srcDir: press, aliases: {} })).rejects.toThrow(
      /defined by 2 packages this foundation reads: .*crm.*hub|defined by 2 packages this foundation reads: .*hub.*crm/
    )
  })

  it('a route schemas.config.js gives wins over the workspace', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - hub\n  - press\n')
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const press = foundation('press', '@acme/press')
    w('elsewhere/member.yml', OTHER_MEMBER)
    const schema = await resolveSchemaRef('@acme/member', {
      srcDir: press,
      aliases: { '@acme/member': join(ROOT, 'elsewhere/member.yml') },
    })
    expect(Object.keys(schema.fields)).toEqual(['email'])
  })

  it('a foundation whose name gives no scope is not found by one, and the message says what to do', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - hub\n  - press\n')
    foundation('hub', 'hub', { 'member.yml': MEMBER })
    const press = foundation('press', '@acme/press')
    const error = await resolveSchemaRef('@acme/member', { srcDir: press, aliases: {} }).catch((e) => e)
    expect(error.code).toBe(SCHEMA_NOT_FOUND)
    expect(error.message).toMatch(/no package of its workspace, and no library it bundles, whose name gives the scope '@acme' defines 'member'/)
    expect(error.message).toMatch(/"uniweb": \{ "scope": "@acme" \}/)
    expect(error.message).toMatch(/schemas\.config\.js/)
  })

  it('CONTROL — outside a workspace there is nothing to share, and its own type still resolves', async () => {
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const press = foundation('press', '@acme/press')
    expect(await workspaceTypeFiles('@acme/member', press)).toEqual([])
    const own = await resolveSchemaRef('@/member', { srcDir: join(ROOT, 'hub'), aliases: {} })
    expect(own.name).toBe('member')
  })

  it('CONTROL — a folder that is none of the workspace\'s packages shares nothing', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - hub\n')
    foundation('hub', '@acme/hub', { 'member.yml': MEMBER })
    const loose = foundation('loose', '@acme/loose')
    expect(await workspaceTypeFiles('@acme/member', loose)).toEqual([])
  })
})

/**
 * ⭐ A library the foundation bundles serves its scope wherever it is: a local package it depends
 * on, giving its scope in its package.json (`uniweb.scope`), with the types in its `schemas/`.
 * ⛔ Until 2026-11-09 one outside the workspace served nothing, and the first build stopped: "Data
 * schema '@acme/plan' is defined nowhere this foundation can read" (measured, a library beside the
 * workspace linked with `file:`).
 */
describe('a type a library the foundation bundles defines', () => {
  const PLAN = 'name: plan\nfields:\n  title: { type: string }\n'
  const library = (dir, json, schemas = { 'plan.yml': PLAN }) => {
    w(`${dir}/package.json`, json)
    for (const [file, body] of Object.entries(schemas)) w(`${dir}/schemas/${file}`, body)
    return join(ROOT, dir)
  }
  const classic = (deps) => {
    w('project/pnpm-workspace.yaml', 'packages:\n  - classic\n')
    w('project/classic/package.json', { name: 'classic', main: './_entry.generated.js', dependencies: deps })
    w('project/classic/main.js', "export default { name: '@acme/classic' }\n")
    return join(ROOT, 'project/classic')
  }

  it('⭐ outside the workspace, by its `file:` path', async () => {
    library('acme-shared', { name: '@acme/shared', uniweb: { scope: '@acme' } })
    const dir = classic({ '@acme/shared': 'file:../../acme-shared' })
    const schema = await resolveSchemaRef('@acme/plan', { srcDir: dir, aliases: {} })
    expect(Object.keys(schema.fields)).toEqual(['title'])
  })

  it('linked where pnpm or npm put it, by any other spec', async () => {
    const lib = library('acme-shared', { name: '@acme/shared', uniweb: { scope: '@acme' } })
    const dir = classic({ '@acme/shared': 'link:../../acme-shared' })
    const file = realpathSync(join(lib, 'schemas/plan.yml'))
    expect(await workspaceTypeFiles('@acme/plan', dir)).toEqual([file])
    w('project/classic/package.json', { name: 'classic', main: './_entry.generated.js', dependencies: { '@acme/shared': '*' } })
    mkdirSync(join(ROOT, 'project/node_modules/@acme'), { recursive: true })
    symlinkSync(lib, join(ROOT, 'project/node_modules/@acme/shared'), 'dir')
    expect(await workspaceTypeFiles('@acme/plan', dir)).toEqual([file])
  })

  it('and a library in the workspace and listed is read once', async () => {
    w('pnpm-workspace.yaml', 'packages:\n  - classic\n  - shared\n')
    library('shared', { name: 'shared', uniweb: { scope: '@acme' } })
    foundation('classic', '@acme/classic')
    w('classic/package.json', { name: 'classic', main: './_entry.generated.js', dependencies: { shared: 'file:../shared' } })
    expect(await workspaceTypeFiles('@acme/plan', join(ROOT, 'classic'))).toEqual([join(ROOT, 'shared/schemas/plan.yml')])
  })

  it('CONTROL: a library that gives another scope, or none, serves nothing under this one', async () => {
    library('other', { name: 'other', uniweb: { scope: '@zeta' } })
    library('bare', { name: 'bare' })
    const dir = classic({ other: 'file:../../other', bare: 'file:../../bare' })
    expect(await workspaceTypeFiles('@acme/plan', dir)).toEqual([])
    const error = await resolveSchemaRef('@acme/plan', { srcDir: dir, aliases: {} }).catch((e) => e)
    expect(error.code).toBe(SCHEMA_NOT_FOUND)
  })

  it('CONTROL: a package beside it that the foundation does not depend on is never read', async () => {
    library('acme-shared', { name: '@acme/shared', uniweb: { scope: '@acme' } })
    const dir = classic({})
    expect(await workspaceTypeFiles('@acme/plan', dir)).toEqual([])
  })

  it('a site reads its foundation\'s libraries too, for its records and queries', async () => {
    const lib = library('acme-shared', { name: '@acme/shared', uniweb: { scope: '@acme' } })
    classic({ '@acme/shared': 'file:../../acme-shared' })
    w('project/site/package.json', { name: 'site', dependencies: { classic: 'file:../classic' } })
    w('project/site/site.yml', 'foundation: classic\n')
    expect(await workspaceTypeFiles('@acme/plan', join(ROOT, 'project/site'))).toEqual([realpathSync(join(lib, 'schemas/plan.yml'))])
  })
})
