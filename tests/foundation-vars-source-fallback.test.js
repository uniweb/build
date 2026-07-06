/**
 * Regression: `loadFoundationInfo` must read foundation theme vars from the
 * foundation's SOURCE config (main.js / foundation.js) when no built
 * `dist/meta/schema.json` exists.
 *
 * This is the normal state for `uniweb dev` on a bundled-mode site that was
 * never built — dev doesn't build the foundation to dist/. Before the fix, the
 * vars came back empty, so the theme CSS omitted the foundation-var block and
 * components using `py-[var(--section-padding-y)]` rendered with collapsed
 * section spacing (missing padding on every section).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFoundationInfo } from '../src/site/content-collector.js'

const tmpDirs = []

function makeFoundation({ flat = true, vars, layout }) {
  const dir = mkdtempSync(join(tmpdir(), 'uniweb-foundation-'))
  tmpDirs.push(dir)

  const main = flat ? './_entry.generated.js' : './src/_entry.generated.js'
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-foundation', main }, null, 2)
  )

  const srcDir = flat ? dir : join(dir, 'src')
  if (!flat) mkdirSync(srcDir, { recursive: true })

  const varsLiteral = JSON.stringify(vars ?? {}, null, 2)
  writeFileSync(join(srcDir, 'main.js'), `export const vars = ${varsLiteral}\n`)

  return { dir, srcDir }
}

function writeSchema(foundationDir, schema) {
  const metaDir = join(foundationDir, 'dist', 'meta')
  mkdirSync(metaDir, { recursive: true })
  writeFileSync(join(metaDir, 'schema.json'), JSON.stringify(schema, null, 2))
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('loadFoundationInfo — source-config fallback (no built schema.json)', () => {
  it('reads vars from a flat-layout foundation source when no schema.json exists', async () => {
    const vars = {
      'section-padding-y': { default: 'clamp(4rem, 6vw, 7rem)' },
      'section-padding-x': { default: '1.5rem' },
      'header-height': { default: '4rem' },
    }
    const { dir } = makeFoundation({ flat: true, vars })

    const info = await loadFoundationInfo(dir)

    expect(info.vars['section-padding-y']).toEqual({ default: 'clamp(4rem, 6vw, 7rem)' })
    expect(info.vars['section-padding-x']).toEqual({ default: '1.5rem' })
    expect(info.vars['header-height']).toEqual({ default: '4rem' })
    expect(info.layoutNames).toBeInstanceOf(Set)
  })

  it('reads vars from a nested-layout (src/) foundation source when no schema.json exists', async () => {
    const vars = { 'section-padding-y': { default: '5rem' } }
    const { dir } = makeFoundation({ flat: false, vars })

    const info = await loadFoundationInfo(dir)

    expect(info.vars['section-padding-y']).toEqual({ default: '5rem' })
  })

  it('prefers the built schema.json over source when both are present', async () => {
    // Source declares one value; the built schema declares another. The built
    // schema is authoritative when present.
    const { dir } = makeFoundation({
      flat: true,
      vars: { 'section-padding-y': { default: 'SOURCE' } },
    })
    writeSchema(dir, {
      _self: { vars: { 'section-padding-y': { default: 'BUILT' } } },
      _layouts: { Standard: {} },
    })

    const info = await loadFoundationInfo(dir)

    expect(info.vars['section-padding-y']).toEqual({ default: 'BUILT' })
    expect(info.layoutNames.has('Standard')).toBe(true)
  })

  it('returns empty vars (no throw) when the foundation has neither schema nor readable source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uniweb-foundation-empty-'))
    tmpDirs.push(dir)

    const info = await loadFoundationInfo(dir)

    expect(info.vars).toEqual({})
    expect(info.layoutNames).toBeInstanceOf(Set)
  })

  it('returns empty vars when foundationPath is not provided', async () => {
    const info = await loadFoundationInfo(undefined)
    expect(info.vars).toEqual({})
    expect(info.layoutNames.size).toBe(0)
  })
})
