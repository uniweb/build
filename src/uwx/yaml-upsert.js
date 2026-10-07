// Surgical, comment-preserving edits of a YAML file an author wrote.
//
// `site.yml`, `theme.yml`, `page.yml`, `queries.yml` are hand-authored — they carry
// comments and an author-chosen key order. Round-tripping them through js-yaml
// (load → dump) discards every comment and re-flows the file. Two tools here:
//
//   - `upsertYamlScalar` / `removeYamlScalar` — ONE top-level scalar line, for a
//     machine-owned value (`$uuid`, `index`, `preview`). Line-level.
//   - `editYamlText` — a whole file made to say a new value, by editing only the
//     entries that changed. What every config writer of a pull goes through
//     (`project-writer.js`).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'
import { parseDocument, isMap, isSeq, isScalar, visit } from 'yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'

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
 * Make one block map say `after` — `before` is what it says now — by edits to its own
 * entries: a removed key's lines go, a changed scalar is rewritten where it stands, a
 * changed map is edited the same way one level down, anything else is written whole in
 * its place, and a new key goes after the last one. False when the map is not one this
 * can edit (a key that is not a plain scalar, or not first on its line).
 */
function editMap(text, map, before, after, edits, render) {
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
    if (isMap(value) && !value.flow && isPlainObject(before[key]) && isPlainObject(after[key])) {
      const inner = []
      if (editMap(text, value, before[key], after[key], inner, render)) {
        edits.push(...inner)
        continue
      }
    }
    const next = after[key]
    if (isScalar(value) && (next === null || typeof next !== 'object') && value.range[1] > value.range[0]) {
      const was = text.slice(value.range[0], value.range[1])
      const now = render(next).replace(/\n$/, '')
      if (!was.includes('\n') && !now.includes('\n')) {
        edits.push({ start: value.range[0], end: value.range[1], text: now })
        continue
      }
    }
    // Written whole — in flow style when the author wrote it that way (`tags: [a, b]`).
    const flow = (isMap(value) || isSeq(value)) && value.flow
    edits.push({ start: pair.key.range[0], end: stop, text: indented(render({ [key]: next }, flow), col, false) })
  }
  for (const key of Object.keys(after)) {
    if (seen.has(key) || after[key] === undefined) continue
    const lead = end > 0 && text[end - 1] !== '\n' ? '\n' : ''
    edits.push({ start: end, end, text: lead + indented(render({ [key]: after[key] }), col, true) })
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
 * render a whole file; and the result is read back by the build's own reader, and kept
 * only if it says exactly `after`. ⛔ Not `yaml`'s Document API, edited and printed: it
 * prints the WHOLE file again, and with no edit at all it changed 16 of the 17 template
 * `site.yml` files — long lines folded, `[a, b]` padded to `[ a, b ]` — and with the best
 * options still 4 of 17, comments moved onto a key's line or indented under the map before
 * them (measured 2026-10-07).
 * Every such line is one a pull did not change, and a conflict waiting in a merge.
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
 *   not a map, an alias or merge key, a parse error, or a result that reads differently —
 *   and the caller writes it whole
 */
export function editYamlText(text, before, after, dumpOptions = {}) {
  if (typeof text !== 'string' || !isPlainObject(before) || !isPlainObject(after)) return null
  let doc
  try {
    doc = parseDocument(text)
  } catch {
    return null
  }
  if (doc.errors.length || usesReferences(doc)) return null
  const render = (value, flow = false) => yaml.dump(value, flow ? { ...dumpOptions, flowLevel: 1 } : dumpOptions)
  const edits = []
  if (doc.contents === null || doc.contents === undefined) {
    // Comments and nothing else: what the file says goes after them.
    const lead = text && !text.endsWith('\n') ? '\n' : ''
    edits.push({ start: text.length, end: text.length, text: lead + render(after) })
  } else if (!isMap(doc.contents) || doc.contents.flow || !editMap(text, doc.contents, before, after, edits, render)) {
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

// A top-level `key:` line (column 0, no leading space), capturing any inline value.
function topLevelKeyLine(key) {
  // Escape regex metachars in the key (`$uuid` contains `$`).
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${esc}:[^\\n]*$`, 'm')
}

/**
 * Set `key: value` at the top level of the YAML file at `filePath`, preserving all
 * other lines (comments included). If the key already exists at column 0, its line
 * is replaced; otherwise a new line is prepended (machine-owned identity reads
 * cleanest at the top). The file (and its directory) is created if absent.
 *
 * @param {string} filePath
 * @param {string} key    - a top-level scalar key (e.g. `$uuid`)
 * @param {string} value  - the scalar value, written verbatim (uuids need no quoting)
 * @returns {boolean} true if the file changed
 */
export function upsertYamlScalar(filePath, key, value) {
  const line = `${key}: ${value}`
  let text = ''
  if (existsSync(filePath)) text = readFileSync(filePath, 'utf8')

  const re = topLevelKeyLine(key)
  let next
  if (re.test(text)) {
    next = text.replace(re, line)
  } else if (text.length === 0) {
    next = line + '\n'
  } else {
    // Prepend, keeping the rest intact (and a trailing newline if the file lacked one).
    const body = text.endsWith('\n') ? text : text + '\n'
    next = line + '\n' + body
  }
  if (next === text) return false
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, next)
  return true
}

/**
 * Remove a TOP-LEVEL scalar key from the YAML file at `filePath`, preserving every
 * other line (comments included) — the inverse of `upsertYamlScalar`, with the same
 * scope: one `key: value` line at column 0. A key followed by indented lines, or
 * opening a block scalar (`|` / `>`), is not a one-line scalar and is left alone
 * rather than half-removed.
 *
 * @param {string} filePath
 * @param {string} key - a top-level scalar key (e.g. `preview`)
 * @returns {boolean} true if the file changed
 */
export function removeYamlScalar(filePath, key) {
  if (!existsSync(filePath)) return false
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc}:(.*)$`)
  const at = lines.findIndex((l) => re.test(l))
  if (at === -1) return false
  const inline = lines[at].replace(re, '$1').trim()
  const continues = at + 1 < lines.length && /^[ \t]+\S/.test(lines[at + 1])
  if (continues || /^[|>]/.test(inline)) return false
  lines.splice(at, 1)
  writeFileSync(filePath, lines.join('\n'))
  return true
}
