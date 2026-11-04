/**
 * Freezing a site's docs as a version: `uniweb add version v2`.
 *
 * The docs stay where they are, at their URLs. A copy goes into a folder named `v2` beside them, and
 * from then on it is an ordinary folder of pages at its own URL (`@uniweb/projections/versions`).
 * What makes this more than `cp -R` is what a copy gets wrong:
 *
 * - **Page ids.** An id is unique across a site, and it's how a `page:` link finds its page, so a
 *   copy that keeps them makes every such link an accident of page order. A frozen copy never moves,
 *   which is what an id is for, so it gets none. The app mints its own for a page it receives.
 * - **Links.** A link into the pages being copied must lead to the copy, or an old version's pages
 *   send a reader to the latest with nothing to say so. Each becomes a path into the copy. A relative
 *   link inside the copy already works, and one that leaves it needs one more `../`.
 * - **Search engines.** An older version is kept out of them, so a search sends people to the latest.
 *
 * ⛔ Text, not a parse. These are an author's files, and a parse and a print would drop their
 * comments and reflow them. A code sample that reads `[a](page:b)` is words about a link, as it is to
 * the sync (`uwx/page-refs.js`); a tagged data block (`yaml:nav`) is content, and its links count.
 *
 * Nothing is written until the whole copy is planned, so a refusal leaves no trace.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve, relative } from 'node:path'
import yaml from 'js-yaml'
import { isVersionFolder } from '@uniweb/projections/versions'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { collectSiteContent, mountEntriesOf, readFolderConfig, readYamlFile, rootOrderConfig } from './content-collector.js'
import { parseNumericPrefix } from '../utils/numeric-prefix.js'

const routeKey = (route) => String(route).replace(/^\/+/, '').replace(/\/+$/, '')
const CONFIG_FILES = new Set(['page.yml', 'folder.yml'])
// What of the docs folder's own config still describes the copy. The rest names the folder itself.
const CARRIED_KEYS = ['pages', 'sections', 'nest', 'redirect']

// A page's name in a route: its folder's or file's, less the number that orders it (`2-guide` is `guide`).
const pageNameOf = (entry) => parseNumericPrefix(entry).name || entry

/**
 * The folder holding a route's pages, as a path under `pages/` — each segment the folder whose page
 * name it is, a mount's key where the first one is a mount — or null where no folder holds it.
 */
function folderOfRoute(segments, { pagesDir, mounts }) {
  const named = (dir, segment) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && (e.name === segment || pageNameOf(e.name) === segment))?.name ?? null
    } catch {
      return null
    }
  }
  const out = []
  let dir = pagesDir
  for (const [i, segment] of segments.entries()) {
    if (i === 0 && mounts.has(segment)) {
      out.push(segment)
      dir = mounts.get(segment)
      continue
    }
    const hit = named(dir, segment)
    if (!hit) return null
    out.push(hit)
    dir = join(dir, hit)
  }
  return out.join('/')
}

/**
 * The folder holding the docs, as a path under `pages/`.
 *
 * Named, or the one that already holds versions, or `docs`. Refused rather than guessed otherwise.
 */
function findFolder(named, { pages, pagesDir, mounts, homepage }) {
  if (named !== undefined && named !== null) {
    const clean = routeKey(String(named).replace(/^\.\/?/, '').replace(/^pages(\/|$)/, ''))
    if (clean.split('/').some(isVersionFolder)) {
      throw new Error(`"${named}" is a version. Name the folder that holds the versions.`)
    }
    return clean
  }

  const holding = new Set()
  for (const { route } of pages) {
    const segments = route.split('/').filter(Boolean)
    const at = segments.findIndex(isVersionFolder)
    if (at === -1) continue
    const above = segments.slice(0, at)
    // A homepage's own pages sit at the root, so a version there is in the homepage's folder.
    const inHomepage = !above.length && homepage && folderOfRoute([homepage, segments[0]], { pagesDir, mounts })
    const folder = inHomepage ? folderOfRoute([homepage], { pagesDir, mounts }) : folderOfRoute(above, { pagesDir, mounts })
    holding.add(folder ?? (inHomepage ? homepage : above.join('/')))
  }
  if (holding.size === 1) return [...holding][0]
  if (holding.size > 1) {
    throw new Error(
      `More than one folder holds versions: ${[...holding].map((f) => f || '.').join(', ')}. Say which with --in <folder>.`
    )
  }
  if (mounts.has('docs') || existsSync(join(pagesDir, 'docs'))) return 'docs'
  throw new Error('Say which folder holds the docs with --in <folder>, or --in . for the whole site.')
}

/** One link's new address, or null if it leads nowhere the copy changes. */
function linkRewriter({ routes, ids }) {
  const count = { links: 0 }
  const rewrite = (dest) => {
    const cut = dest.search(/[#?]/)
    const [path, tail] = cut === -1 ? [dest, ''] : [dest.slice(0, cut), dest.slice(cut)]
    if (path.startsWith('page:')) {
      const name = path.slice('page:'.length)
      const to = ids.get(name) ?? routes.get(routeKey(name))
      if (to === undefined) return null
      count.links++
      return `page:${routeKey(to)}${tail}`
    }
    if (path.startsWith('/')) {
      const to = routes.get(routeKey(path))
      if (to === undefined) return null
      count.links++
      return `${to}${tail}`
    }
    return null
  }
  return { rewrite, count }
}

/** A relative link that leaves the copied tree, or enters another version, is one level further now. */
function deeperLink(dest, fileDir) {
  if (!/^\.\.?\//.test(dest)) return null
  const target = posix.normalize(posix.join(fileDir, dest))
  const first = target.split('/')[0]
  return first === '..' || isVersionFolder(first) ? `../${dest}` : null
}

/** One line's links, outside its code spans. */
function rewriteInline(line, { rewrite, count }, fileDir) {
  const replaceLinks = (text) =>
    text.replace(/(\]\(\s*<?)([^)\s>]+)/g, (whole, open, dest) => {
      const next = rewrite(dest) ?? deeperLink(dest, fileDir)
      if (next === null) return whole
      if (!dest.startsWith('page:') && !dest.startsWith('/')) count.links++
      return `${open}${next}`
    })

  let out = ''
  let at = 0
  while (at < line.length) {
    const tick = line.indexOf('`', at)
    if (tick === -1) break
    let run = tick
    while (line[run] === '`') run++
    const fence = line.slice(tick, run)
    let close = line.indexOf(fence, run)
    while (close !== -1 && (line[close - 1] === '`' || line[close + fence.length] === '`')) {
      close = line.indexOf(fence, close + 1)
    }
    out += replaceLinks(line.slice(at, tick))
    if (close === -1) {
      out += fence
      at = run
    } else {
      out += line.slice(tick, close + fence.length)
      at = close + fence.length
    }
  }
  return out + replaceLinks(line.slice(at))
}

/** A line of YAML whose whole value is an address: `link: page:guide`, `- /docs/guide`. */
function rewriteYamlLine(line, { rewrite }) {
  const match = line.match(/^(\s*(?:-\s+)?(?:[\w.-]+:\s+)?)(['"]?)((?:page:|\/)[^'"\s]*)\2(\s*(?:#.*)?)$/)
  if (!match) return line
  const [, lead, quote, dest, rest] = match
  const next = rewrite(dest)
  return next === null ? line : `${lead}${quote}${next}${quote}${rest}`
}

/** JSON strings that are an address. */
function rewriteJsonLine(line, { rewrite }) {
  return line.replace(/"((?:page:|\/)[^"\s]*)"/g, (whole, dest) => {
    const next = rewrite(dest)
    return next === null ? whole : `"${next}"`
  })
}

/** A markdown file: its frontmatter's addresses, and its links outside of code. */
function rewriteMarkdown(text, links, fileDir) {
  const lines = text.split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) lines[i] = rewriteYamlLine(lines[i], links)
    i++
  }
  let fence = null
  for (; i < lines.length; i++) {
    const opens = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/)
    if (fence) {
      const closes = opens && opens[1][0] === fence.mark[0] && opens[1].length >= fence.mark.length && !opens[2]
      if (closes) fence = null
      else if (fence.kind === 'yaml') lines[i] = rewriteYamlLine(lines[i], links)
      else if (fence.kind === 'json') lines[i] = rewriteJsonLine(lines[i], links)
      else if (fence.kind === 'md') lines[i] = rewriteInline(lines[i], links, fileDir)
    } else if (opens) {
      // A tagged block holds content; any other fence holds a sample, and is left as written.
      const tagged = opens[2].match(/^(yaml|yml|json|md):/)
      fence = { mark: opens[1], kind: tagged ? tagged[1].replace('yml', 'yaml') : null }
    } else {
      lines[i] = rewriteInline(lines[i], links, fileDir)
    }
  }
  return lines.join('\n')
}

/** A page's config: no id, and its addresses into the copy. */
function rewriteConfig(text, links) {
  const lines = text.split('\n').filter((line) => !/^id\s*:/.test(line))
  return lines.map((line) => rewriteYamlLine(line, links)).join('\n')
}

/** `seo: { noindex: true }` added to a page's config, for a page a folder's can't speak for. */
function withNoindex(text) {
  const parsed = yaml.load(text, YAML_OPTIONS) || {}
  if (parsed.seo?.noindex === true) return text
  if (/^seo\s*:\s*$/m.test(text)) return text.replace(/^seo\s*:\s*$/m, 'seo:\n  noindex: true')
  if (parsed.seo) return yaml.dump({ ...parsed, seo: { ...parsed.seo, noindex: true } })
  return `${text.replace(/\n*$/, '\n')}seo:\n  noindex: true\n`
}

/** Every file below a folder, as paths relative to it. The folder's own versions stay out. */
async function filesBelow(dir, { top = false, base = '' } = {}) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory())
    if (isDirectory) {
      if (top && isVersionFolder(entry.name)) continue
      files.push(...(await filesBelow(join(dir, entry.name), { base: rel })))
    } else if (!(top && CONFIG_FILES.has(entry.name))) {
      files.push(rel)
    }
  }
  return files
}

/**
 * Freeze the docs in a folder as a version beside them.
 *
 * @param {string} siteRoot
 * @param {Object} options
 * @param {string} options.name - the version's folder name: `v2`, `v2.1`
 * @param {string} [options.folder] - the folder holding the docs, under `pages/`; `.` for all of it
 * @param {string} [options.label] - what a version switcher calls it (default: the name)
 * @param {boolean} [options.keepInSearch=false] - leave it open to search engines
 * @param {boolean} [options.dryRun=false] - say what would happen, and write nothing
 * @returns {Promise<Object>} what it did: `{ name, folder, path, route, url, pages, files, ids, links, notes }`
 */
export async function addVersion(siteRoot, { name, folder: named, label, keepInSearch = false, dryRun = false } = {}) {
  if (!isVersionFolder(name)) {
    const bare = /^\d/.test(String(name)) ? ` Did you mean v${name}?` : ''
    throw new Error(`"${name}" isn't a version's name. It's a "v" and a number: v2, v2.1.${bare}`)
  }

  const site = await readYamlFile(join(siteRoot, 'site.yml'))
  const pagesDir = resolve(siteRoot, site.paths?.pages ?? 'pages')
  const mounts = new Map(mountEntriesOf(site.paths).map(([key, value]) => [key, resolve(siteRoot, value)]))
  const { config: rootConfig } = await readFolderConfig(pagesDir, 'sections')
  const homepage = rootOrderConfig(site, rootConfig).homepage
  const { pages } = await collectSiteContent(siteRoot)

  const folder = findFolder(named, { pages, pagesDir, mounts, homepage })
  const segments = folder ? folder.split('/') : []
  const dir = mounts.has(segments[0])
    ? join(mounts.get(segments[0]), ...segments.slice(1))
    : join(pagesDir, ...segments)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`There's no folder pages/${folder}.`)
  }
  const target = join(dir, name)
  if (existsSync(target)) {
    throw new Error(`pages/${posix.join(folder, name)} already exists. To freeze the docs again, name a new version.`)
  }

  // Where the folder's pages are, by their names as pages. A folder promoted to the homepage puts its
  // pages at the root.
  const routeSegments = segments.map(pageNameOf)
  const isHomepage = routeSegments[0] === homepage
  const scope = `/${(isHomepage ? routeSegments.slice(1) : routeSegments).join('/')}`
  const prefix = scope === '/' ? '' : scope
  const versionRoute = `${prefix}/${name}`
  const names = new Set(
    (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.name.endsWith('.md'))
      .map((entry) => pageNameOf(entry.name.replace(/\.md$/, '')))
      .filter((entry) => !isVersionFolder(entry) && !(folder === '' && entry === '404'))
  )

  // Every page being copied: where it is, and where its copy will be.
  const copied = []
  const routes = new Map()
  const ids = new Map()
  for (const page of pages) {
    const from = page.sourcePath || page.route
    let rest
    if (scope === '/') rest = from === '/' || (isHomepage && from === `/${homepage}`) ? '' : from
    else if (from === scope) rest = ''
    else if (from.startsWith(`${scope}/`)) rest = from.slice(scope.length)
    else continue
    const first = rest.split('/').filter(Boolean)[0]
    if (first && !names.has(first)) {
      // A homepage's own pages sit at the root, and in the copy under its folder, like any other's.
      if (scope !== '/' || !names.has(homepage)) continue
      rest = `/${homepage}${rest}`
    }
    if (!first && page.route !== scope && !(isHomepage && from === `/${homepage}`)) continue
    const to = `${versionRoute}${rest}`
    copied.push({ page, to })
    routes.set(routeKey(page.route), to)
    routes.set(routeKey(from), to)
    if (page.id !== null && page.id !== undefined && page.id !== '') ids.set(String(page.id), to)
  }

  const links = linkRewriter({ routes, ids })
  const { config: ownConfig, mode } = await readFolderConfig(dir, 'sections')
  const files = await filesBelow(dir, { top: true })
  const hasOwnContent = mode !== 'pages' && files.some((file) => !file.includes('/') && file.endsWith('.md'))

  // The copy, planned in full: text for what changes, a source for what doesn't.
  const plan = []
  let idsDropped = 0
  for (const file of files) {
    const from = join(dir, file)
    const to = join(target, file)
    const base = posix.basename(file)
    if (CONFIG_FILES.has(base)) {
      const original = await readFile(from, 'utf8')
      if (/^id\s*:/m.test(original)) idsDropped++
      let text = rewriteConfig(original, links)
      // A folder with content speaks only for itself, so here each page has to say it.
      if (hasOwnContent && !keepInSearch && base === 'page.yml') text = withNoindex(text)
      plan.push({ to, text })
    } else if (base.endsWith('.md')) {
      plan.push({ to, text: rewriteMarkdown(await readFile(from, 'utf8'), links, posix.dirname(file)) })
    } else {
      plan.push({ to, from })
    }
  }

  // The version's own page: what a switcher calls it, and how far search engines go.
  const own = { title: label || name }
  if (!keepInSearch) own.seo = { noindex: true }
  for (const key of CARRIED_KEYS) {
    if (ownConfig[key] === undefined) continue
    own[key] =
      key === 'pages' && Array.isArray(ownConfig.pages)
        ? ownConfig.pages.filter((entry) => !isVersionFolder(entry))
        : ownConfig[key]
  }
  if (typeof own.redirect === 'string') own.redirect = links.rewrite(own.redirect) ?? own.redirect
  if (Array.isArray(own.pages) && !own.pages.length) delete own.pages
  plan.push({ to: join(target, mode === 'pages' ? 'folder.yml' : 'page.yml'), text: yaml.dump(own, { lineWidth: -1 }) })

  // Translations written by hand are kept by route or by id, and the copy has only a route.
  const notes = []
  const freeformRoot = join(resolve(siteRoot, site.paths?.locales ?? 'locales'), 'freeform')
  if (existsSync(freeformRoot)) {
    for (const locale of await readdir(freeformRoot, { withFileTypes: true })) {
      if (!locale.isDirectory()) continue
      const root = join(freeformRoot, locale.name)
      for (const { page, to } of copied) {
        const sources = [
          page.id ? join(root, 'page-ids', String(page.id)) : null,
          join(root, 'pages', routeKey(page.route)),
        ].filter((source) => source && existsSync(source))
        const seen = new Set()
        for (const source of sources) {
          for (const entry of await readdir(source, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.md') || seen.has(entry.name)) continue
            seen.add(entry.name)
            const text = rewriteMarkdown(await readFile(join(source, entry.name), 'utf8'), links, '.')
            plan.push({ to: join(root, 'pages', routeKey(to), entry.name), text })
          }
        }
      }
    }
  }

  if (mounts.has(segments[0])) {
    notes.push(`pages/${segments[0]} is mounted from ${relative(siteRoot, mounts.get(segments[0]))}, so the copy went there.`)
  }
  if (hasOwnContent && !keepInSearch) {
    notes.push(
      `pages/${folder} has content of its own, so its noindex can't speak for the pages below it. Each copied page.yml says it, and a page added to this version later needs to as well.`
    )
  }

  if (!dryRun) {
    try {
      for (const { to, text, from } of plan) {
        await mkdir(dirname(to), { recursive: true })
        if (from) await copyFile(from, to)
        else await writeFile(to, text)
      }
    } catch (err) {
      await rm(target, { recursive: true, force: true })
      throw err
    }
  }

  return {
    name,
    folder,
    path: relative(siteRoot, target),
    route: versionRoute,
    pages: copied.filter(({ page }) => page.hasContent !== false).length,
    files: plan.length,
    ids: idsDropped,
    links: links.count.links,
    keptOutOfSearch: !keepInSearch,
    notes,
  }
}
