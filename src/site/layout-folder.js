/**
 * A site's `layout/` folder, read from the site alone.
 *
 * ⭐ DEPTH DECIDES WHAT A FOLDER IS — never the foundation.
 *
 *   layout/<area>.md              a one-section area of the default layout
 *   layout/<name>/                a named layout, always
 *   layout/<name>/<area>.md       a one-section area of that layout
 *   layout/<name>/<area>/         an area with several sections, in filename order
 *   layout/default/               the default layout written as a folder — how it
 *                                 gets an area with several sections
 *
 * ⛔ Why not the foundation. The build used to call a folder a named layout only
 * when the foundation declared a layout by that name, and an area of the default
 * layout otherwise — while the sync producer called every folder a named layout.
 * So `layout/header/1-topbar.md` was the default layout's header on a static build
 * and a layout named `header` once synced. And a site's meaning cannot depend
 * on a foundation the build may not have: a site can link a remote foundation that
 * is nowhere on disk. The runtime, which always has the foundation, is where a
 * layout name is matched to one.
 *
 * ⭐ ONE READER FOR EVERY PRODUCER. The build (`collectLayouts`) and the sync
 * producer (`collectLayoutNested`) both read the folder through this module, so they
 * cannot disagree about what it holds again.
 *
 * An area is a CONTAINER OF SECTIONS, not a page: it has no `page.yml`, its sections
 * are ordered by filename prefix and bind their own data, and none of them nests
 * another (nesting is configured in a `page.yml`, which an area does not have).
 *
 * @module @uniweb/build/site/layout-folder
 */

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, parse, relative } from 'node:path'
import { parseNumericPrefix, compareByNumericPrefix } from '../utils/numeric-prefix.js'
import { isMarkdownFile, isIgnoredFolder } from '../utils/content-files.js'
import { layoutNameKey } from '@uniweb/core/layout-name'

/** The key the default layout's areas are held under, on every lane. */
export const DEFAULT_LAYOUT = 'default'

/**
 * The route a layout area renders at — `/layout/<area>` in the default layout,
 * `/layout/<layout>/<area>` in a named one. A layout area's free-form translations are
 * addressed by it (`i18n/freeform.js`), so the build, the push and the pull must all use
 * this one rule: the push said "layout sections have no free-form home" until 2026-09-26,
 * and a translation the build rendered never left the author's machine.
 *
 * @param {string} [layoutName]
 * @param {string} area
 * @returns {string}
 */
export function layoutAreaRoute(layoutName, area) {
  return !layoutName || layoutName === DEFAULT_LAYOUT ? `/layout/${area}` : `/layout/${layoutName}/${area}`
}

/**
 * Area names a layout folder is most likely to have been meant as. A folder under
 * `layout/` named like one of them was, before this convention, an area of the
 * default layout — and the public docs taught `layout/header/header.md` that way.
 */
const CONVENTIONAL_AREAS = new Set(['header', 'footer', 'left', 'right'])

/** Files that configure a page, which nothing in a layout folder is. */
const PAGE_CONFIG_FILES = new Set(['page.yml', 'page.yaml', 'folder.yml', 'folder.yaml'])

/**
 * Order section files the way a page orders its sections — the collector's one
 * numeric-prefix rule (`1`, `1.5`, `2`, …), never a second copy of it.
 */
function compareSectionFiles(a, b) {
  return compareByNumericPrefix(parse(a).name, parse(b).name)
}

const warned = new Set()

/** Test seam — reset the once-per-folder warning memo. */
export function _resetLayoutFolderWarnings() {
  warned.clear()
}

/**
 * Every area a site's `layout/` folder declares.
 *
 * @param {string} layoutDir - the site's layout directory (`layout/`, or `paths.layout`)
 * @param {Object} [options]
 * @param {string} [options.siteRoot] - for the paths named in messages
 * @param {(message: string) => void} [options.onWarning]
 * @returns {Promise<Array<{ layout: string, area: string, form: 'file'|'folder', dir: string, files: string[], source: string }>>}
 *   one entry per area, in a stable order: the default layout's areas first, then
 *   each named layout's, by folder name. `files` are the area's section files, in
 *   section order; `source` is the area's path, relative, for messages.
 * @throws when the folder declares something no lane can read the same way
 */
export async function readLayoutFolder(layoutDir, { siteRoot = null, onWarning = (m) => console.warn(m) } = {}) {
  if (!layoutDir || !existsSync(layoutDir)) return []

  const base = siteRoot || dirname(layoutDir)
  const shown = (path) => relative(base, path) || '.'
  const fail = (path, message) => {
    throw new Error(`[uniweb] ${shown(path)}: ${message}`)
  }

  const areas = []
  const byKey = new Map() // `<layout name key>/<area>` → source

  const add = (entry) => {
    const key = `${layoutNameKey(entry.layout)}/${entry.area}`
    const other = byKey.get(key)
    if (other) {
      throw new Error(
        `[uniweb] ${other} and ${entry.source} both declare the \`${entry.area}\` area of the ` +
          `${entry.layout === DEFAULT_LAYOUT ? 'default layout' : `\`${entry.layout}\` layout`}. ` +
          'An area has one source — keep one of them.'
      )
    }
    byKey.set(key, entry.source)
    areas.push(entry)
  }

  const refusePageConfig = (dir, name) => {
    if (PAGE_CONFIG_FILES.has(name.toLowerCase())) {
      fail(
        join(dir, name),
        'a layout folder holds no page.yml or folder.yml. A layout area is a container of sections: ' +
          'its sections are ordered by filename prefix (1-topbar.md, 2-navbar.md) and each binds its own data.'
      )
    }
  }

  const refuseChild = (dir, name) => {
    if (name.startsWith('@')) {
      fail(
        join(dir, name),
        'a layout area has no child sections. Nesting is configured in a page.yml, which an area does not ' +
          'have — give the section its own file.'
      )
    }
  }

  /** The areas inside one layout's folder (the root folder is the default layout's). */
  const readAreas = async (layoutName, dir, { isRoot }) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))

    const files = []
    const folders = []
    for (const entry of entries) {
      if (entry.isFile()) {
        refusePageConfig(dir, entry.name)
        if (!isMarkdownFile(entry.name)) continue
        refuseChild(dir, entry.name)
        files.push(entry.name)
      } else if (entry.isDirectory() && !isIgnoredFolder(entry.name)) {
        folders.push(entry.name)
      }
    }

    for (const file of files.sort(compareSectionFiles)) {
      const area = parseNumericPrefix(parse(file).name).name
      add({ layout: layoutName, area, form: 'file', dir, files: [file], source: shown(join(dir, file)) })
    }

    // In the root folder, a folder is a named layout — handled by the caller.
    if (isRoot) return folders

    for (const folder of folders) {
      const areaDir = join(dir, folder)
      const area = parseNumericPrefix(folder).name
      const sectionFiles = []
      for (const entry of await readdir(areaDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          refusePageConfig(areaDir, entry.name)
          if (!isMarkdownFile(entry.name)) continue
          refuseChild(areaDir, entry.name)
          sectionFiles.push(entry.name)
        } else if (entry.isDirectory() && !isIgnoredFolder(entry.name)) {
          const nested = (await readdir(join(areaDir, entry.name))).filter(isMarkdownFile)
          if (nested.length > 0) {
            fail(
              join(areaDir, entry.name),
              'nothing nests inside a layout area. An area is `layout/<layout>/<area>/` holding its section files.'
            )
          }
        }
      }
      if (sectionFiles.length === 0) continue
      add({
        layout: layoutName,
        area,
        form: 'folder',
        dir: areaDir,
        files: sectionFiles.sort(compareSectionFiles),
        source: shown(areaDir),
      })
    }
    return []
  }

  const layoutFolders = await readAreas(DEFAULT_LAYOUT, layoutDir, { isRoot: true })

  // Each folder directly under layout/ is a named layout; `default` (in any case, with
  // or without a trailing `Layout`) is the default layout written as a folder.
  // ⭐ Names compare as the runtime compares them (`@uniweb/core/layout-name`): `docs`
  // is the foundation's `DocsLayout`, so the folder need not repeat the suffix.
  const seenNames = new Map() // layout name key → as written
  for (const folder of layoutFolders) {
    const lower = folder.toLowerCase()
    const key = layoutNameKey(folder)
    const earlier = seenNames.get(key)
    if (earlier) {
      fail(
        join(layoutDir, folder),
        `\`${earlier}\` and \`${folder}\` name one layout — layout names match regardless of case and of a ` +
          'trailing `Layout`. Keep one folder.'
      )
    }
    seenNames.set(key, folder)

    const layoutName = key === DEFAULT_LAYOUT ? DEFAULT_LAYOUT : folder
    if (layoutName !== DEFAULT_LAYOUT && CONVENTIONAL_AREAS.has(lower)) {
      const memo = `${layoutDir}/${folder}`
      if (!warned.has(memo)) {
        warned.add(memo)
        onWarning(
          `[uniweb] ${shown(join(layoutDir, folder))}/ is the layout named \`${folder}\`, not the default layout's ` +
            `\`${lower}\` area. For that area write \`${shown(join(layoutDir, `${lower}.md`))}\` — or ` +
            `\`${shown(join(layoutDir, DEFAULT_LAYOUT, lower))}/\` for an area with several sections.`
        )
      }
    }
    await readAreas(layoutName, join(layoutDir, folder), { isRoot: false })
  }

  return areas
}
