/**
 * ⭐ A LIBRARY OUTSIDE THE WORKSPACE'S FOLDER RESOLVES WHAT IT IMPORTS AS THE FOUNDATION THAT BUNDLES
 * IT. A library is any local package a foundation depends on (`librariesOf`), and one may be a folder
 * beside the workspace, another repository's say. The workspace lists it (`uniweb add library
 * ../acme-shared` writes it into `pnpm-workspace.yaml` and `package.json` `workspaces`), so the
 * package manager links its folder and the build reads the files its developer edits. pnpm also
 * installs its dependencies in its folder; npm hoists them to the workspace's root `node_modules`,
 * which Node never looks in from a folder outside the workspace's. ⛔ Until 2026-11-10 a foundation
 * build under npm stopped there: `Rollup failed to resolve import "@uniweb/kit"` from the library.
 *
 * So whatever builds a foundation's source (its build, its SSR bundle, a site's build and dev
 * server) resolves a bare import from such a library's own file:
 *   - its `peerDependencies` from the foundation, which provides them: one React, one kit;
 *   - anything else from the library's own install first, then from the foundation's.
 *
 * A library inside the workspace's folder reaches the workspace's installs on its own, so this leaves
 * it alone, and nothing changes for one: measured 2026-11-10, byte-identical builds with and without.
 * A library the package manager copied instead of linking is said by `copiedLibraries`.
 *
 * @module @uniweb/build/foundation/library-imports
 */

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { librariesOf } from './libraries.js'
import { workspaceRootOf } from '../site/workspace-extension.js'

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

/** `path` at or inside `dir`. */
const within = (dir, path) => {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** `file` inside `dir`, and not in a `node_modules` under it. */
const insideOwnFiles = (dir, file) => within(dir, file) && !relative(dir, file).split(sep).includes('node_modules')

/**
 * The libraries a foundation bundles whose folders are outside its workspace's folder (or, with no
 * workspace, outside the foundation's), each with its peers.
 *
 * @param {string} foundationDir
 * @returns {Array<{ name: string, dir: string, peers: Set<string> }>}
 */
export function librariesOutside(foundationDir) {
  const root = real(workspaceRootOf(foundationDir) || foundationDir)
  return librariesOf(foundationDir)
    .filter((lib) => !within(root, lib.dir))
    .map((lib) => ({ ...lib, peers: new Set(Object.keys(readPackage(lib.dir)?.peerDependencies || {})) }))
}

/**
 * The Vite plugin, for one foundation's libraries outside its workspace's folder. With none, it
 * resolves nothing.
 *
 * @param {{ foundationDir: string }} options - the foundation whose libraries these are
 * @returns {import('vite').Plugin}
 */
export function libraryImports({ foundationDir }) {
  let outside = null
  const all = () => (outside ??= librariesOutside(foundationDir))
  const asFoundation = join(foundationDir, 'package.json')

  return {
    name: 'uniweb:library-imports',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !isBare(source) || !all().length) return null
      const from = importer.split('?')[0]
      if (!isAbsolute(from)) return null
      const at = real(from)
      const lib = all().find((l) => insideOwnFiles(l.dir, at))
      if (!lib) return null
      const opts = { ...options, skipSelf: true }
      if (lib.peers.has(packageOf(source))) return this.resolve(source, asFoundation, opts)
      return (await this.resolve(source, importer, opts)) ?? this.resolve(source, asFoundation, opts)
    }
  }
}
