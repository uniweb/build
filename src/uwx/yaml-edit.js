// Edits to a YAML file an author wrote — ONE engine, `editYamlText`, for everything
// in the framework that changes such a file.
//
// `site.yml`, `theme.yml`, `page.yml`, `queries.yml` are hand-authored — they carry
// comments, blank lines and an author-chosen layout. Round-tripping them through
// js-yaml (load → dump) discards every comment and re-flows the file. So nothing
// writes one whole: the engine rewrites only the entries that change.
//
//   - `editYamlText(text, before, after)` — the engine: text in, text out.
//   - `setYamlKey` / `replaceInYamlList` — the two edits a command decides on before
//     it writes anything (`uniweb rename`), as text, so a file it cannot edit stops
//     the command while nothing has moved.
//   - Writing a file goes through `project-writer.js` (`writeSiteConfig`,
//     `writeThemeFile`, …), which reads it, merges, and hands the engine both values.
//
// ⛔ *Until 2026-10-07 there were three: this module's line-level `upsertYamlScalar`
// and `removeYamlScalar` (one top-level scalar line), the CLI's `utils/yaml-edit.js`
// (`setTopLevelScalar`, `replaceInTopLevelList`), and the engine. The two line-level
// ones refused or misplaced what the engine edits — a block scalar, a list entry
// beside a comment, a new key PREPENDED above a file's header comments.*

import yaml from 'js-yaml'
import { parseDocument, isMap, isSeq, isScalar, Scalar, visit } from 'yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

/** js-yaml's options for every value the framework writes into YAML, so output is byte-stable. */
export const YAML_DUMP_OPTS = { lineWidth: -1, quotingType: "'", forceQuotes: false, noRefs: true }

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Deep equality of two values read from YAML: sorted-key JSON. */
const sameValue = (a, b) => {
  const canonical = (v) =>
    JSON.stringify(v, (_k, x) => (isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
  return canonical(a) === canonical(b)
}

/** Offset of the start of the line holding `pos`. */
const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1

/** The column a block map's key starts at — null when anything but spaces precedes it (`- key:`). */
function columnOf(text, key) {
  const start = lineStart(text, key.range[0])
  const lead = text.slice(start, key.range[0])
  return /^ *$/.test(lead) ? lead.length : null
}

/** Where a pair's text ends: after its value, its trailing comment and its newline. */
function pairEnd(text, pair) {
  let end = (pair.value ?? pair.key).range[2]
  if (text[end - 1] !== '\n') {
    const nl = text.indexOf('\n', end)
    const rest = nl === -1 ? text.slice(end) : text.slice(end, nl)
    if (/^\s*(#.*)?$/.test(rest)) end = nl === -1 ? text.length : nl + 1
  }
  return end
}

/** Every line but the first — or every line, for text that starts a line — indented to `col`. */
function indented(text, col, first) {
  if (!col) return text
  const pad = ' '.repeat(col)
  return text
    .split('\n')
    .map((line, i) => (line && (i > 0 || first) ? pad + line : line))
    .join('\n')
}

/** An alias or a `<<` merge key: one edit could change what another place says. */
function usesReferences(doc) {
  let found = false
  visit(doc, {
    Alias() {
      found = true
      return visit.BREAK
    },
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        found = true
        return visit.BREAK
      }
    }
  })
  return found
}

/**
 * A scalar written where `node` stood — in the node's quotes when it was quoted and the
 * new value is text (`"…"` stays `"…"`), else as js-yaml writes it; inside a flow
 * collection, in a form that cannot run into the next entry. Null when it does not fit
 * on one line, or `node` spans lines.
 */
function scalarText(text, node, value, dump, inFlow) {
  if (!node.range || node.range[1] <= node.range[0]) return null
  if (text.slice(node.range[0], node.range[1]).includes('\n')) return null
  if (value !== null && typeof value === 'object') return null
  let out
  if (typeof value === 'string' && node.type === Scalar.QUOTE_DOUBLE) out = JSON.stringify(value)
  else if (typeof value === 'string' && node.type === Scalar.QUOTE_SINGLE) out = `'${value.replace(/'/g, "''")}'`
  else if (inFlow) {
    const list = dump([value], { flowLevel: 0 }).trim()
    if (!list.startsWith('[') || !list.endsWith(']')) return null
    out = list.slice(1, -1)
  } else out = dump(value).replace(/\n$/, '')
  return out.includes('\n') ? null : out
}

/**
 * Make one list say `after` — `before` is what it says now, the same length — by
 * rewriting each changed entry where it stands. False for anything else (a list that
 * grew or shrank, an entry that is not a one-line scalar): the caller writes it whole.
 */
function editSeq(text, seq, before, after, edits, dump) {
  if (seq.items.length !== before.length || before.length !== after.length) return false
  const inner = []
  for (let i = 0; i < after.length; i++) {
    if (sameValue(before[i], after[i])) continue
    const node = seq.items[i]
    const now = isScalar(node) ? scalarText(text, node, after[i], dump, seq.flow) : null
    if (now === null) return false
    inner.push({ start: node.range[0], end: node.range[1], text: now })
  }
  edits.push(...inner)
  return true
}

/**
 * Make one block map say `after` — `before` is what it says now — by edits to its own
 * entries: a removed key's lines go, a changed scalar is rewritten where it stands, a
 * changed map or same-length list is edited the same way one level down, anything else
 * is written whole in its place, and a new key goes after the last one. False when the
 * map is not one this can edit (a key that is not a plain scalar, or not first on its line).
 */
function editMap(text, map, before, after, edits, dump) {
  if (!map.items.length || !map.items[0].key?.range) return false
  const col = columnOf(text, map.items[0].key)
  if (col === null) return false
  const seen = new Set()
  let end = 0
  for (const pair of map.items) {
    if (!isScalar(pair.key) || !pair.key.range || columnOf(text, pair.key) !== col) return false
    const key = String(pair.key.value)
    if (seen.has(key)) return false
    seen.add(key)
    const value = pair.value
    const stop = pairEnd(text, pair)
    end = Math.max(end, stop)
    if (!Object.hasOwn(after, key) || after[key] === undefined) {
      edits.push({ start: lineStart(text, pair.key.range[0]), end: stop, text: '' })
      continue
    }
    if (Object.hasOwn(before, key) && sameValue(before[key], after[key])) continue
    const next = after[key]
    const inner = []
    if (isMap(value) && !value.flow && isPlainObject(before[key]) && isPlainObject(next)) {
      if (editMap(text, value, before[key], next, inner, dump)) {
        edits.push(...inner)
        continue
      }
    } else if (isSeq(value) && Array.isArray(before[key]) && Array.isArray(next)) {
      if (editSeq(text, value, before[key], next, inner, dump)) {
        edits.push(...inner)
        continue
      }
    } else if (isScalar(value)) {
      const now = scalarText(text, value, next, dump, false)
      if (now !== null) {
        edits.push({ start: value.range[0], end: value.range[1], text: now })
        continue
      }
    }
    // Written whole — in flow style when the author wrote it that way (`tags: [a, b]`).
    const flow = (isMap(value) || isSeq(value)) && value.flow
    edits.push({
      start: pair.key.range[0],
      end: stop,
      text: indented(dump({ [key]: next }, flow ? { flowLevel: 1 } : {}), col, false)
    })
  }
  for (const key of Object.keys(after)) {
    if (seen.has(key) || after[key] === undefined) continue
    const lead = end > 0 && text[end - 1] !== '\n' ? '\n' : ''
    edits.push({ start: end, end, text: lead + indented(dump({ [key]: after[key] }), col, true) })
  }
  return true
}

/**
 * Edit the YAML `text` so it says `after` — `before` is what it says now, as the build
 * reads it — changing only the entries that differ, and leaving every other byte as its
 * author wrote it: comments, blank lines, key order, quoting, a list written on one line.
 *
 * ⭐ `yaml` LOCATES, js-yaml WRITES AND READS. The comment-preserving library parses the
 * text for where each entry sits; a changed entry is rendered by js-yaml, as the writers
 * render a whole file — keeping the quotes it had, where it had them; and the result is
 * read back by the build's own reader, and kept only if it says exactly `after`. ⛔ Not
 * `yaml`'s Document API, edited and printed: it prints the WHOLE file again, and with no
 * edit at all it changed 16 of the 17 template `site.yml` files — long lines folded,
 * `[a, b]` padded to `[ a, b ]` — and with the best options still 4 of 17, comments moved
 * onto a key's line or indented under the map before them (measured 2026-10-07). Every
 * such line is one a pull did not change, and a conflict waiting in a merge.
 *
 * ⛔ *Until 2026-10-07 the writers dumped the whole file, and a pull that changed one key
 * of `site.yml` left the Starter template's 93 lines as 10 — every comment gone — and a
 * `pull --merge` then conflicted on the whole commented header (F1, F12).*
 *
 * @param {string} text - the file as it is
 * @param {object} before - what it says, read by the build's reader
 * @param {object} after - what it must say
 * @param {object} [dumpOptions] - js-yaml's, for what is written
 * @returns {string|null} the edited text; null when the file cannot be edited in place —
 *   not a map, an alias or merge key, a parse error, or a result that reads differently
 */
export function editYamlText(text, before, after, dumpOptions = YAML_DUMP_OPTS) {
  if (typeof text !== 'string' || !isPlainObject(before) || !isPlainObject(after)) return null
  let doc
  try {
    doc = parseDocument(text)
  } catch {
    return null
  }
  if (doc.errors.length || usesReferences(doc)) return null
  const dump = (value, extra = {}) => yaml.dump(value, { ...dumpOptions, ...extra })
  const edits = []
  if (doc.contents === null || doc.contents === undefined) {
    // Comments and nothing else: what the file says goes after them.
    const lead = text && !text.endsWith('\n') ? '\n' : ''
    edits.push({ start: text.length, end: text.length, text: lead + dump(after) })
  } else if (!isMap(doc.contents) || doc.contents.flow || !editMap(text, doc.contents, before, after, edits, dump)) {
    return null
  }
  // Last first, so an offset is never moved by an edit before it. At one offset: a removal
  // before an insertion, and the outer map's new keys before the inner map's, so the inner
  // map's land first in the text.
  const order = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i)
  let out = text
  for (const e of order) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  let read
  try {
    read = yaml.load(out, YAML_OPTIONS) ?? {}
  } catch {
    return null
  }
  return sameValue(read, after) ? out : null
}

/** What `text` says, as the build reads it — null when it is not YAML, or not a map. */
function readMap(text) {
  try {
    const data = yaml.load(text, YAML_OPTIONS) ?? {}
    return isPlainObject(data) ? data : null
  } catch {
    return null
  }
}

/**
 * Set top-level `key` to `value` in `text` — added after the last key when it is not
 * there — editing nothing else.
 *
 * @param {string} text - the file's contents
 * @param {string} key - a top-level key, e.g. `foundation`
 * @param {*} value
 * @returns {string|null} the new contents; null when the text cannot be edited in place
 *   (`editYamlText`) — a caller deciding before it writes refuses then
 */
export function setYamlKey(text, key, value) {
  const before = readMap(text)
  return before ? editYamlText(text, before, { ...before, [key]: value }) : null
}

/**
 * Replace entries of the top-level list `key` — each `from` entry becomes its `to` — where
 * they stand, in the quotes they were written in. An entry that only CONTAINS `from` is
 * left alone, and so is everything else in the file.
 *
 * @param {string} text - the file's contents
 * @param {string} key - a top-level list key, e.g. `extensions`
 * @param {Map<*, *>} replacements - old entry → new entry
 * @returns {string|null} the new contents; null when `key` is not a list, or the text
 *   cannot be edited in place
 */
export function replaceInYamlList(text, key, replacements) {
  const before = readMap(text)
  if (!before || !Array.isArray(before[key])) return null
  const list = before[key].map((v) => (replacements.has(v) ? replacements.get(v) : v))
  return editYamlText(text, before, { ...before, [key]: list })
}
