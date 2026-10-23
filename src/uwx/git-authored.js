// The pages a pull leaves alone: those authored in files a pull cannot write back.
//
// ⭐ Two kinds, decided 2026-10-23 [Diego: the pull leaves them alone, since the docs are written in
// git]. A push sends both whole, read by the build's own rules (`site.js`), so the backend holds
// the site as the build makes it. A pull writes neither:
//
//   · every page under a `paths: { pages/<segment>: <dir> }` mount. Its files are another
//     repository's, outside the site; the local folder of that name holds only how this site
//     presents them, and a pull writing the mounted pages into it would grow a second copy there.
//   · every `.md` page of a folder-mode folder. The file IS the page, and a pull writes a page as a
//     folder (`page.yml` + its sections), which would turn the author's folder of pages into a
//     folder of page folders.
//
// ⇒ An edit made to one of these pages in the app is not brought back, and the next push replaces
// it with the file. Pruning skips them too: a pull never deletes what it does not write.
//
// A leaf module, read synchronously as the pull projects (`site-project.js`), through the build's
// mode rule (`folderContentMode`) and its folder-mode page list (`folderModePageFiles`), so the set
// is the one the push walks.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { isIgnoredFolder } from '../utils/content-files.js'
import { folderContentMode, folderModePageFiles, mountEntriesOf, parseNumericPrefix } from '../site/content-collector.js'

const DYNAMIC_RE = /^\[(.+)\]$/

// The collector's own reading of a config file (`parseYaml`): absent or unreadable is empty.
function readYaml(filePath) {
  try {
    return yaml.load(readFileSync(filePath, 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return {}
  }
}

// A folder's mode, as `readFolderConfig` reads it.
function modeOf(dir, inheritedMode) {
  const folderYml = readYaml(join(dir, 'folder.yml'))
  const pageYml = Object.keys(folderYml).length > 0 ? {} : readYaml(join(dir, 'page.yml'))
  return folderContentMode(folderYml, pageYml, existsSync(join(dir, 'folder.yml')), inheritedMode).mode
}

/**
 * The pages of a site a pull leaves alone, by route: each a slug path with no leading slash
 * (`docs/start/install`), as the pull composes a page's route from the document.
 *
 * @param {object|null} siteYml - the parsed `site.yml`
 * @param {string} pagesDir - the site's pages directory (`siteContentDirs`)
 * @returns {{ mounted: Set<string>, files: Set<string>, has: (route: string) => boolean }}
 *   `mounted` — the mounted segments, each leaving its whole route alone; `files` — the routes of
 *   folder-mode `.md` pages; `has` — whether a route is either
 */
export function gitAuthoredPages(siteYml, pagesDir) {
  const mounted = new Set(mountEntriesOf(siteYml?.paths).map(([segment]) => segment))
  const files = new Set()
  const walk = (dir, prefix, inheritedMode) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const mode = modeOf(dir, inheritedMode)
    if (mode === 'pages') {
      for (const { name } of folderModePageFiles(entries.map((e) => e.name)).files) {
        files.add(prefix + name)
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || isIgnoredFolder(e.name)) continue
      if (!prefix && mounted.has(e.name)) continue // the whole route is left alone
      const dyn = e.name.match(DYNAMIC_RE)
      walk(join(dir, e.name), `${prefix}${dyn ? dyn[1] : parseNumericPrefix(e.name).name}/`, mode)
    }
  }
  if (existsSync(pagesDir)) walk(pagesDir, '', 'sections')
  return {
    mounted,
    files,
    has: (route) => mounted.has(String(route).split('/')[0]) || files.has(route),
  }
}
