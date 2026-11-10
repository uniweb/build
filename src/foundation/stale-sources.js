/**
 * A `@source` that finds nothing — the CSS loses what was behind it, and nothing says so.
 *
 * `@source` tells Tailwind where else to look for class names, relative to the stylesheet. A path
 * that leads nowhere is no error to Tailwind: the build succeeds, and every class found only
 * there is missing from the CSS. Measured 2026-10-31 on four foundations moved up a level with
 * `@source "../node_modules/@uniweb/kit/src/**"` left as it was: exit 0, and CSS of 128,255 bytes
 * down to 78,634, with only the foundation's digest to show it. And on a template installed with
 * npm, which hoists kit to the workspace's root, away from the `./node_modules/@uniweb/kit` the
 * template names: 39,183 bytes where pnpm gave 51,967, from the first build.
 *
 * ⚖️ Only a path that reaches outside the foundation's own source counts: one that climbs, or one
 * into `node_modules`. A starter's `./components/**` names a folder a foundation may not have
 * yet, and with no such folder there is nothing to lose.
 *
 * ⚖️ And only a line that loses something. A stylesheet the foundation imports can name a package's
 * source itself, relative to itself, which holds wherever the package manager put it. Kit's does,
 * so a template's line for kit that leads nowhere under npm costs nothing there, and saying the CSS
 * is missing classes would be false. With a kit from before that, the loss is real: its stylesheet
 * names nothing, so the line is still reported.
 *
 * A folder no `@source` names is the same loss from the other side: see `unreadFolders`, and
 * `unreadLibraries` for the local packages a foundation bundles.
 *
 * @module @uniweb/build/foundation/stale-sources
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { librariesOf } from './libraries.js'

// `@source not "…"` excludes a path and `@source inline("…")` names no path: neither has a quote
// right after the keyword.
const SOURCE = /@source\s+(["'])(.+?)\1/g

// `@import url(…)` is a font on another host, with no quote right after the keyword.
const IMPORT = /@import\s+(["'])(.+?)\1/g

/** The part of a glob with no pattern in it: the folder it starts from. */
function fixedPrefix(glob) {
  const at = glob.search(/[*?[{(!]/)
  return at < 0 ? glob : glob.slice(0, glob.lastIndexOf('/', at) + 1)
}

const reachesOut = (path) => path.startsWith('../') || /(^|\/)node_modules(\/|$)/.test(path)

// ⛔ Quoted strings are skipped, not searched: a glob's `/**/` reads exactly like a comment.
const withoutComments = (css) =>
  css.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\//g, (_, quoted) => quoted ?? '')

/**
 * The `@source` lines of a stylesheet that reach outside the foundation and find nothing.
 *
 * @param {string} stylesPath - the foundation's stylesheet; none there, none stale
 * @returns {Array<{ source: string, missing: string, foundAt: string|null }>} each path as written,
 *   the part of it that does not exist, and, for a package, where it is from the stylesheet
 */
export function staleSources(stylesPath) {
  let css
  try {
    css = readFileSync(stylesPath, 'utf8')
  } catch {
    return []
  }
  const dir = dirname(stylesPath)
  const stale = []
  for (const [, , source] of withoutComments(css).matchAll(SOURCE)) {
    const missing = fixedPrefix(source)
    if (missing && reachesOut(source) && !existsSync(resolve(dir, missing))) {
      const foundAt = foundAbove(dir, missing)
      if (!foundAt || !readByAnImport(css, stylesPath, resolve(dir, foundAt))) {
        stale.push({ source, missing, foundAt })
      }
    }
  }
  return stale
}

/**
 * Does a stylesheet this one imports read that folder already, by a `@source` of its own?
 *
 * ⛔ Only a `.css` specifier: `tailwindcss` resolves to the package's JavaScript here, with no
 * `style` condition to choose its stylesheet.
 */
function readByAnImport(css, stylesPath, folder) {
  const require = createRequire(resolve(stylesPath))
  // An import resolves to the file itself, and pnpm's copy of a package is behind a link.
  const real = realpathSync(folder)
  for (const [, , specifier] of withoutComments(css).matchAll(IMPORT)) {
    if (!specifier.endsWith('.css')) continue
    let file, imported
    try {
      file = require.resolve(specifier)
      imported = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [, , source] of withoutComments(imported).matchAll(SOURCE)) {
      const rel = relative(resolve(dirname(file), fixedPrefix(source)), real)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
    }
  }
  return false
}

/**
 * Where a path into `node_modules` does lead, looking up from the stylesheet as a package is
 * resolved: relative to the stylesheet, or null when that package is nowhere above it.
 */
function foundAbove(dir, missing) {
  const tail = /(?:^|\/)(node_modules\/.*)$/.exec(missing)?.[1]
  if (!tail) return null
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, tail))) {
      const rel = relative(dir, join(at, tail))
      return rel.startsWith('.') ? rel : `./${rel}`
    }
    if (dirname(at) === at) return null
  }
}

// `@source not "…"` is the author's decision about that path, which is all `unreadFolders` asks.
const NOT_SOURCE = /@source\s+not\s+(["'])(.+?)\1/g

const USES_TAILWIND = /@import\s+["']tailwindcss/

// `source(…)` on the import sets Tailwind's root: "./" reads the foundation in every build, `none`
// in no build. Either way a site build and the foundation's own agree.
const SETS_ITS_ROOT = /@import\s+["']tailwindcss[^"']*["'][^;]*\bsource\(/

// ⚖️ A class written here, not one passed along (`className={className}`), nor a param declared
// with that name (`className: { type: 'string' }`).
const WRITES_CLASSES = /\bclassName\s*(?:=\s*\{[^}]*["'`]|[=:]\s*["'`])|\bcn\(|\bclass=["']/

// Or classes kept in a string, for code that hands them out: a colour's classes in a map,
// `{ amber: 'text-amber-600 bg-amber-50' }`, which a component in another folder then writes.
// ⚖️ A string counts when a class in it has a shade (`text-amber-600`) or an arbitrary value
// (`w-[42px]`), or when two of its words are classes and one has a number in it (`rounded-xl p-6`) —
// not a word with hyphens, an icon's name (`lu-house`) or a status (`to-verify`).
// ⛔ Until 2026-11-06 only a class written in place counted, so a `utils/` folder holding such a map
// was never named, and a site's CSS was missing its classes: an amber icon came out grey.
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const SHADE = /^!?(?:[\w-]+:)*-?(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|accent|caret|decoration|shadow|placeholder)-[a-z]+-(?:50|[1-9]00|950)(?:\/\d+)?$/
const ARBITRARY = /^!?(?:[\w-]+:)*-?[a-z]+(?:-[a-z]+)*-\[[^\]\s]+\]$/
const UTILITY = /^!?(?:[\w-]+:)*-?[a-z]+(?:-[\w./[\]#%]+)+$/

/** Whether code writes a class, or keeps one in a string. */
function writesClasses(code) {
  if (WRITES_CLASSES.test(code)) return true
  for (const [, , text] of code.matchAll(STRING)) {
    const words = text.trim().split(/\s+/)
    if (words.some((word) => SHADE.test(word) || ARBITRARY.test(word))) return true
    const classes = words.filter((word) => UTILITY.test(word))
    if (classes.length >= 2 && classes.some((word) => /\d/.test(word))) return true
  }
  return false
}

const NOT_THE_FOUNDATIONS_CODE = new Set(['node_modules', 'dist', 'public', 'test', 'tests', '__tests__'])

function codeFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || NOT_THE_FOUNDATIONS_CODE.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) codeFiles(path, found)
    else if (/\.[jt]sx?$/.test(entry.name) && !/\.(?:test|spec|generated)\./.test(entry.name)) found.push(path)
  }
  return found
}

/** The paths a stylesheet's `@source` lines start from, and those of the stylesheets it imports. */
function pathsRead(file, seen = new Set()) {
  if (seen.has(file)) return []
  seen.add(file)
  let css
  try {
    css = withoutComments(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const read = [...css.matchAll(SOURCE), ...css.matchAll(NOT_SOURCE)].map((m) => resolve(dirname(file), fixedPrefix(m[2])))
  const require = createRequire(file)
  for (const [, , specifier] of css.matchAll(IMPORT)) {
    // ⛔ Only a `.css` specifier, as in `readByAnImport`.
    if (!specifier.endsWith('.css')) continue
    let imported
    try {
      imported = require.resolve(specifier)
    } catch {
      continue
    }
    read.push(...pathsRead(imported, seen))
  }
  return read
}

/**
 * The code in a foundation that writes classes no `@source` reads.
 *
 * Tailwind reads everything under Vite's root, and whatever `@source` names. A foundation's own build
 * has the foundation for its root, so it finds every class. A site build and `uniweb dev` have the
 * site: there, `@source` is all that reaches the foundation. So a class only such code uses is in the
 * foundation's CSS and missing from the site's, with both builds exiting 0, and a page on a host
 * loading the foundation's own CSS looks right. Measured 2026-11-01 on the `dynamic` template, whose
 * stylesheet named `./sections` alone: its home page's weather card came out a blank white box, 27
 * classes short, under `uniweb dev` and in a site build.
 *
 * ⚖️ It errs toward saying nothing. Any `@source` starting at or above a file reads that file, whatever
 * its glob, and a foundation that doesn't import Tailwind by name is not looked at. A word here is a
 * line to add, whose only cost is a stylesheet naming one more folder.
 *
 * @param {string} stylesPath - the foundation's stylesheet; none there, nothing to say
 * @returns {Array<{ path: string, files: number, line: string }>} each folder (or file) beside the
 *   stylesheet, how many of its files write classes, and the line that reads it
 */
export function unreadFolders(stylesPath) {
  // ⛔ The real path: an import resolves to one, so a line it holds would never match a file reached
  // through a link (a macOS temp folder, a workspace dependency).
  let stylesheet, css
  try {
    stylesheet = realpathSync(stylesPath)
    css = withoutComments(readFileSync(stylesheet, 'utf8'))
  } catch {
    return []
  }
  if (!USES_TAILWIND.test(css) || SETS_ITS_ROOT.test(css)) return []

  const dir = dirname(stylesheet)
  const read = pathsRead(stylesheet)
  const unread = new Map()
  for (const file of codeFiles(dir)) {
    if (read.some((path) => file === path || file.startsWith(path + sep))) continue
    if (!writesClasses(withoutComments(readFileSync(file, 'utf8')))) continue
    const [top, ...below] = relative(dir, file).split(sep)
    const entry = unread.get(top) ?? { path: top, files: 0, isFolder: below.length > 0, typed: false }
    entry.files++
    entry.typed ||= /\.tsx?$/.test(file)
    unread.set(top, entry)
  }
  return [...unread.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, files, isFolder, typed }) => ({
      path,
      files,
      line: `@source "./${path}${isFolder ? `/**/*.{js,jsx${typed ? ',ts,tsx' : ''}}` : ''}";`
    }))
}

/**
 * The one line that ends the problem, rather than a folder at a time: Tailwind then reads the whole
 * foundation in a site build too, and `unreadFolders` has nothing to look for. The scaffold and the
 * starter templates write it since 2026-11-06.
 */
export const READ_WHOLE_FOUNDATION = '@import "tailwindcss" source("./");'

/** What a site build and `uniweb dev` print when `unreadFolders` finds any: it is them that lose the classes. */
export function unreadFoldersWarning(unread) {
  return [
    "[uniweb] The foundation's styles.css names no @source for code that writes classes, so a site build and `uniweb dev` miss any class only that code uses, though the foundation's own build has it. Have Tailwind read the whole foundation, and no folder can be left out:",
    `  ${READ_WHOLE_FOUNDATION}`,
    '  Or add:',
    ...unread.map(({ line }) => `  ${line}`)
  ].join('\n')
}

/** The library's own stylesheet, when importing it reads the library: its line, else null. */
function libraryStylesheetLine(lib) {
  const sheet = join(lib.dir, 'styles.css')
  if (!existsSync(sheet)) return null
  // ⛔ An `exports` map without the stylesheet refuses the import, in Tailwind and in Node alike.
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(lib.dir, 'package.json'), 'utf8'))
  } catch {
    // no manifest to refuse it
  }
  const exp = pkg?.exports
  if (exp && typeof exp === 'object' && !Object.keys(exp).some((k) => k === './styles.css' || k === './*')) return null
  const covers = pathsRead(sheet).some((path) => lib.dir === path || lib.dir.startsWith(path + sep))
  return covers ? `@import "${lib.name}/styles.css";` : null
}

/**
 * ⭐ The libraries a foundation bundles whose classes no `@source` reads: local packages it depends
 * on (`librariesOf`), outside the stylesheet's folder, that write classes.
 *
 * Tailwind reads the folder it is rooted in and whatever `@source` names, and a library is outside
 * the foundation. So a class only a library uses is in no CSS at all: not the foundation's own,
 * which a hosted site loads with the foundation, and not a site build's. Measured 2026-11-09 on a
 * foundation whose sections render a library's component, with the library's stylesheet left out
 * of the foundation's: both builds exited 0, and `ring-primary-500`, `tracking-tight` and
 * `space-y-1`, used only in the library, were in neither CSS.
 *
 * ⚖️ It errs toward saying nothing, as `unreadFolders` does: any `@source` at, above or inside a
 * library reads it, and a library that writes no classes needs none. A library inside the
 * stylesheet's folder is the foundation's code to `unreadFolders`.
 *
 * @param {string} stylesPath - the foundation's stylesheet; none there, nothing to say
 * @param {string} packageDir - the foundation's folder, the one its package.json is in
 * @returns {Array<{ name: string, files: number, line: string }>} each library by the name the
 *   foundation depends on it by, how many of its files write classes, and the line that reads it
 */
export function unreadLibraries(stylesPath, packageDir) {
  let stylesheet, css
  try {
    stylesheet = realpathSync(stylesPath)
    css = withoutComments(readFileSync(stylesheet, 'utf8'))
  } catch {
    return []
  }
  if (!USES_TAILWIND.test(css)) return []

  const dir = dirname(stylesheet)
  const read = pathsRead(stylesheet)
  const unread = []
  for (const lib of librariesOf(packageDir)) {
    if (lib.dir === dir || lib.dir.startsWith(dir + sep)) continue
    if (read.some((path) => lib.dir === path || lib.dir.startsWith(path + sep) || path.startsWith(lib.dir + sep))) continue
    let files = 0
    for (const file of codeFiles(lib.dir)) {
      if (writesClasses(withoutComments(readFileSync(file, 'utf8')))) files++
    }
    if (!files) continue
    const rel = relative(dir, lib.dir).split(sep).join('/')
    unread.push({ name: lib.name, files, line: libraryStylesheetLine(lib) ?? `@source "${rel.startsWith('.') ? rel : `./${rel}`}";` })
  }
  return unread
}

/**
 * What a foundation build, a site build and `uniweb dev` print when `unreadLibraries` finds any,
 * each the CSS it makes: a site build of a stale foundation runs both builds, and says both.
 *
 * @param {Array<{ name: string, line: string }>} unread
 * @param {{ build?: 'foundation'|'site' }} [options] - the build that prints it
 */
export function unreadLibrariesWarning(unread, { build = 'site' } = {}) {
  const named = unread.map(({ name }) => name).join(', ')
  const many = unread.length > 1
  const lost = build === 'foundation' ? "the foundation's CSS, which a hosted site loads with it" : "this site's CSS, and from the foundation's own"
  return [
    `[uniweb] The foundation bundles ${named}, and its styles.css reads no classes from ${many ? 'them' : 'it'}, so any class only ${many ? 'they write is' : 'it writes is'} missing from ${lost}. Add to the foundation's styles.css:`,
    ...unread.map(({ line }) => `  ${line}`)
  ].join('\n')
}

/** A stale line's note: what is missing, and where it is instead when that is known. */
export const staleSourceNote = ({ missing, foundAt }) => `no ${missing}${foundAt ? `; it is at ${foundAt}` : ''}`

/** What the foundation build prints when `staleSources` finds any. */
export function staleSourcesWarning(stale) {
  return [
    '[uniweb] styles.css has a @source that finds nothing, so the CSS is missing every class that was only there:',
    ...stale.map((line) => `  @source "${line.source}"  (${staleSourceNote(line)})`),
    'Paths are relative to styles.css.'
  ].join('\n')
}
