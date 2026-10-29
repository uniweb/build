// The identity of a record's LIST ITEMS — what a push must remember so that the next send of a
// record updates its stored items instead of replacing them.
//
// ⛔ AN ITEM OF A LIST WITHOUT A `$uuid` IS A NEW ROW. A record's `many` sections are `multi`
// sections on the backend, so a record re-sent with its list items uuid-less would insert them all
// and delete every stored one. The backend refuses that, whole (`identity_required`, naming the
// section) — measured 2026-09-25 on an edit of a talk whose `sessions` it held. So every LIST of a
// record carries its items' `$uuid`s once the backend holds them: a `many` section, a list nested
// in a section or in an item, and a self-nesting list's `$children`, at every depth.
//
// ⭐ AND SO DOES A SINGLE SECTION UNDER A LIST. A single section with no list above it holds one
// item, matched by section, and needs nothing. Under a list it holds one item PER ITEM of the list
// (a degree's `thesis`), so a backend matches it by its `$uuid`, as a list element: sent without
// one, every push after the first is refused whole. It is banked at its place under its item
// (`degrees[0].thesis`), with no fingerprint, since its item's own match places it. ⛔ Until
// 2026-10-28 it was never banked, because a backend matched every single section by section.
//
// ⭐ BANKED PER RECORD, FROM WHAT WAS SENT AND WHAT CAME BACK. An item has no file and no name, so
// nothing on disk can carry its identity — the fourth kind in the producer's ledger, beside
// site-content units, records and folder placements. The backend's response mirrors the package
// item for item ("the producer walks both trees in lockstep"), so a push pairs each item it sent
// with the `$uuid` returned at the same place, and banks both: that uuid, and a fingerprint of the
// item as it was sent (`harvestRecordItems`). A pull pairs the same way — the files it writes hold
// the stored items in stored order.
//
// ⭐ MATCHED BY CONTENT, THEN BY PLACE (`stampRecordItems`). The next send gives an item the uuid of
// the banked item with the same fingerprint — its own fields unchanged, wherever it moved — and
// otherwise the one banked at its own position: an item edited where it stands. An item's own lists
// are then matched the same way under the item it took. Anything else goes without one, as
// a new row, and a banked item nothing claims is left out of the send, which deletes it. ⛔ No uuid
// is stamped twice: two items claiming one row is the failure identity exists to prevent.
//
// THE BANK IS FLAT, one line per item — it is committed, in `sync.json`: each item under its
// place in the record, its value its `$uuid` and, when known, its fingerprint —
// `"sessions[0]": "<uuid> <fingerprint>"`. A list's place is its path within its container, the
// same on both sides: `sessions` for a `many` section, `details.notes` for a list inside a single
// section, `printings` inside an item, `$children` for the items nested under an item of a
// self-nesting list — so `parts[0].$children[1]` is the second part nested under the first.

import { entityContentHash } from './records.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// An item's OWN content: its fields, with the lists nested in it left out — they are matched
// on their own, under it. ⛔ Not the item whole: a parent that moved while one of its children
// changed then matches nothing, and it comes back new with its whole subtree (measured
// 2026-09-25 on a tree reordered while a nested part was renamed).
function ownContent(def, value) {
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, v] of Object.entries(value)) {
    if (key === '$children' && def?.self_nesting === true) continue
    const field = def?.fields?.[key]
    if (field?.type === 'section') {
      if (field.multiple === true) continue
      out[key] = ownContent(field, v)
    } else {
      out[key] = v
    }
  }
  return out
}

// An item's own content in 16 hex characters — `$uuid`s aside, like every content hash of ours.
const fingerprint = (def, item) => entityContentHash(ownContent(def, item)).slice(0, 16)

// Each list of a container — a single section's value, or one item of a list — by its path.
function eachList(def, value, prefix, visit) {
  if (!isPlainObject(value)) return
  for (const [key, field] of Object.entries(def?.fields || {})) {
    if (field?.type !== 'section') continue
    if (field.multiple === true) {
      if (Array.isArray(value[key])) visit(`${prefix}${key}`, field, value[key])
    } else {
      eachList(field, value[key], `${prefix}${key}.`, visit)
    }
  }
  if (def?.self_nesting === true && Array.isArray(value.$children)) {
    visit(`${prefix}$children`, def, value.$children)
  }
}

// Each single section of a container that the container holds a value for, by its path, and
// the single sections inside it: never into a list, whose items are visited as items. Called on
// an item of a list, so every section it visits has a list above it.
function eachSingle(def, value, prefix, visit) {
  if (!isPlainObject(value)) return
  for (const [key, field] of Object.entries(def?.fields || {})) {
    if (field?.type !== 'section' || field.multiple === true || !isPlainObject(value[key])) continue
    visit(`${prefix}${key}`, field, value[key])
    eachSingle(field, value[key], `${prefix}${key}.`, visit)
  }
}

// Each list of a record document: its `many` sections, and the lists inside its single ones.
function eachRecordList(declaration, document, visit) {
  for (const [name, def] of Object.entries(declaration?.sections || {})) {
    if (!def || typeof def !== 'object') continue
    const value = document?.[name]
    if (def.multiple === true) {
      if (Array.isArray(value)) visit(name, def, value)
    } else {
      eachList(def, value, `${name}.`, visit)
    }
  }
}

function itemsOf(def, items) {
  return items.map((item) => {
    const node = { h: fingerprint(def, item) }
    const nested = {}
    eachList(def, item, '', (path, d, list) => {
      nested[path] = itemsOf(d, list)
    })
    if (Object.keys(nested).length) node.c = nested
    const singles = []
    eachSingle(def, item, '', (path) => singles.push(path))
    if (singles.length) node.s = singles
    return node
  })
}

/**
 * The lists of one record document, as sent: each list's items by path, each item its
 * fingerprint (`h`), its own lists (`c`) and the paths of the single sections under it (`s`).
 * What `harvestRecordItems` pairs with the document the backend returns. Not stored — a bank
 * is (`harvestRecordItems`).
 *
 * @param {object} document - the record's `$`-document
 * @param {object} declaration - its data schema's declaration (`{ name, sections }`)
 * @returns {Object<string, Array<{ h: string, c?: object, s?: string[] }>>} empty when the
 *   record has no list
 */
export function recordItemLists(document, declaration) {
  const lists = {}
  eachRecordList(declaration, document, (path, def, items) => {
    lists[path] = itemsOf(def, items)
  })
  return lists
}

/** Whether a record's lists hold any item at all. */
export function hasListItems(lists) {
  return Object.values(lists || {}).some((items) => items.length > 0)
}

const valueAt = (value, path) =>
  path.split('.').reduce((v, key) => (isPlainObject(v) ? v[key] : undefined), value)

const uuidOf = (item) => (isPlainObject(item) && typeof item.$uuid === 'string' && item.$uuid ? item.$uuid : null)

function pairItems(ours, theirs, at, bank) {
  // Paired by position: the backend returns each list as it was sent. A list that came back
  // with another length is still paired, but without fingerprints, so the next send matches
  // its items by place alone.
  const exact = ours.length === theirs.length
  theirs.forEach((item, k) => {
    const uuid = uuidOf(item)
    if (!uuid) return
    const place = `${at}[${k}]`
    bank[place] = exact ? `${uuid} ${ours[k].h}` : uuid
    // A single section under the item, at its place under it: the uuid alone.
    for (const path of ours[k]?.s || []) {
      const single = uuidOf(valueAt(item, path))
      if (single) bank[`${place}.${path}`] = single
    }
    for (const [path, sub] of Object.entries(ours[k]?.c || {})) {
      const list = valueAt(item, path)
      if (Array.isArray(list)) pairItems(sub, list, `${place}.${path}`, bank)
    }
  })
}

/**
 * The bank entry for one record: each list item's `$uuid` in the document the backend
 * returned (a push's finalized document, or a pull's), with its fingerprint as sent, paired
 * by place with the lists as sent (`recordItemLists`).
 *
 * @param {object} lists - `recordItemLists` of the document as sent
 * @param {object} returned - the backend's document for the same record
 * @returns {Object<string, string>} place → `"<uuid> <fingerprint>"` (or `"<uuid>"`)
 */
export function harvestRecordItems(lists, returned) {
  const bank = {}
  for (const [path, ours] of Object.entries(lists || {})) {
    const theirs = valueAt(returned, path)
    if (Array.isArray(theirs)) pairItems(ours, theirs, path, bank)
  }
  return bank
}

// A list in the backend's document: an array of items that each carry a `$uuid`.
const isStoredList = (v) => Array.isArray(v) && v.length > 0 && v.every((item) => uuidOf(item))

function storedLists(container, prefix, bank, underList = false) {
  for (const [key, value] of Object.entries(container || {})) {
    if (key.startsWith('$') && key !== '$children') continue
    if (isStoredList(value)) {
      value.forEach((item, k) => {
        const place = `${prefix}${key}[${k}]`
        bank[place] = item.$uuid
        storedLists(item, `${place}.`, bank, true)
      })
    } else if (uuidOf(value)) {
      // A section: its lists sit under its name. A single one under a list is banked too.
      if (underList) bank[`${prefix}${key}`] = value.$uuid
      storedLists(value, `${prefix}${key}.`, bank, underList)
    }
  }
}

/**
 * The bank entry for one record read from the backend's document ALONE — for a record whose
 * items were never banked, like one pushed by a CLI from before this. No fingerprints: what
 * was sent is unknown, so the next send matches each item by place.
 *
 * Read by shape: a list is an array whose every item carries a `$uuid`, and a section is an
 * object carrying one — a reference is a string or an `{ schema, entity }`, and a localized
 * value a `{ lang: … }` map, neither of which does. A section under a list is banked at its
 * place, as `harvestRecordItems` banks it.
 *
 * @param {object} returned - the backend's document for one record
 * @returns {Object<string, string>} place → `"<uuid>"`
 */
export function storedRecordItems(returned) {
  const bank = {}
  storedLists(returned, '', bank)
  return bank
}

// The bank's items grouped by list: list path → { index → { u, h, place } }.
function bankedLists(bank) {
  const lists = new Map()
  for (const [place, value] of Object.entries(bank || {})) {
    const m = /^(.*)\[(\d+)\]$/.exec(place)
    if (!m || typeof value !== 'string') continue
    const [u, h] = value.split(' ')
    if (!u) continue
    if (!lists.has(m[1])) lists.set(m[1], [])
    lists.get(m[1])[Number(m[2])] = { u, h: h || null, place }
  }
  return lists
}

// Which banked item each item takes: the same fingerprint first, then the same place.
function matchItems(prints, banked) {
  const assigned = new Array(prints.length).fill(null)
  const taken = new Set()
  const byPrint = new Map()
  banked.forEach((b, j) => {
    if (!b?.h) return
    if (!byPrint.has(b.h)) byPrint.set(b.h, [])
    byPrint.get(b.h).push(j)
  })
  prints.forEach((h, i) => {
    const queue = byPrint.get(h)
    while (queue?.length) {
      const j = queue.shift()
      if (taken.has(j)) continue
      assigned[i] = banked[j]
      taken.add(j)
      break
    }
  })
  prints.forEach((_, i) => {
    if (assigned[i] || taken.has(i) || !banked[i]) return
    assigned[i] = banked[i]
    taken.add(i)
  })
  return assigned
}

// The bank's single sections — a place that does not end in an index — place → uuid.
function bankedSingles(bank) {
  const singles = new Map()
  for (const [place, value] of Object.entries(bank || {})) {
    if (/\]$/.test(place) || typeof value !== 'string') continue
    const [u] = value.split(' ')
    if (u) singles.set(place, u)
  }
  return singles
}

function stampList(def, items, at, banks, counts, claimed) {
  const banked = (at !== null && banks.lists.get(at)) || []
  const assigned = matchItems(items.map((item) => fingerprint(def, item)), banked)
  items.forEach((item, i) => {
    const b = assigned[i]
    if (b && !claimed.has(b.u)) {
      item.$uuid = b.u
      claimed.add(b.u)
      counts.stamped++
    } else {
      counts.unknown++
    }
    // An item's own lists, and its single sections, are banked under the place of the item it
    // matched — a new item's nested items are new too.
    const under = b && item.$uuid === b.u ? b.place : null
    if (under !== null) {
      eachSingle(def, item, '', (path, d, single) => {
        const u = banks.singles.get(`${under}.${path}`)
        if (u && !claimed.has(u)) {
          single.$uuid = u
          claimed.add(u)
          counts.stamped++
        }
      })
    }
    eachList(def, item, '', (path, d, list) =>
      stampList(d, list, under === null ? null : `${under}.${path}`, banks, counts, claimed)
    )
  })
}

/**
 * Stamp a record document about to be sent with its list items' banked `$uuid`s.
 *
 * @param {object} document - the record's `$`-document; stamped in place
 * @param {object} declaration - its data schema's declaration
 * @param {Object<string,string>} bank - this record's entry (`harvestRecordItems` /
 *        `storedRecordItems`)
 * @returns {{ stamped: number, unknown: number }} items given a uuid, and list items sent as new
 */
export function stampRecordItems(document, declaration, bank) {
  const counts = { stamped: 0, unknown: 0 }
  const claimed = new Set()
  const banks = { lists: bankedLists(bank), singles: bankedSingles(bank) }
  eachRecordList(declaration, document, (path, def, items) => {
    stampList(def, items, path, banks, counts, claimed)
  })
  return counts
}

function flatPrints(lists, at, out) {
  for (const [path, items] of Object.entries(lists || {})) {
    items.forEach((node, k) => {
      const place = `${at}${path}[${k}]`
      out[place] = node.h
      flatPrints(node.c, `${place}.`, out)
    })
  }
  return out
}

/**
 * A bank entry with its fingerprints taken again from the record as the NEXT send will
 * build it, each uuid kept at its place. For a record that named a new record by `$ref`:
 * once that record is minted the next send names it by uuid, so an item holding such a
 * reference is fingerprinted anew — the same item, another encoding.
 *
 * @param {Object<string,string>} bank - this record's entry
 * @param {object} lists - `recordItemLists` of the record as the next send builds it
 * @returns {Object<string,string>}
 */
export function reprintRecordItems(bank, lists) {
  const prints = flatPrints(lists, '', {})
  const out = {}
  for (const [place, value] of Object.entries(bank || {})) {
    const [u] = String(value).split(' ')
    out[place] = prints[place] ? `${u} ${prints[place]}` : value
  }
  return out
}
