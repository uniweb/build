/**
 * A `@source` that finds nothing — `src/foundation/stale-sources.js`.
 *
 * Tailwind says nothing about one, and the CSS loses every class only found there: measured
 * 2026-10-31 on foundations moved up a level, 128,255 bytes of CSS down to 78,634, exit 0.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('a stale line for a package whose own stylesheet names its source', () => {
  const LINE = '@source "./node_modules/@uniweb/kit/src/**/*.{js,jsx}";'

  /** Kit hoisted to the workspace root, as npm leaves it, holding the given stylesheet. */
  function hoisted(styles, kitStylesheet) {
    const root = mkdtempSync(join(tmpdir(), 'uw-stale-kit-'))
    dirs.push(root)
    const kit = join(root, 'node_modules', '@uniweb', 'kit')
    mkdirSync(join(kit, 'src'), { recursive: true })
    writeFileSync(
      join(kit, 'package.json'),
      JSON.stringify({ name: '@uniweb/kit', exports: { './theme-tokens.css': './src/theme-tokens.css' } })
    )
    writeFileSync(join(kit, 'src', 'theme-tokens.css'), kitStylesheet)
    mkdirSync(join(root, 'src'))
    const path = join(root, 'src', 'styles.css')
    writeFileSync(path, styles)
    return path
  }

  const TOKENS = '@import "@uniweb/kit/theme-tokens.css";'
  const NAMES_ITS_SOURCE = '/* Kit\'s own classes */\n@source "./**/*.{js,jsx}";\n@theme inline {}\n'

  test('⭐ the import reads that folder, so the line loses nothing and nothing is said', () => {
    expect(staleSources(hoisted(`${TOKENS}\n${LINE}`, NAMES_ITS_SOURCE))).toEqual([])
  })

  test('⭐ kit behind a link, as pnpm leaves it: the folder and the import meet at the real path', () => {
    const root = mkdtempSync(join(tmpdir(), 'uw-stale-linked-'))
    dirs.push(root)
    const real = join(root, 'node_modules', '.pnpm', 'kit@1', 'node_modules', '@uniweb', 'kit')
    mkdirSync(join(real, 'src'), { recursive: true })
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: '@uniweb/kit', exports: { './theme-tokens.css': './src/theme-tokens.css' } }))
    writeFileSync(join(real, 'src', 'theme-tokens.css'), NAMES_ITS_SOURCE)
    mkdirSync(join(root, 'src', 'node_modules', '@uniweb'), { recursive: true })
    symlinkSync(real, join(root, 'src', 'node_modules', '@uniweb', 'kit'))
    const path = join(root, 'src', 'styles.css')
    // A move left this one climbing out of the folder that holds the link.
    writeFileSync(path, `${TOKENS}\n@source "../node_modules/@uniweb/kit/src/**/*.{js,jsx}";`)
    expect(staleSources(path)).toEqual([])
  })

  test('single quotes, and a font imported ahead of it', () => {
    const css = `@import url('https://fonts.example/x.css');\n@import '@uniweb/kit/theme-tokens.css';\n${LINE}`
    expect(staleSources(hoisted(css, NAMES_ITS_SOURCE))).toEqual([])
  })

  test('⭐ an older kit, whose stylesheet names nothing: the loss is real, and said', () => {
    const stale = staleSources(hoisted(`${TOKENS}\n${LINE}`, '@theme inline {}\n'))
    expect(stale.map((s) => s.foundAt)).toEqual(['../node_modules/@uniweb/kit/src'])
  })

  test('a foundation that skips the import: nothing else reads kit, and it is said', () => {
    expect(staleSources(hoisted(LINE, NAMES_ITS_SOURCE))).toHaveLength(1)
  })

  test("a stylesheet's comment naming a source reads nothing", () => {
    const commented = '/* @source "./**/*.{js,jsx}"; */\n@theme inline {}\n'
    expect(staleSources(hoisted(`${TOKENS}\n${LINE}`, commented))).toHaveLength(1)
  })

  test('its source does not cover a line for another package', () => {
    const line = '@source "./node_modules/other/src/**/*.jsx";'
    const path = hoisted(`${TOKENS}\n${line}`, NAMES_ITS_SOURCE)
    mkdirSync(join(dirname(dirname(path)), 'node_modules', 'other', 'src'), { recursive: true })
    expect(staleSources(path)).toHaveLength(1)
  })

  test('an import that resolves to nothing changes nothing', () => {
    const css = `@import "@uniweb/none/x.css";\n@import "tailwindcss";\n${LINE}`
    expect(staleSources(hoisted(css, NAMES_ITS_SOURCE))).toHaveLength(1)
  })
})

test('the warning names the line and what is missing', () => {
  const said = staleSourcesWarning([{ source: '../node_modules/x/**', missing: '../node_modules/x/', foundAt: './node_modules/x' }])
  expect(said).toMatch(/finds nothing/)
  expect(said).toContain('@source "../node_modules/x/**"  (no ../node_modules/x/; it is at ./node_modules/x)')
  expect(staleSourcesWarning([{ source: '../y/**', missing: '../y/', foundAt: null }])).toContain('(no ../y/)')
})
