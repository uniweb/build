/**
 * ⭐ A LINK WRITTEN AS A FILE MEANS THE PAGE THAT FILE BECAME.
 *
 * Docs kept in a repo link to each other by file, `./deploying.md#setup`, because that is what
 * works on GitHub and in an editor. Mounted into a site those files become pages, and a browser
 * took the link as written, to `/docs/deploying.md` and a "Page not found". Nothing said so: a
 * build, doctor and a link checker all read a path and saw a path.
 *
 * So each is rewritten here to the address an author would write by hand, at build and at push,
 * since this is the one place that knows which file became which page. It costs a site nothing at
 * render. A file link that leads to no page stays as written and is named, which is the only moment
 * anyone can be told about it.
 *
 * The anchor is translated too. A link written for GitHub names GitHub's anchor for a heading, and a
 * page's heading has its own (`headingId`, `@uniweb/kit`): "it doesn't — matter" is
 * `it-doesnt--matter` on one and `it-doesn-t-matter` on the other.
 *
 * ⭐ AND A PULL PUTS EACH ONE BACK AS THE FILE WROTE IT (`fileLinksIn`). ⛔ Until 2026-11-04 a pull wrote
 * the backend's page link into the file in its place, so every file of a docs folder linking another
 * by file read as changed and came back with `/docs/...` links, which lead nowhere on GitHub: 68 of the
 * framework's own docs, measured that day, the first time a pull wrote into a mounted docs folder.
 */
import { realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const FILES = new WeakMap()

/** Keeps the file a section was read from, off the section: it must not reach a payload. */
export function noteSectionFile(section, file) {
  FILES.set(section, file)
}

/** The same file for a record made from a section, on the push's lane. */
export function carrySectionFile(from, to) {
  if (FILES.has(from)) FILES.set(to, FILES.get(from))
}

/** The file a section — or a record the push made from one — was read from, or null. */
export function sectionFileOf(section) {
  return FILES.get(section) ?? null
}

// A relative path to a markdown file: no scheme, no leading `/`, `#` or `?`.
const FILE_LINK = /^(?![a-z][a-z0-9+.-]*:|[/#?])([^#?]+\.md)(?:#(.*))?$/i

const decode = (text) => {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

// One name for a file, however it was reached: a mount is walked by its real path, a site's own
// pages by theirs, and a symlink between them is ordinary.
const real = (file) => {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

const textOf = (node) =>
  typeof node?.text === 'string' ? node.text : (node?.content || []).map(textOf).join('')

/** What `headingId` in `@uniweb/kit` gives a heading. `_contracts/` holds the two together. */
export function siteAnchor(text) {
  return String(text).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
}

/** What GitHub gives a heading: punctuation gone, each space a hyphen, so `a — b` is `a--b`. */
export function githubAnchor(text) {
  return String(text).normalize('NFC').toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/** Each anchor a link might name for a document's headings, and the id it has on the page. */
function anchorsOf(doc, anchors = new Map()) {
  for (const node of doc?.content || []) {
    if (node?.type === 'heading') {
      const text = textOf(node)
      const id = node.attrs?.id || siteAnchor(text)
      anchors.set(id, id)
      anchors.set(siteAnchor(text), id)
      anchors.set(githubAnchor(text), id)
    }
    if (node?.content) anchorsOf(node, anchors)
  }
  return anchors
}

function eachSection(sections, visit) {
  for (const section of sections || []) {
    if (!section || typeof section !== 'object') continue
    visit(section)
    eachSection(section.subsections, visit)
    eachSection(section.$children, visit)
  }
}

function rewriteDoc(node, rewrite) {
  if (!node || typeof node !== 'object') return
  if (typeof node.attrs?.href === 'string') node.attrs.href = rewrite(node.attrs.href)
  for (const mark of node.marks || []) {
    if (typeof mark?.attrs?.href === 'string') mark.attrs.href = rewrite(mark.attrs.href)
  }
  if (Array.isArray(node.content)) for (const child of node.content) rewriteDoc(child, rewrite)
}

/**
 * The pages a site's files became, for the links written as files: each file by its real path, with
 * its page's route, its section's id where the page is of several files, and its headings' anchors.
 *
 * @param {Array<{ route: string, files: Array<{ file: string, id: string|null, content: object }> }>} pages
 * @returns {Map<string, { route: string, section: string|null, anchors: Map<string, string> }>}
 */
export function fileLinkTargets(pages) {
  const files = new Map()
  for (const { route, files: held } of pages) {
    for (const { file, id, content } of held) {
      // A page of several files: this file is a section of it, with an anchor of its own.
      files.set(real(file), { route, section: held.length > 1 ? id || null : null, anchors: anchorsOf(content) })
    }
  }
  return files
}

/**
 * The page link a push writes for `href`, written in the file `from` — `{ href, missing }`, `missing`
 * naming what it leads to that is not there (`'file'`, `'anchor'`) — or null for a link no file's.
 *
 * @param {string} href
 * @param {string} from
 * @param {Map} files - `fileLinkTargets`
 * @returns {{ href: string, missing: 'file'|'anchor'|null }|null}
 */
export function pageLinkFor(href, from, files) {
  const link = FILE_LINK.exec(href)
  if (!link) return null
  const target = files.get(real(resolve(dirname(from), decode(link[1]))))
  if (!target) return { href, missing: 'file' }
  if (!link[2]) return { href: target.section ? `${target.route}#section-${target.section}` : target.route, missing: null }
  const anchor = target.anchors.get(decode(link[2]))
  return { href: `${target.route}#${anchor ?? link[2]}`, missing: anchor ? null : 'anchor' }
}

/**
 * Rewrites every link written as a file, in the sections of a site's pages. Mutates the sections.
 *
 * @param {Array<{ route: string, sections: Array<object> }>} pages - each page's route and sections,
 *   a section holding its document at `content`, with `stableId` or `$id`
 * @param {{ siteRoot: string, warn: (message: string) => void }} options
 */
export function rewriteFileLinks(pages, { siteRoot, warn }) {
  const files = fileLinkTargets(
    pages.map(({ route, sections }) => {
      const held = []
      eachSection(sections, (section) => {
        if (FILES.has(section)) held.push({ file: FILES.get(section), id: section.stableId || section.$id || null, content: section.content })
      })
      return { route, files: held }
    })
  )
  for (const { sections } of pages) {
    eachSection(sections, (section) => {
      const from = FILES.get(section)
      if (!from) return
      rewriteDoc(section.content, (href) => {
        const page = pageLinkFor(href, from, files)
        if (page?.missing === 'file') warn(`${relative(siteRoot, from)}: the link to ${href} names a file that is no page of this site, so it leads nowhere`)
        if (page?.missing === 'anchor') warn(`${relative(siteRoot, from)}: the link to ${href}: that page has no such heading`)
        return page ? page.href : href
      })
    })
  }
}

/**
 * ⭐ A FILE'S LINKS AS A PUSH READS THEM, AND BACK, for a pull writing the backend's document into the
 * file a section was read from (`uwx/project-writer.js`). `resolve` gives a node of the file the page
 * links a push sends for its file links, so it compares with the backend's; `restore` writes each page
 * link the file wrote as a file back in the file's own spelling — `../guide/deploying.md`, which works
 * on GitHub and in an editor, never `/docs/guide/deploying`. A link the app added stays the app's.
 *
 * @param {string} from - the file
 * @param {Map} files - `fileLinkTargets`
 * @param {object|null} authored - the file's own document, as it reads
 * @returns {{ resolve: (node: object) => object, restore: (node: object) => object }}
 */
export function fileLinksIn(from, files, authored) {
  const back = new Map()
  if (authored) {
    rewriteDoc(structuredClone(authored), (href) => {
      const page = pageLinkFor(href, from, files)
      if (page && page.href !== href && !back.has(page.href)) back.set(page.href, href)
      return href
    })
  }
  const mapped = (node, rewrite) => {
    const copy = structuredClone(node)
    rewriteDoc(copy, rewrite)
    return copy
  }
  return {
    resolve: (node) => mapped(node, (href) => pageLinkFor(href, from, files)?.href ?? href),
    restore: (node) => (back.size ? mapped(node, (href) => back.get(href) ?? href) : node),
  }
}
