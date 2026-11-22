/**
 * ⭐ THE WORDS A SECTION DRAWS THAT ITS CONTENT DOESN'T HOLD.
 *
 * A section type's own words (a search box's placeholder, "No results", a menu button's label) are
 * content: the type declares a data key with an inline field map whose fields give the words in the
 * foundation's language as their `default:`, and a section writes the block to say its own
 * (`uniweb guide foundation` § *A section's own words*; Diego, 2026-11-06, "Words as content"). The
 * component falls back to the same defaults for a section written without the block, since the
 * runtime fills no data block's defaults (`uniweb guide data`).
 *
 * Only what a section holds is translated (`extract.js::extractFromDataBlocks` walks the blocks a
 * section has), so on a site with other languages such a section shows the foundation's words on
 * every language's page, and the build says nothing. This finds those sections, and writes the
 * defaults into one as its block, so they become the site's words and are translated with the page.
 *
 * Which keys hold a type's words is read off the declaration, not a name: a key declared with an
 * inline field map (`normalizeData`'s `fields`), of which a string field gives a `default:`. A form
 * (a `fields` array), a record type (a ref), a concept block and a key with no shape hold none.
 *
 * It reads the section files themselves, under `pages/` and `layout/`, since a collected section
 * doesn't say which file it came from. A section's type is its frontmatter's `type:`, else the
 * site's default section type (`siteDefaultSectionType`), as the collector reads it.
 */
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { parseContent } from '@uniweb/semantic-parser'
import { normalizeData } from '@uniweb/schemas/foundation'
import { isInExcludedBranch } from '@uniweb/projections'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { foundationSections, siteDefaultSectionType } from '../site/queries-config.js'
import { sectionFilesOf, routeOfSection } from '../site/section-files.js'

export { routeOfSection }

/**
 * The words a data key's declaration gives, as `[{ name, text }]`, or null when it holds none.
 *
 * @param {*} declaration - one `data:` key's declaration, as `meta.js` writes it
 * @returns {Array<{ name: string, text: string }>|null}
 */
export function wordsOf(declaration) {
  const [normalized] = Object.values(normalizeData({ key: declaration }, { strict: false }) || {})
  if (normalized?.kind !== 'fields' || !normalized.fields) return null
  const words = []
  for (const [name, spec] of Object.entries(normalized.fields)) {
    if (!spec || (spec.type !== 'string' && spec.type !== 'text')) continue
    if (spec.translatable === false || spec.format) continue
    if (typeof spec.default !== 'string' || !spec.default.trim()) continue
    words.push({ name, text: spec.default })
  }
  return words.length ? words : null
}

/**
 * Each section type's word keys: `{ [type]: { [key]: words } }`. The foundation's own `data:`
 * reaches every section, and a key both declare is the section type's.
 */
export function wordKeysByType(sections) {
  const own = {}
  for (const [key, decl] of Object.entries(sections?._self?.data || {})) {
    const words = wordsOf(decl)
    if (words) own[key] = words
  }
  const byType = { '': own }
  for (const [name, entry] of Object.entries(sections || {})) {
    if (!entry || typeof entry !== 'object' || name.startsWith('_') || name === 'dataSchemas') continue
    const keys = { ...own }
    for (const [key, decl] of Object.entries(entry.data || {})) {
      const words = wordsOf(decl)
      if (words) keys[key] = words
      else delete keys[key]
    }
    byType[name] = keys
  }
  return byType
}

/**
 * The sections whose type draws words their content doesn't hold.
 *
 * @param {string} siteRoot
 * @param {object} [options]
 * @param {object} [options.siteYml] - an already-read site.yml
 * @returns {Promise<Array<{ file: string, route: string|null, type: string, key: string,
 *   words: Array<{ name: string, text: string }>, hasBlock: boolean, inItem?: string }>>} `file` relative to the
 *   site; `inItem`, the heading of the item a block for the key sits under, which the section doesn't read
 */
export async function sectionsMissingWords(siteRoot, { siteYml = null } = {}) {
  const yml = siteYml || (yaml.load(await readFile(join(siteRoot, 'site.yml'), 'utf8'), YAML_OPTIONS) || {})
  let sections
  try {
    sections = await foundationSections(siteRoot, yml)
  } catch {
    return []
  }
  const byType = wordKeysByType(sections)
  if (!Object.values(byType).some((keys) => Object.keys(keys).length)) return []
  const fallbackType = await siteDefaultSectionType(siteRoot, yml)
  const exclude = yml?.i18n?.exclude
  const pagesDir = join(siteRoot, 'pages')
  const found = []

  for (const { file, area } of await sectionFilesOf(siteRoot)) {
    const route = area === 'pages' ? routeOfSection(file, pagesDir, yml.index) : null
    if (route && isInExcludedBranch(route, exclude)) continue
    let parsed
    try {
      parsed = parseFrontmatter(await readFile(file, 'utf8'), file)
    } catch {
      continue // a file whose frontmatter doesn't read is the collector's to report
    }
    const type = parsed.frontmatter?.type || fallbackType
    const keys = byType[type] ?? byType['']
    if (!keys || !Object.keys(keys).length) continue
    // What the section reads as its own: a block after an item's heading is that item's.
    let blocks
    let items
    try {
      const content = parseContent(markdownToProseMirror(parsed.body))
      blocks = content.data || {}
      items = content.items || []
    } catch {
      continue
    }
    for (const [key, words] of Object.entries(keys)) {
      const held = blocks[key]
      const missing = words.filter(({ name }) => !(held && typeof held === 'object' && typeof held[name] === 'string'))
      if (!missing.length) continue
      const entry = { file: relative(siteRoot, file), route, type, key, words: missing, hasBlock: key in blocks }
      // ⭐ A block written after an item's heading, as at the end of a section with items, is that
      // item's, and the section reads none of it: name the item, so the author moves the block rather
      // than being told there is none, and `--write` adds no second one beside it.
      const under = entry.hasBlock ? -1 : items.findIndex((item) => item?.data && typeof item.data === 'object' && key in item.data)
      if (under >= 0) entry.inItem = plainText(items[under].title) || `item ${under + 1}`
      found.push(entry)
    }
  }
  return found
}

/** An item's heading as plain text, for a message. */
function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim()
}

// ─── Writing the words into a section ─────────────────────────────────────────────────────────

const PLAIN_KEY = /^[A-Za-z_][\w-]*$/
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i
const yamlKey = (name) => (PLAIN_KEY.test(name) && !RESERVED.test(name) ? name : JSON.stringify(name))
const yamlLine = ({ name, text }) => `${yamlKey(name)}: ${JSON.stringify(text)}`

/** What a section reads, with what the words would change left out, to see nothing else moved. */
function shapeOf(text, key) {
  const { body } = parseFrontmatter(text)
  const { raw, sequence, data, ...rest } = parseContent(markdownToProseMirror(body))
  const { [key]: _words, ...otherData } = data || {}
  return { read: JSON.stringify({ ...rest, data: otherData }), words: data?.[key] }
}

/** The lines of a text outside fenced code, as their indexes: where a block can go. */
function topLevelLines(lines) {
  const out = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !lines[i].trim().slice(open[1].length).trim()) fence = null
      continue
    }
    if (open) fence = open[1]
    out.push(i)
  }
  return out
}

/**
 * A section file's text with its type's words written in, as a `yaml:<key>` block of their defaults.
 * Only for a section that holds no block for the key: one that holds one chose its words, and which
 * others it draws is the author's to say. The block goes where the section reads it as its own, not
 * an item's, and only where nothing else the section reads changes: each place is checked by reading
 * the result back with the parser.
 *
 * @param {string} text - the file as it is
 * @param {string} key - the data key
 * @param {Array<{ name: string, text: string }>} words - its type's words
 * @returns {{ text: string }|{ reason: string }} the new text, or why it can't be written for you
 */
export function withWords(text, key, words) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const before = shapeOf(text, key)
  if (before.words !== undefined) return { reason: `it holds a \`${key}\` block of its own` }
  const want = Object.fromEntries(words.map((w) => [w.name, w.text]))
  const fits = (candidate) => {
    try {
      const after = shapeOf(candidate, key)
      return after.read === before.read && JSON.stringify(after.words) === JSON.stringify(want) ? { text: candidate } : null
    } catch {
      return null
    }
  }

  // A new block: as late in the section's own content as reads right, else at its start.
  const block = [`\`\`\`yaml:${key}`, ...words.map(yamlLine), '```']
  const bodyStart = text.trimStart().startsWith('---') ? lines.indexOf('---', lines.indexOf('---') + 1) + 1 : 0
  const ends = text.endsWith('\n') || text.endsWith('\r\n')
  const tail = ends ? lines.slice(0, -1) : lines
  const insert = (at) => {
    const head = tail.slice(0, at)
    const rest = tail.slice(at)
    const pad = (side) => (side.length && side[side.length - 1].trim() ? [''] : [])
    const out = [...head, ...pad(head), ...block, ...(rest.length && rest[0].trim() ? [''] : []), ...rest]
    return out.join(newline) + (ends || !rest.length ? newline : '')
  }
  const headings = topLevelLines(tail).filter((i) => i >= bodyStart && /^\s{0,3}#{1,6}\s/.test(tail[i]))
  for (const at of [tail.length, ...headings.reverse(), bodyStart]) {
    const candidate = fits(insert(at))
    if (candidate) return candidate
  }
  return { reason: 'no place in it reads the block as the section’s own' }
}
