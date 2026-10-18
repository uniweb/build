// What a backend removed from a push's content, read against what the push sent.
//
// ⭐ A backend that cleans each rich-text write to the vocabulary (`@uniweb/content-reader/vocabulary`)
// answers, beside each finalized document, what it removed — `finalized[].cleaned`, absent when
// nothing was. Each removal names its item by the `$uuid` the returned document gives it (on a
// first push, the one the push minted), the field and its language (`data.content.en`; no language
// for one document in every language), a JSON Pointer into that field's document AS SENT, and the
// vocabulary's rule. A push never writes the returned document over the author's file, so the file
// still holds what went, and this is what says so.
//
// Read against what the push sent, each removal names what went. One this version's own check
// finds too is worded as the build words it before a push (`site/vocabulary-warnings.js`); one it
// does not is a removal this version keeps — the backend cleans to another version of the
// vocabulary — and is named by what its path holds.

import { cleanToVocabulary, outsideVocabulary } from '@uniweb/content-reader/vocabulary'
import { walkSiteUnits } from './site-diff.js'
import { saysOutside, shown } from '../site/vocabulary-warnings.js'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isDocument = (v) => isObject(v) && v.type === 'doc'

/** The value a JSON Pointer (RFC 6901) names in `value`, or undefined. */
function pointedAt(value, pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) return undefined
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

/** The keys from `node` down to the object whose `$uuid` is `uuid`, or null. */
function placeOf(node, uuid, place = []) {
  if (node === null || typeof node !== 'object') return null
  if (!Array.isArray(node) && node.$uuid === uuid) return place
  for (const [key, value] of Object.entries(node)) {
    const found = placeOf(value, uuid, [...place, Array.isArray(node) ? Number(key) : key])
    if (found) return found
  }
  return null
}

const at = (value, place) => place.reduce((v, key) => (v !== null && typeof v === 'object' ? v[key] : undefined), value)

// What a removal this version keeps held, by its rule — there is no finding of ours to word it,
// so it is named by what its path holds.
const HELD = {
  'node-type': (value) => `a \`${shown(value?.type)}\` node`,
  'mark-type': (value) => `a \`${shown(value?.type)}\` mark`,
  attribute: (value, name) => `the attribute \`${shown(name)}\``,
  'style-name': (value, name) => `the style name \`${shown(name)}\``,
  url: (value) => `the URL \`${shown(value)}\``,
  target: (value) => `\`target=${shown(value)}\``,
  color: (value) => `the colour \`${shown(value)}\``,
  mathml: () => "a formula's MathML",
  'ref-id': (value) => `the inset reference \`${shown(value)}\``,
}

/**
 * One removal, read against the item it was sent as: `{ locale, says, keeps }` — `says` a
 * sentence, `keeps` true where this version of the vocabulary keeps what the backend removed.
 */
function describeRemoval(removal, item) {
  const keys = typeof removal?.field === 'string' ? removal.field.split('.') : []
  // The backend names an item's fields under `data`; on the wire they are the item's own keys.
  if (keys[0] === 'data' && !(isObject(item) && Object.hasOwn(item, 'data'))) keys.shift()
  const [name, locale = null] = keys
  const rule = typeof removal?.rule === 'string' ? removal.rule : 'unknown'
  const path = typeof removal?.path === 'string' ? removal.path : ''
  let doc = isObject(item) && name ? item[name] : undefined
  if (locale !== null && !isDocument(doc)) doc = isObject(doc) ? doc[locale] : undefined
  if (!isDocument(doc)) {
    return { locale, keeps: false, says: `the backend removed what \`${shown(path || '/')}\` held in \`${shown(removal?.field)}\` (${rule})` }
  }
  const ours = outsideVocabulary(doc).find((f) => f.path === path && f.rule === rule)
  if (ours) return { locale, keeps: false, says: `${saysOutside(ours)} — the backend removed it` }
  const last = path.slice(path.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~')
  const what = HELD[rule]?.(pointedAt(doc, path), last) ?? `what \`${shown(path || '/')}\` held (${rule})`
  return { locale, keeps: true, says: `the backend removed ${what}, which this version of Uniweb keeps` }
}

/**
 * What the backend removed from a site-content push: `[{ unit, locale, says, keeps }]`.
 *
 * `unit` is the path the unit is keyed by (`pages/home/hero.md`, `layout/footer.md`), found by
 * the `$uuid` the returned document gives the item — null for an item that is no unit. Each
 * removal is read against the item the push sent for that unit.
 *
 * @param {object} p
 * @param {Array<{document?: object, cleaned?: object[]}>} p.finalized - the lane's finalized entries
 * @param {object|null} p.sent - the site-content document the push sent
 * @returns {Array<{unit: string|null, locale: string|null, says: string, keeps: boolean}>}
 */
export function siteContentRemovals({ finalized, sent }) {
  const sentAt = new Map()
  if (sent) walkSiteUnits(sent, (path, record) => sentAt.has(path) || sentAt.set(path, record))
  const out = []
  for (const entry of finalized || []) {
    if (!Array.isArray(entry?.cleaned) || !entry.cleaned.length) continue
    const unitOf = new Map()
    if (entry.document) {
      walkSiteUnits(entry.document, (path, record) => {
        if (typeof record?.$uuid === 'string' && !unitOf.has(record.$uuid)) unitOf.set(record.$uuid, path)
      })
    }
    for (const removal of entry.cleaned) {
      const unit = unitOf.get(removal?.$uuid) ?? null
      out.push({ unit, ...describeRemoval(removal, unit ? sentAt.get(unit) : undefined) })
    }
  }
  return out
}

/**
 * What the backend removed from a records push: `[{ index, locale, says, keeps }]`, `index` the
 * submitted position the finalized entry answers for. Each removal is read against the document
 * the push sent at that position, at the place its item holds in the returned document — the
 * backend returns a record item for item as it was sent.
 *
 * @param {object} p
 * @param {Array<{index: number, document?: object, cleaned?: object[]}>} p.finalized
 * @param {Array<object|null>} p.sent - the documents the push sent, in submitted order
 * @returns {Array<{index: number, locale: string|null, says: string, keeps: boolean}>}
 */
export function recordRemovals({ finalized, sent }) {
  const out = []
  for (const entry of finalized || []) {
    if (!Array.isArray(entry?.cleaned) || !entry.cleaned.length) continue
    const sentDoc = sent?.[entry.index]
    for (const removal of entry.cleaned) {
      const place = entry.document ? placeOf(entry.document, removal?.$uuid) : null
      out.push({ index: entry.index, ...describeRemoval(removal, place && sentDoc ? at(sentDoc, place) : undefined) })
    }
  }
  return out
}

/**
 * A record with each rich-text document in it cleaned to the vocabulary — what a backend that
 * cleans at write stores for it — or the record itself when nothing in it is outside. A push
 * compares what the backend returns with this as well as with what it sent, so content the
 * backend cleaned reads as this copy's own, not as someone else's.
 *
 * ⚠️ Only what this version of the vocabulary removes: a removal it keeps still reads as a
 * difference.
 *
 * @param {object} record - one item's fields, as sent
 * @returns {object}
 */
export function cleanedRecord(record) {
  if (!isObject(record)) return record
  let out = null
  for (const [key, value] of Object.entries(record)) {
    const cleaned = cleanedRichText(value)
    if (cleaned !== value) (out ??= { ...record })[key] = cleaned
  }
  return out ?? record
}

// A document, or a document per language, cleaned — the same value when nothing in it is outside.
function cleanedRichText(value) {
  if (isDocument(value)) {
    const { document, removed } = cleanToVocabulary(value)
    return removed.length ? document : value
  }
  if (!isObject(value) || !Object.keys(value).length || !Object.values(value).every(isDocument)) return value
  let out = null
  for (const [locale, doc] of Object.entries(value)) {
    const { document, removed } = cleanToVocabulary(doc)
    if (removed.length) (out ??= { ...value })[locale] = document
  }
  return out ?? value
}
