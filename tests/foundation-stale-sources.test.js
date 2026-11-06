/**
 * A `@source` that finds nothing — `src/foundation/stale-sources.js`.
 *
 * Tailwind says nothing about one, and the CSS loses every class only found there: measured
 * 2026-10-31 on foundations moved up a level, 128,255 bytes of CSS down to 78,634, exit 0.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { staleSources, staleSourcesWarning, unreadFolders, unreadFoldersWarning } from '../src/foundation/stale-sources.js'

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

/**
 * A foundation's source folder holding these files. A site build and `uniweb dev` read only what
 * `@source` names, where the foundation's own build finds everything: measured on the `dynamic`
 * template, 2026-11-01.
 */
function writing(css, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uw-unread-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({ 'styles.css': css, ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return join(root, 'styles.css')
}

const TAILWIND = '@import "tailwindcss";\n'
const SECTIONS = `${TAILWIND}@source "./sections/**/*.{js,jsx}";\n`
const CARD = 'export default () => <div className="bg-slate-800 p-4" />\n'
const CARDS = { 'sections/Hero/index.jsx': CARD, 'components/Card.jsx': CARD, 'components/deep/Note.jsx': CARD }

describe('what no @source reads', () => {
  test("⭐ a template's shape: a stylesheet naming sections, over components that write classes", () => {
    expect(unreadFolders(writing(SECTIONS, CARDS))).toEqual([
      { path: 'components', files: 2, line: '@source "./components/**/*.{js,jsx}";' }
    ])
  })

  test('the line it gives reads what it found', () => {
    const [{ line }] = unreadFolders(writing(SECTIONS, CARDS))
    expect(unreadFolders(writing(`${SECTIONS}${line}\n`, CARDS))).toEqual([])
  })

  test.each([
    ['a folder with no glob', '@source "./components";'],
    ['a glob that may stop short, since this errs toward saying nothing', '@source "./components/*.jsx";'],
    ['the whole folder', '@source "./";'],
    ['the whole folder, by a glob', '@source "./**/*.{js,jsx}";'],
    ['an exclusion, which is a decision', '@source not "./components/**";']
  ])('CONTROL — it counts as read: %s', (_, line) => {
    expect(unreadFolders(writing(`${SECTIONS}${line}\n`, CARDS))).toEqual([])
  })

  test.each([
    ['className="…"', 'export default () => <div className="flex" />'],
    ["className={'…'}", "export default () => <div className={'flex'} />"],
    ['a choice between two', "export default ({ on }) => <div className={on ? 'flex' : 'hidden'} />"],
    ['cn(…)', "import { cn } from '@uniweb/kit'\nexport const x = cn('flex')"],
    ["X.className = '…', as a section sets", "const X = () => null\nX.className = 'py-4'\nexport default X"],
    ["className: '…'", "export const props = { className: 'flex' }"],
    ['class="…" in a string', 'export const html = \'<div class="flex"></div>\'']
  ])('%s writes a class', (_, code) => {
    expect(unreadFolders(writing(SECTIONS, { 'widgets/X.jsx': code })).map((u) => u.path)).toEqual(['widgets'])
  })

  test.each([
    ["a colour's classes in a map", "export const ICON = { amber: 'text-amber-600 bg-amber-50' }"],
    ['one class with a shade', 'export const accent = "hover:text-amber-600"'],
    ['classes with a size', 'export const panel = `rounded-xl p-6`'],
    ['an arbitrary value', "export const w = ['w-[42px]', 'h-full'].join(' ')"]
  ])('⭐ %s keeps classes for code elsewhere to write (2026-11-06)', (_, code) => {
    expect(unreadFolders(writing(SECTIONS, { 'utils/x.js': code })).map((u) => u.path)).toEqual(['utils'])
  })

  test.each([
    ['logic alone', 'export const add = (a, b) => a + b'],
    ["an icon's name", "export const icon = 'lu-graduation-cap'"],
    ['a status, and words with hyphens', "export const states = ['to-verify', 'well-known co-founder']"],
    ['a date and an address', "export const at = '2026-11-06 https://example.com/a-1'"],
    ['a class passed along', 'export default ({ className }) => <div className={className} />'],
    ['a param declared with that name', "export default { params: { className: { type: 'string' } } }"],
    ['a comment about one', '/**\n * <span class="x">y</span> becomes y\n */\nexport const strip = (html) => html']
  ])('CONTROL — %s writes none', (_, code) => {
    expect(unreadFolders(writing(SECTIONS, { 'utils/x.js': code }))).toEqual([])
  })

  test.each([
    ['node_modules/@acme/ui/Card.jsx'],
    ['dist/entry.js'],
    ['public/embed.js'],
    ['tests/Card.jsx'],
    ['__tests__/Card.jsx'],
    ['components/Card.test.jsx'],
    ['_entry.generated.js'],
    ['.cache/Card.jsx']
  ])("CONTROL — %s isn't the foundation's code", (rel) => {
    expect(unreadFolders(writing(SECTIONS, { [rel]: CARD }))).toEqual([])
  })

  test('a file beside the stylesheet is named by itself', () => {
    expect(unreadFolders(writing(SECTIONS, { 'Shell.jsx': CARD }))).toEqual([
      { path: 'Shell.jsx', files: 1, line: '@source "./Shell.jsx";' }
    ])
  })

  test('TypeScript is code too, and the line then reads it', () => {
    const [{ line }] = unreadFolders(writing(SECTIONS, { 'components/Card.tsx': CARD }))
    expect(line).toBe('@source "./components/**/*.{js,jsx,ts,tsx}";')
  })

  test('a line in a stylesheet this one imports counts, relative to that stylesheet', () => {
    const files = { ...CARDS, 'styles/tw.css': '@source "../components/**/*.jsx";\n' }
    expect(unreadFolders(writing(`${SECTIONS}@import "./styles/tw.css";\n`, files))).toEqual([])
  })

  test('a commented-out line reads nothing', () => {
    expect(unreadFolders(writing(`${SECTIONS}/* @source "./components/**"; */\n`, CARDS))).toHaveLength(1)
  })

  test.each([
    ['its root set to the foundation', '@import "tailwindcss" source("./");\n'],
    ['no root in any build', '@import "tailwindcss" source(none);\n'],
    ['no Tailwind', '.card { color: red; }\n']
  ])('CONTROL — every build agrees with %s', (_, css) => {
    expect(unreadFolders(writing(css, CARDS))).toEqual([])
  })

  test('no stylesheet, nothing to say', () => {
    expect(unreadFolders(join(tmpdir(), 'no-such-folder', 'styles.css'))).toEqual([])
  })

  test('a relative path to the stylesheet reads the same', () => {
    const path = writing(SECTIONS, CARDS)
    expect(unreadFolders(relative(process.cwd(), path))).toEqual(unreadFolders(path))
  })

  test('the warning gives the lines to add', () => {
    const said = unreadFoldersWarning(unreadFolders(writing(SECTIONS, CARDS)))
    expect(said).toContain('a site build and `uniweb dev`')
    expect(said).toContain('\n  @source "./components/**/*.{js,jsx}";')
  })

  test('⭐ …and first the one line that ends it: Tailwind reading the whole foundation, which then has nothing unread', () => {
    const said = unreadFoldersWarning(unreadFolders(writing(SECTIONS, CARDS)))
    expect(said).toContain('\n  @import "tailwindcss" source("./");')
    expect(said.indexOf('source("./")')).toBeLessThan(said.indexOf('@source "./components'))
    // with that line, the same foundation has nothing unread
    const whole = writing(SECTIONS.replace(TAILWIND, TAILWIND.replace('"tailwindcss"', '"tailwindcss" source("./")')), CARDS)
    expect(unreadFolders(whole)).toEqual([])
  })
})
