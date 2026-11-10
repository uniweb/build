/**
 * ⭐ A LIBRARY BUILDS AS PART OF THE FOUNDATION THAT BUNDLES IT, WHEREVER IT IS. A library is any
 * local package a foundation depends on (`librariesOf`): in the workspace, or in a folder beside it,
 * another repository say, linked with `file:`. Its files are the foundation's code once bundled, so
 * whatever builds a foundation's source (its build, its SSR bundle, a site's build and dev server)
 * resolves them by three rules:
 *
 *   1. **A library's imports resolve as the foundation's own.** Its `peerDependencies` are the
 *      foundation's to provide, so they resolve from the foundation; anything else resolves from the
 *      library's own install first, then from where the package manager installed it, then from the
 *      foundation. ⛔ A library outside the workspace has nothing installed beside it: until
 *      2026-11-10 a build under npm stopped there, `Rollup failed to resolve import "@uniweb/kit"`.
 *   2. **A library is read from its folder,** whatever copy the package manager installed
 *      (`inLibraryFolder`): its name resolves into the folder, for an import here and, through
 *      `libraryAliases`, for a stylesheet's `@import`, which Tailwind resolves with Vite's resolver
 *      and no plugin. ⛔ pnpm copies a `file:` package from outside the workspace, and until then a
 *      file added to the library, or saved by an editor that replaces the file, never reached a
 *      build without `pnpm install`, though the build said the library changed.
 *   3. **The dev server serves a library as source:** a site's config never pre-bundles one
 *      (`site/config.js`), since a pre-bundled library is a snapshot that no edit reaches.
 *
 * A library inside the workspace resolves to the same files by these rules as without them, so they
 * change nothing for one: measured 2026-11-10, byte-identical builds with and without.
 *
 * @module @uniweb/build/foundation/library-imports
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { librariesOf, inLibraryFolder, installedLibrary } from './libraries.js'

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const readPackage = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (id) => (id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0])

/** A specifier that names a package: not a path, a URL, a virtual module or a subpath import. */
const isBare = (id) =>
  !!id && !/^[./\\#\0]/.test(id) && !isAbsolute(id) && !/^[a-z][a-z0-9+.-]*:/i.test(id)

/** `file` inside `dir`, and not in a `node_modules` under it. */
const insideOwnFiles = (dir, file) => {
  const rel = relative(dir, file)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).includes('node_modules')
}

/** Each library the foundation bundles, with its peers and where it is installed. */
function librariesFor(foundationDir) {
  return librariesOf(foundationDir).map((lib) => ({
    ...lib,
    peers: new Set(Object.keys(readPackage(lib.dir)?.peerDependencies || {})),
    installed: installedLibrary(foundationDir, lib.name)
  }))
}

/**
 * The Vite plugin for rules 1 and 2, for one foundation's libraries.
 *
 * @param {{ foundationDir: string }} options - the foundation whose libraries these are
 * @returns {import('vite').Plugin}
 */
export function libraryImports({ foundationDir }) {
  let libraries = null
  const all = () => (libraries ??= librariesFor(foundationDir))
  const asFoundation = join(foundationDir, 'package.json')

  return {
    name: 'uniweb:library-imports',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !isBare(source) || !all().length) return null
      const opts = { ...options, skipSelf: true }

      // 2. A library's own name: resolved as the package manager has it, by its exports, then read
      // from its folder.
      const named = all().find((lib) => packageOf(source) === lib.name)
      if (named) {
        const found = await this.resolve(source, importer, opts)
        if (!found || found.external) return found
        const file = found.id.split('?')[0]
        // A pre-bundled dependency is no file of the library's.
        if (!isAbsolute(file) || file.includes(`${sep}.vite${sep}`)) return found
        const there = inLibraryFolder(file, all())
        return there === file ? found : { ...found, id: there + found.id.slice(file.length) }
      }

      // 1. What a library's own file imports.
      const from = importer.split('?')[0]
      if (!isAbsolute(from)) return null
      const at = real(from)
      const lib = all().find((l) => insideOwnFiles(l.dir, at))
      if (!lib) return null
      if (lib.peers.has(packageOf(source))) return this.resolve(source, asFoundation, opts)
      const own = await this.resolve(source, importer, opts)
      if (own) return own
      if (lib.installed && lib.installed !== lib.dir && existsSync(join(lib.installed, 'package.json'))) {
        const besideCopy = await this.resolve(source, join(lib.installed, 'package.json'), opts)
        if (besideCopy) return besideCopy
      }
      return this.resolve(source, asFoundation, opts)
    }
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An `exports` value's file: a string, or the condition a stylesheet resolves by. */
const exportTarget = (value) =>
  typeof value === 'string' ? value : value && typeof value === 'object' ? (value.style ?? value.default ?? value.import ?? null) : null

/**
 * The aliases for rule 2's stylesheets: each library installed as a copy has its stylesheets read
 * from its folder, by its own `exports`. A library the package manager linked needs none.
 *
 * @param {string} foundationDir
 * @returns {Array<{ find: RegExp, replacement: string }>}
 */
export function libraryAliases(foundationDir) {
  const out = []
  for (const lib of librariesFor(foundationDir)) {
    if (!lib.installed || lib.installed === lib.dir) continue
    const name = escape(lib.name)
    const exp = readPackage(lib.dir)?.exports
    if (!exp || typeof exp !== 'object' || Array.isArray(exp)) {
      // No map: a stylesheet is reached by its path.
      out.push({ find: new RegExp(`^${name}/(.+\\.css)$`), replacement: `${lib.dir}/$1` })
      continue
    }
    for (const [key, value] of Object.entries(exp)) {
      const target = exportTarget(value)
      if (!target?.startsWith('./') || !key.startsWith('.')) continue
      const sub = key === '.' ? '' : key.slice(2)
      if (!sub.includes('*')) {
        if (target.endsWith('.css')) out.push({ find: new RegExp(`^${name}${sub ? `/${escape(sub)}` : ''}$`), replacement: join(lib.dir, target) })
      } else if (sub.endsWith('*') && target.endsWith('*')) {
        // `./components/*` → `./components/*`, or `./*` → `./src/*`: what the star matched, in its place.
        const prefix = escape(sub.slice(0, -1))
        out.push({ find: new RegExp(`^${name}/${prefix}(.+\\.css)$`), replacement: `${lib.dir}/${target.slice(2, -1)}$1` })
      }
    }
  }
  return out
}

/**
 * The names a site's dev server must not pre-bundle (rule 3): each library of its foundation.
 *
 * @param {string} foundationDir
 * @returns {string[]}
 */
export function libraryNames(foundationDir) {
  return librariesOf(foundationDir).map((lib) => lib.name)
}
