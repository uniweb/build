/**
 * ⭐ WHAT A PUSH LEAVES OUT: a page or a section a pull HELD. The app changed it in a way its files
 * cannot say — a second section on an atomic page, a setting an `.md` page has no
 * place for, a move to where a page cannot sit — so the pull wrote nothing for it, and the site keeps
 * the app's version (`site-project.js`, `report.held`).
 *
 * The pull records where the files keep each held unit, and what they said there (`heldUnitsOf`). A push
 * sends none whose files still say it: the backend then keeps the app's version, since it deletes only
 * an item a push holds a version for, and a pull banks none for a held one. A push stops on one whose
 * files changed since the pull, because the app's version and the file's would both claim it
 * (`leaveHeldOut`). `--force` sends the files' version over the app's, as it sends everything else.
 *
 * ⛔ Until 2026-11-04 a held page kept the version this copy last agreed on, for the backend's gate to
 * keep the app's. A copy that never agreed on one — a fresh clone, a CI checkout, a copy that lost its
 * `.uniweb/` — banked the backend's version on its first pull, and its next push sent the file over the
 * app's edit.
 *
 * Both sides compare the document the files give before any media is rewritten (`plain`): a push that
 * has uploaded a picture names its serve URL, and the pull that recorded the page named none.
 */
import { computeUnitHashes, walkSiteUnits } from './site-diff.js'

const isPageUnit = (path) => path.endsWith('/page.yml') || path.endsWith('/folder.yml')
// A page's own units and everything below it share its folder: `pages/docs/guide/…`.
const belowPage = (path) => `${path.slice(0, path.lastIndexOf('/'))}/`

/**
 * The units a pull held, as the files keep them: each held item's unit, and for a page every unit
 * below it, by its path in the files' document, with the hash the files gave each.
 *
 * @param {object} p
 * @param {Object<string,string>} p.hashes - path → hash, of the files' document (`computeUnitHashes`)
 * @param {Object<string,string>} p.uuids - path → `$uuid`, of the same document stamped with the
 *   identity this copy held before the pull, so a page the app moved is found where the files keep it
 * @param {Iterable<string>} p.held - the `$uuid`s the pull held
 * @returns {Object<string,string>} path → hash; a held item the files do not hold has no entry
 */
export function heldUnitsOf({ hashes = {}, uuids = {}, held = [] } = {}) {
  const wanted = new Set(held)
  const out = {}
  const pages = []
  for (const [path, uuid] of Object.entries(uuids)) {
    if (!wanted.has(uuid) || !(path in hashes)) continue
    out[path] = hashes[path]
    if (isPageUnit(path)) pages.push(belowPage(path))
  }
  for (const [path, hash] of Object.entries(hashes)) if (pages.some((p) => path.startsWith(p))) out[path] = hash
  return out
}

/**
 * Take the held units out of a push's document where the files still say what they said at the pull.
 * When any of them changed — its file edited or removed, or a page or section added below a held page —
 * nothing is taken out, and the paths are returned for the push to stop on.
 *
 * @param {object} doc - the site-content document a push sends; changed in place
 * @param {object} p
 * @param {Object<string,string>} p.held - what the pull recorded (`heldUnitsOf`)
 * @param {object} [p.plain] - the same document before any media was rewritten; `doc` when absent
 * @param {string} [p.sourceLocale]
 * @returns {{ left: string[], changed: string[], uuids: string[] }} the paths taken out, or the paths
 *   that changed; and the `$uuid` of every item taken out, nested ones included, which the push sends
 *   no version for
 */
export function leaveHeldOut(doc, { held = {}, plain = null, sourceLocale } = {}) {
  const paths = Object.keys(held)
  if (!doc || !paths.length) return { left: [], changed: [], uuids: [] }
  const now = computeUnitHashes(plain ?? doc, sourceLocale)
  const changed = new Set(paths.filter((path) => now[path] !== held[path]))
  const pages = paths.filter(isPageUnit).map(belowPage)
  for (const path of Object.keys(now)) if (!(path in held) && pages.some((p) => path.startsWith(p))) changed.add(path)
  if (changed.size) return { left: [], changed: [...changed].sort(), uuids: [] }

  const drop = new Set()
  walkSiteUnits(doc, (path, record) => {
    if (path in held) drop.add(record)
  }, sourceLocale)
  // ⭐ WHAT IS TAKEN OUT IS SENT NO VERSION. The site-content entity sends every version this copy
  // holds, and a version for an item the document leaves out makes leaving it out a deletion
  // (`withBaseVersion`, `sync-package.js`). So every item taken out is named, the sections and child
  // pages below a held page included, for the push to send none. ⛔ Until 2026-11-05 none was named:
  // a forced push banked a version for each held page it sent, and the next push left the page out
  // and sent that version, which deletes it.
  const uuids = new Set()
  const under = (record) => {
    if (record?.$uuid) uuids.add(record.$uuid)
    for (const s of record?.page_sections || []) under(s)
    for (const c of record?.$children || []) under(c)
  }
  for (const record of drop) under(record)
  const keep = (list) => list.filter((r) => !drop.has(r))
  const sections = (list) => {
    for (const s of list || []) {
      if (Array.isArray(s.$children)) s.$children = keep(s.$children)
      sections(s.$children)
    }
  }
  const walk = (list) => {
    for (const page of list || []) {
      if (Array.isArray(page.page_sections)) page.page_sections = keep(page.page_sections)
      sections(page.page_sections)
      if (Array.isArray(page.$children)) page.$children = keep(page.$children)
      walk(page.$children)
    }
  }
  if (Array.isArray(doc.pages)) doc.pages = keep(doc.pages)
  walk(doc.pages)
  return { left: paths.sort(), changed: [], uuids: [...uuids].sort() }
}
