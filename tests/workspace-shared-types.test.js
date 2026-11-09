/**
 * ⭐ A type another package of the workspace defines is read with nothing configured.
 *
 * Foundations developed together share a data schema by its full name, `@acme/member`, and a local
 * build reads it from the foundation whose name gives the `@acme` scope and whose own `schemas/`
 * defines it — no `schemas.config.js`, no package to install, nothing registered. Sharing a type never
 * needs a backend [Diego, 2026-11-08: "it should be easy and good DX to share schemas"].
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
      /defined by 2 packages of this workspace: .*crm.*hub|defined by 2 packages of this workspace: .*hub.*crm/
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
    expect(error.message).toMatch(/no package of its workspace whose name gives the scope '@acme' defines 'member'/)
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
