/**
 * A library a foundation bundles whose classes no `@source` reads — `unreadLibraries`, in
 * `src/foundation/stale-sources.js`.
 *
 * Measured 2026-11-09: a foundation whose sections render a library's component, with the
 * library's stylesheet left out of the foundation's. Both builds exited 0, and the classes only the
 * library used were in neither the foundation's own CSS, which a hosted site loads with it, nor the
 * site's.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unreadLibraries, unreadLibrariesWarning } from '../src/foundation/stale-sources.js'

const roots = []
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const TAILWIND = '@import "tailwindcss" source("./");\n'
const CARD = 'export default () => <div className="ring-2 ring-primary-500 tracking-tight" />\n'
const LIB_CSS = '@source "./";\n'

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

/**
 * A workspace with `classic`, a foundation depending on `shared` by `file:`, linked as pnpm links
 * it. `styles` is classic's stylesheet; `lib` the library's files.
 */
function workspace({ styles = TAILWIND, lib = { 'components/PlanCard.jsx': CARD, 'styles.css': LIB_CSS }, libJson = {} } = {}) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'uw-unread-libs-')))
  roots.push(ws)
  const shared = join(ws, 'shared')
  write(join(shared, 'package.json'), JSON.stringify({ name: '@acme/shared', ...libJson }))
  for (const [rel, body] of Object.entries(lib)) write(join(shared, rel), body)
  const classic = join(ws, 'classic')
  write(join(classic, 'package.json'), JSON.stringify({ name: 'classic', dependencies: { '@acme/shared': 'file:../shared' } }))
  write(join(classic, 'styles.css'), styles)
  mkdirSync(join(classic, 'node_modules', '@acme'), { recursive: true })
  symlinkSync(shared, join(classic, 'node_modules', '@acme', 'shared'), 'dir')
  return { ws, shared, classic, stylesPath: join(classic, 'styles.css') }
}

describe('a library whose classes no @source reads', () => {
  test("⭐ the recipe's slip: its stylesheet not imported", () => {
    const { classic, stylesPath } = workspace()
    expect(unreadLibraries(stylesPath, classic)).toEqual([
      { name: '@acme/shared', files: 1, line: '@import "@acme/shared/styles.css";' }
    ])
  })

  test('CONTROL: its stylesheet imported, which reads it wherever it is installed', () => {
    const { classic, stylesPath } = workspace({ styles: `${TAILWIND}@import "@acme/shared/styles.css";\n` })
    expect(unreadLibraries(stylesPath, classic)).toEqual([])
  })

  test('CONTROL: a @source of its own that reaches the library, or a part of it', () => {
    for (const source of ['../shared', '../shared/components/**/*.jsx', '..']) {
      const { classic, stylesPath } = workspace({ styles: `${TAILWIND}@source "${source}";\n` })
      expect(unreadLibraries(stylesPath, classic)).toEqual([])
    }
  })

  test('with no stylesheet of its own, the line is a @source to its folder', () => {
    const { classic, stylesPath } = workspace({ lib: { 'components/PlanCard.jsx': CARD } })
    expect(unreadLibraries(stylesPath, classic)).toEqual([{ name: '@acme/shared', files: 1, line: '@source "../shared";' }])
  })

  test('nor when its stylesheet reads none of it, or its exports leave the stylesheet out', () => {
    const silent = workspace({ lib: { 'components/PlanCard.jsx': CARD, 'styles.css': '.x { color: red; }\n' } })
    expect(unreadLibraries(silent.stylesPath, silent.classic)[0].line).toBe('@source "../shared";')
    const closed = workspace({ libJson: { exports: { '.': './index.js' } } })
    expect(unreadLibraries(closed.stylesPath, closed.classic)[0].line).toBe('@source "../shared";')
  })

  test('CONTROL: a library that writes no classes needs no @source', () => {
    const { classic, stylesPath } = workspace({ lib: { 'usePriceLabel.js': 'export const usePriceLabel = (p) => `$${p}`\n' } })
    expect(unreadLibraries(stylesPath, classic)).toEqual([])
  })

  test('CONTROL: a foundation that does not use Tailwind', () => {
    const { classic, stylesPath } = workspace({ styles: '.card { color: red; }\n' })
    expect(unreadLibraries(stylesPath, classic)).toEqual([])
  })

  test('CONTROL: no stylesheet, nothing to say', () => {
    const { classic } = workspace()
    expect(unreadLibraries(join(classic, 'no-such.css'), classic)).toEqual([])
  })

  test('the warning names each library, the CSS its build loses, and the lines to add', () => {
    const { classic, stylesPath } = workspace()
    const unread = unreadLibraries(stylesPath, classic)
    const site = unreadLibrariesWarning(unread)
    expect(site).toContain('bundles @acme/shared')
    expect(site).toContain("missing from this site's CSS, and from the foundation's own")
    expect(site).toContain('\n  @import "@acme/shared/styles.css";')
    expect(unreadLibrariesWarning(unread, { build: 'foundation' })).toContain("missing from the foundation's CSS, which a hosted site loads with it")
  })
})
