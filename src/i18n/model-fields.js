/**
 * ⭐ A RECORD'S FIELDS, WALKED BY ITS MODEL — the shape a push sends it in, lowered by the push's
 * own rule (`uwx/data-schema.js::toDataSchemaDeclaration`), which marks `localized` exactly the
 * fields that travel per locale: text — never an enum, a value format (a URL, an email), a
 * `translatable: false` field, a number, a date, a file or a reference.
 *
 * One walk for two things a model describes: a record (`records.js`), and a tagged data block whose
 * key a section type declares the shape of (`data-strings.js::visitDataBlockStrings`).
 */
import { isOpenMapSection } from '../uwx/data-schema.js'

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * ⛔ A RECORD'S SYSTEM FIELDS ARE NEVER PROSE — never extracted, never translated, by
 * either path. A `$`-prefixed key at any depth is the system's (`$name`, the handle a
 * parametric page's URL names; `$uuid`; `$branch`, the folder a compiled list holds a
 * record under), and a top-level `slug` is how a record's reader hands the file's name
 * on. Until 2026-09-14 they became translation units, and a translation whose source
 * happened to equal one rewrote it, so a record's page stopped matching its URL.
 * ⛔ A top-level `path` was one too until 2026-09-27, when the placement it named moved to
 * `$branch` [Diego]: a field an author names `path` is theirs, and translated as its schema says.
 *
 * @param {string|number} key - a field name (an array index is never one)
 * @param {boolean} topLevel - whether the key sits at the record's own level
 * @returns {boolean}
 */
export function isRecordSystemField(key, topLevel) {
  if (typeof key !== 'string') return false
  return key.startsWith('$') || (topLevel && key === 'slug')
}

/**
 * Each field of a model that a record holds a value for, in the shape the record is DELIVERED in
 * (`toDeliveredRecord`): the brief's fields at the top — every field, for a model of one single
 * section — and each other section under its name, a list of them for a `multiple` one, a nested
 * section the same way. Calls `visit(holder, name, field, path)` for each.
 */
export function eachModelField(record, model, visit) {
  const sections = Object.entries(model?.sections || {})
  const flat = sections.length === 1 && !sections[0][1]?.multiple
  for (const [name, section] of sections) {
    if (flat || section?.brief) eachSectionField(record, section?.fields, '', visit)
    else eachSectionValue(record?.[name], section, name, visit)
  }
}

function eachSectionValue(value, section, path, visit) {
  if (!section?.multiple) return eachSectionField(value, section?.fields, path, visit)
  if (Array.isArray(value)) value.forEach((item, i) => eachSectionField(item, section.fields, `${path}[${i}]`, visit))
  // An open map as its file holds it: each entry is one of the rows a push sends (`isOpenMapSection`).
  else if (isOpenMapSection(section) && isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) eachSectionField(item, section.fields, `${path}.${key}`, visit)
  }
}

export function eachSectionField(holder, fields, path, visit) {
  if (!isPlainObject(holder)) return
  for (const [name, field] of Object.entries(fields || {})) {
    if (holder[name] == null || isRecordSystemField(name, !path)) continue
    const at = path ? `${path}.${name}` : name
    if (field?.type === 'section') eachSectionValue(holder[name], field, at, visit)
    else visit(holder, name, field || {}, at)
  }
}

/**
 * Each string a record's model marks `localized` — a text field's value, or each string of a list
 * of them — handed to `visit(value, path)`; a different string returned replaces it, in place, as
 * `data-strings.js::visitDataStrings` does. A rich field is one string here: a data block holds its
 * markdown as written.
 *
 * @param {object} record
 * @param {object} model - a lowered data schema (`toDataSchemaDeclaration`)
 * @param {(value: string, path: string) => string|void} visit
 * @param {string} [prefix] - prepended to each path (`[0]` for a list's first item)
 */
export function visitModelStrings(record, model, visit, prefix = '') {
  const pathOf = (path) => (prefix ? (path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`) : path)
  eachModelField(record, model, (holder, name, field, path) => {
    if (!field.localized) return
    const value = holder[name]
    if (typeof value === 'string') {
      if (!value.trim()) return
      const next = visit(value, pathOf(path))
      if (typeof next === 'string' && next !== value) holder[name] = next
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item !== 'string' || !item.trim()) return
        const next = visit(item, pathOf(`${path}[${i}]`))
        if (typeof next === 'string' && next !== item) value[i] = next
      })
    }
  })
}
