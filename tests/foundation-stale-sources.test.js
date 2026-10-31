/**
 * A `@source` that finds nothing — `src/foundation/stale-sources.js`.
 *
 * Tailwind says nothing about one, and the CSS loses every class only found there: measured
 * 2026-10-31 on foundations moved up a level, 128,255 bytes of CSS down to 78,634, exit 0.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staleSources, staleSourcesWarning } from '../src/foundation/stale-sources.js'

const dirs = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A foundation's source folder, inside a package root, with kit installed beside the stylesheet. */
function foundation(css) {
  const root = mkdtempSync(join(tmpdir(), 'uw-stale-sources-'))
  dirs.push(root)
  mkdirSync(join(root, 'node_modules', '@uniweb', 'kit', 'src'), { recursive: true })
  mkdirSync(join(root, 'sections'), { recursive: true })
  const path = join(root, 'styles.css')
  writeFileSync(path, css)
  return path
}

describe('which @source lines find nothing', () => {
  test('⭐ the one a move leaves behind: it climbs to a node_modules that is not there', () => {
    const stale = staleSources(foundation('@source "../node_modules/@uniweb/kit/src/**/*.{js,jsx}";'))
    expect(stale).toEqual([
      {
        source: '../node_modules/@uniweb/kit/src/**/*.{js,jsx}',
        missing: '../node_modules/@uniweb/kit/src/',
        foundAt: './node_modules/@uniweb/kit/src'
      }
    ])
  })

  test('a package that is nowhere: named, with nowhere to point at', () => {
    const stale = staleSources(foundation('@source "./node_modules/@uniweb/press/src/**/*.jsx";'))
    expect(stale).toHaveLength(1)
    expect(stale[0].foundAt).toBe(null)
  })

  test('⭐ a package hoisted to the workspace root, as npm installs a template: it says where', () => {
    const root = mkdtempSync(join(tmpdir(), 'uw-stale-hoisted-'))
    dirs.push(root)
    mkdirSync(join(root, 'node_modules', '@uniweb', 'kit', 'src'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    const path = join(root, 'src', 'styles.css')
    writeFileSync(path, '@source "./node_modules/@uniweb/kit/src/**/*.{js,jsx}";')
    expect(staleSources(path)).toEqual([
      {
        source: './node_modules/@uniweb/kit/src/**/*.{js,jsx}',
        missing: './node_modules/@uniweb/kit/src/',
        foundAt: '../node_modules/@uniweb/kit/src'
      }
    ])
  })

  test('a path that climbs to a folder that is gone, in single quotes, among good ones', () => {
    const stale = staleSources(foundation("@source './sections/**/*.jsx';\n@source '../shared/ui/**/*.jsx';"))
    expect(stale.map((s) => s.source)).toEqual(['../shared/ui/**/*.jsx'])
  })

  test('CONTROL — the same path, where the package is', () => {
    expect(staleSources(foundation('@source "./node_modules/@uniweb/kit/src/**/*.{js,jsx}";'))).toEqual([])
  })

  test("CONTROL — a starter's folder the foundation does not have yet costs nothing", () => {
    expect(staleSources(foundation('@source "./components/**/*.{js,jsx}";'))).toEqual([])
  })

  test('CONTROL — an exclusion, an inline list and a comment name no path to look in', () => {
    const css = [
      '@source not "../node_modules/gone/**";',
      '@source inline("underline");',
      '/* @source "../node_modules/@uniweb/kit/src/**"; */'
    ].join('\n')
    expect(staleSources(foundation(css))).toEqual([])
  })

  test('CONTROL — no stylesheet, nothing stale', () => {
    expect(staleSources(join(tmpdir(), 'no-such-folder', 'styles.css'))).toEqual([])
  })
})

test('the warning names the line and what is missing', () => {
  const said = staleSourcesWarning([{ source: '../node_modules/x/**', missing: '../node_modules/x/', foundAt: './node_modules/x' }])
  expect(said).toMatch(/finds nothing/)
  expect(said).toContain('@source "../node_modules/x/**"  (no ../node_modules/x/; it is at ./node_modules/x)')
  expect(staleSourcesWarning([{ source: '../y/**', missing: '../y/', foundAt: null }])).toContain('(no ../y/)')
})
