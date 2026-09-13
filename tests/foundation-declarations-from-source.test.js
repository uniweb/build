/**
 * `loadFoundationInfo` reads what a foundation declares — its theme vars — **from
 * its SOURCE**, and never from `dist/meta/schema.json`. ⛔ It reads no layout names:
 * a site's `layout/` folder is read from the site alone (`layout-folder.test.js`).
 *
 * ## Why source, and not the built schema
 *
 * `meta/schema.json` is the EDITOR's artifact: the rich per-section declaration
 * a visual editor needs for parameter forms and component pickers. The
 * architecture emits the declaration in two shapes for two audiences
 * (the site / foundation / runtime model, § The two-audience schema) — the lean runtime half ships inside `dist/entry.js` as
 * `capabilities`, and the rich half is for authoring tools. A site build is
 * neither audience, and `generate-entry.js` calls the very same two functions
 * this now calls in order to PRODUCE that schema.
 *
 * Until 2026-09-02 the built schema was read first and source was the fallback.
 * That cost three things: a site build depended on the foundation having been
 * built; a STALE schema.json (source edited, foundation not rebuilt) silently
 * won over the source; and dev and build disagreed about layouts, because the
 * layout names came from the same place. (Those names are no longer read here at
 * all — 2026-09-13.)
 *
 * The original regression this file was written for still holds and is stronger
 * now: with no built schema, vars used to come back EMPTY, so theme CSS omitted
 * the foundation-var block and components using `py-[var(--section-padding-y)]`
 * rendered with collapsed section spacing. Reading source first means that state
 * is unreachable rather than merely handled.
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

  // A layout is discovered from `layouts/` in the foundation SOURCE — the same
  // scan `generate-entry.js` runs — so a test about layout parity has to put one
  // on disk rather than only in a schema.
  if (layout) {
    mkdirSync(join(srcDir, 'layouts'), { recursive: true })
    writeFileSync(
      join(srcDir, 'layouts', `${layout}.jsx`),
      `export default function ${layout}({ children }) { return children }\n`
    )
  }

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
  })

  it('reads vars from a nested-layout (src/) foundation source when no schema.json exists', async () => {
    const vars = { 'section-padding-y': { default: '5rem' } }
    const { dir } = makeFoundation({ flat: false, vars })

    const info = await loadFoundationInfo(dir)

    expect(info.vars['section-padding-y']).toEqual({ default: '5rem' })
  })

  it('⭐ IGNORES a built schema.json, even when it disagrees with source', async () => {
    // Inverted 2026-09-02. This asserted the opposite — "the built schema is
    // authoritative when present" — which was stated rather than argued, and is
    // the premise the two-audience model contradicts.
    //
    // The practical case that settles it: a developer edits `vars` in main.js
    // and does not rebuild the foundation. Under the old precedence the build
    // served the STALE built value and nothing said so. Source cannot be stale
    // with respect to itself.
    const { dir } = makeFoundation({
      flat: true,
      vars: { 'section-padding-y': { default: 'SOURCE' } },
    })
    writeSchema(dir, {
      _self: { vars: { 'section-padding-y': { default: 'BUILT' } } },
    })

    const info = await loadFoundationInfo(dir)

    expect(info.vars['section-padding-y']).toEqual({ default: 'SOURCE' })
  })

  it('⛔ answers the SAME whether or not the foundation has been built', async () => {
    // Measured on a real fixture before 2026-09-02, when layout names came from
    // here too and a built schema was read first:
    //   built   layouts ["default","Wide"], default areas ["footer","header"]
    //   dev     layouts ["default"],        default areas ["Wide","footer","header"]
    // ⛔ The layout half is gone from this function (2026-09-13): a foundation's
    // layouts no longer decide how a site's `layout/` folder is read, so a layout on
    // disk here must not surface as anything.
    const { dir } = makeFoundation({
      flat: true,
      vars: { 'section-padding-y': { default: '5rem' } },
      layout: 'Wide',
    })

    const beforeBuild = await loadFoundationInfo(dir)
    writeSchema(dir, { _self: { vars: {} }, _layouts: {} })
    const afterBuild = await loadFoundationInfo(dir)

    expect(afterBuild.vars).toEqual(beforeBuild.vars)
    expect(beforeBuild).not.toHaveProperty('layoutNames')
    expect(afterBuild).not.toHaveProperty('layoutNames')
  })

  it('returns empty vars (no throw) when the foundation has neither schema nor readable source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uniweb-foundation-empty-'))
    tmpDirs.push(dir)

    const info = await loadFoundationInfo(dir)

    expect(info.vars).toEqual({})
  })

  it('returns empty vars when foundationPath is not provided', async () => {
    const info = await loadFoundationInfo(undefined)
    expect(info.vars).toEqual({})
    expect(info).not.toHaveProperty('layoutNames')
  })
})
