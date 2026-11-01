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
 * Rewrites every link written as a file, in the sections of a site's pages. Mutates the sections.
 *
 * @param {Array<{ route: string, sections: Array<object> }>} pages - each page's route and sections,
 *   a section holding its document at `content`, with `stableId` or `$id`
 * @param {{ siteRoot: string, warn: (message: string) => void }} options
 */
export function rewriteFileLinks(pages, { siteRoot, warn }) {
  const files = new Map()
  for (const { route, sections } of pages) {
    const held = []
    eachSection(sections, (section) => {
      if (FILES.has(section)) held.push(section)
    })
    for (const section of held) {
      files.set(real(FILES.get(section)), {
        route,
        // A page of several files: this file is a section of it, with an anchor of its own.
        section: held.length > 1 ? section.stableId || section.$id || null : null,
        anchors: anchorsOf(section.content),
      })
    }
  }

  for (const { sections } of pages) {
    eachSection(sections, (section) => {
      const from = FILES.get(section)
      if (!from) return
      rewriteDoc(section.content, (href) => {
        const link = FILE_LINK.exec(href)
        if (!link) return href
        const target = files.get(real(resolve(dirname(from), decode(link[1]))))
        if (!target) {
          warn(`${relative(siteRoot, from)}: the link to ${href} names a file that is no page of this site, so it leads nowhere`)
          return href
        }
        if (!link[2]) return target.section ? `${target.route}#section-${target.section}` : target.route
        const anchor = target.anchors.get(decode(link[2]))
        if (!anchor) warn(`${relative(siteRoot, from)}: the link to ${href}: that page has no such heading`)
        return `${target.route}#${anchor ?? link[2]}`
      })
    })
  }
}
