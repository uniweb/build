// Surgical, comment-preserving upsert of a TOP-LEVEL scalar key in a YAML file.
//
// `site.yml` and `collections.yml` are hand-authored — they carry comments and an
// author-chosen key order. Round-tripping them through js-yaml (load → dump) would
// discard every comment and re-flow the file. The sync back-fill only ever needs to
// write ONE machine-owned scalar (the entity `$uuid`) into such a file, so we edit
// the single line in place and leave the rest byte-for-byte.
//
// Scope, stated: top-level (column-0) scalar keys only — which is all `$uuid` ever
// is. Not a general YAML writer; do not reach for it to set nested or list values.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
