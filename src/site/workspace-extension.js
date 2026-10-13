/**
 * Where a site finds a WORKSPACE extension — the one rule, asked by every lane.
 *
 * A site declares a workspace extension by the URL it serves it at
 * (`extensions: ['/effects/entry.js']`) or by name (`extensions: [effects]`).
 * Either way the extension's name is `effects`, and this module answers which
 * folder of the workspace holds it. Each lane that needs that answer asks here:
 * the site build, which copies the extension's build into the site's output
 * (`emit-extensions.js`); prerender, which imports it (`../prerender.js`); the
 * dev server, which serves it (`plugin.js`); and the CLI — `add extension`
 * deciding whether a site can load what it just made, `doctor`, and `push` /
 * `publish` bringing a named extension along.
 *
 * ── The rule ──
 *
 * The extension named `<name>` is the nearest `<name>/` or `extensions/<name>/`
 * that is a foundation package — looking first in the folder the site is in,
 * then in each folder above it, up to the workspace root:
 *
 *   project/                     ← the workspace root (pnpm-workspace.yaml)
 *   ├── extensions/effects/      ← what sites/main loads as /effects/entry.js
 *   ├── sites/main/
 *   └── docs/
 *       ├── effects/             ← what docs/site loads: it is nearer
 *       └── site/
 *
 * ── Why each part ──
 *
 * - **Nearest first**, so a co-located project can keep its own extension under
 *   a name a shared one also has — the way a nearer `node_modules` wins.
 * - **Up to the workspace root and no further** — the folder holding
 *   `pnpm-workspace.yaml`, or a `package.json` that lists `workspaces`, the same
 *   marker the CLI finds a workspace by. A folder outside the project is never
 *   part of it, and a site in no workspace looks only in the folder it is in.
 * - **A foundation package, not any folder of that name** (`classifyPackage`):
 *   an extension is a foundation. A built SITE named `effects` has a `dist/` as
 *   well, and the more folders the search visits, the likelier a same-named one
 *   that is not the extension.
 *
 * ⛔ Until 2026-10-13 the build looked only in the folder the site is in, and
 * `add extension` judged an extension reachable from the workspace root — so a
 * site at `sites/main` was wired to `extensions/effects`, which its build then
 * could not find. The rule was written three times — this lookup, `add`'s check
 * and `doctor`'s parsing of the URL — and they disagreed. It is written once now.
 *
 * Node built-ins only, beside the leaf classifier, so any lane can import it
 * without pulling in Vite.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { classifyPackage } from '../utils/classify-package.js'
import { stripBasePath } from './extension-urls.js'

/** A folder holding a workspace manifest — what the CLI finds a workspace by. */
function isWorkspaceRoot(dir) {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    return Array.isArray(JSON.parse(readFileSync(pkgPath, 'utf8')).workspaces)
  } catch {
    return false
  }
}

/** One folder name — never a path, so a declaration cannot walk the search out of a folder. */
function isExtensionName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name)
}

/**
 * The folders a site searches for a workspace extension, nearest first.
 *
 * @param {string} fromDir - the folder the site is in
 * @returns {string[]} `fromDir`, then each folder above it up to and including
 *   the workspace root — or `fromDir` alone when no workspace holds it
 */
export function extensionSearchDirs(fromDir) {
  const start = resolve(fromDir)
  const dirs = []
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir)
    if (isWorkspaceRoot(dir)) return dirs
    if (dirname(dir) === dir) return [start]
  }
}

/**
 * Every folder that could hold the extension named `name`, in the order they are
 * tried — for a message that says where the build looked.
 *
 * @param {string} name - the extension's name: its folder, and its URL's first segment
 * @param {string} fromDir - the folder the site is in
 * @returns {string[]}
 */
export function extensionCandidates(name, fromDir) {
  if (!isExtensionName(name)) return []
  return extensionSearchDirs(fromDir).flatMap((dir) => [join(dir, name), join(dir, 'extensions', name)])
}

/**
 * The folder of the workspace extension named `name`, or null.
 *
 * @param {string} name
 * @param {string} fromDir - the folder the site is in
 * @returns {string|null} an absolute package folder; built or not — the caller
 *   that needs its `dist/` checks for it, so "not built" is never reported as
 *   "not found"
 */
export function findExtensionPackage(name, fromDir) {
  for (const candidate of extensionCandidates(name, fromDir)) {
    if (existsSync(candidate) && classifyPackage(candidate) === 'foundation') return candidate
  }
  return null
}

/**
 * {@link findExtensionPackage} for a site named by its own folder.
 *
 * @param {string} name
 * @param {string} siteDir - the site's folder
 * @returns {string|null}
 */
export function findSiteExtension(name, siteDir) {
  return findExtensionPackage(name, dirname(resolve(siteDir)))
}

/**
 * The extension name a site-relative URL refers to: its first segment, once the
 * deployment base is removed (`/docs/effects/entry.js` at base `/docs/` → `effects`).
 *
 * @param {string} url - a site-relative URL, as declared or as the payload carries it
 * @param {string} [base] - the site's deployment base
 * @returns {{ name: string, rest: string } | null} null when the URL names no file inside a folder
 */
export function extensionNameOf(url, base) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null
  const parts = stripBasePath(url, base).replace(/^\//, '').split(/[?#]/)[0].split('/')
  if (parts.length < 2 || !isExtensionName(parts[0])) return null
  return { name: parts[0], rest: parts.slice(1).join('/') }
}
