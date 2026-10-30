/**
 * ⭐ A LINK TO A PAGE IS A PATH IN FILES AND AN ID IN THE STORE (2026-10-29) [Diego: "When working
 * on the app, it is convenient. but with md content, it's easier to see paths than ids"].
 *
 * An editor links a page by its stable id (`page:3f58142d`): an author picks the page from a list,
 * and the id keeps the link when the page is renamed there, since a store keeps a link as written.
 * A file is read and typed, and `page:ai` says where it goes. So the sync translates where it
 * already reads rich text: a push stores a link by its page's id when the page has one
 * (`storedPageRef`), and a pull writes a stored link as its page's path (`writtenPageRef`). A pull
 * and then a push change nothing, each turning back what the other wrote.
 *
 * ⭐ ONLY A CODE IS TRANSLATED. An id an author chose is a word (`installation`, `home`), reads as
 * well as a path, and is kept as written both ways; translating it would rewrite a file a round trip
 * should leave alone (measured: a docs site's ten files, on the round trip that caught it). A code
 * (`isCodeId`: hex with a digit, as an editor mints it) is what a file shows as the page's path, and
 * what a push stores for a path to a page that has one. A code an author typed into a file comes
 * back the page's path after one pull.
 *
 * Both read a reference as the runtime does (`core/src/website.js`, `_pageIdMap`): by a page's
 * stable id, else by its route, the homepage's being `page:/`. So a path written into a file names
 * the page its id named. A path that another page's id claims, and a parametric page, stay ids.
 *
 * A reference lives in a link or button mark's `href`, a linked image's `href`, any string in a
 * section's params that is one `page:` reference (a `detailPage`, a button's link), and a page's
 * `redirect`. ⛔ Never in text: a code span that reads `page:about` is words about a link.
 */

const PAGE_REF = /^page:([^#]*)(#.*)?$/

/** A route as a `page:` reference names it: no leading or trailing slash, the homepage `''`. */
const routeKey = (route) => String(route).replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * Whether a page's id is a code rather than a word: eight or more hex characters with a digit
 * among them, the shape an editor mints (`3f58142d`). `installation`, `home` and `v1-guide` are
 * words, and so is `cafe`.
 *
 * @param {string|null} id
 * @returns {boolean}
 */
export function isCodeId(id) {
  return typeof id === 'string' && /^(?=[0-9a-f]*[0-9])[0-9a-f]{8,}$/.test(id)
}

/**
 * The site's pages, each with the route a build gives it, in page order.
 *
 * @param {Array<object>} pages - page records (`stable_id`, `slug`, `$children`, …)
 * @param {string} sourceLocale
 * @param {(record: object, parentRoute: string, sourceLocale: string) => string} routeOf -
 *   `buildRouteOf`, passed in so this module stays a leaf
 * @returns {Array<{ id: string|null, route: string, dynamic: boolean }>}
 */
export function pageRefPages(pages, sourceLocale, routeOf) {
  const out = []
  const walk = (list, parentRoute) => {
    for (const record of list || []) {
      if (!record || typeof record !== 'object') continue
      const route = routeOf(record, parentRoute, sourceLocale)
      out.push({ id: typeof record.stable_id === 'string' && record.stable_id ? record.stable_id : null, route, dynamic: record.is_dynamic === true })
      walk(record.$children, route)
    }
  }
  walk(pages, '/')
  return out
}

/**
 * What a `page:` reference resolves to among a site's pages, by the runtime's rule: a page's id
 * (which wins over any route), else its route, a target read the way a route is.
 *
 * @param {Array<{ id: string|null, route: string, dynamic: boolean }>} pages - `pageRefPages`
 * @returns {{ resolve: (target: string) => object|undefined }}
 */
export function pageRefIndex(pages) {
  const byName = new Map()
  for (const page of pages) {
    if (page.id) byName.set(page.id, page)
    const key = routeKey(page.route)
    if (!byName.has(key)) byName.set(key, page)
  }
  return {
    resolve: (target) =>
      typeof target === 'string' ? (byName.get(target) ?? byName.get(routeKey(target))) : undefined,
  }
}

/**
 * A push's form of a reference: `page:<code>` when the page it names has a code for its id
 * (`isCodeId`), else as written — a path to a page whose id is a word, or none, stays a path. A
 * section after `#` rides along unchanged.
 *
 * @param {string} ref
 * @param {{ resolve: Function }} index - `pageRefIndex`
 * @returns {string}
 */
export function storedPageRef(ref, index) {
  const m = typeof ref === 'string' ? PAGE_REF.exec(ref) : null
  const page = m && index.resolve(m[1])
  return isCodeId(page?.id) ? `page:${page.id}${m[2] || ''}` : ref
}

/**
 * A pull's form of a reference that names its page by a code: `page:<path>`, when that path
 * names the same page back, else as stored. Any other reference — a path, a word id — is written
 * as stored. The homepage is `page:/`.
 *
 * @param {string} ref
 * @param {{ resolve: Function }} index - `pageRefIndex`
 * @returns {string}
 */
export function writtenPageRef(ref, index) {
  const m = typeof ref === 'string' ? PAGE_REF.exec(ref) : null
  const page = m && index.resolve(m[1])
  if (!page || page.dynamic || m[1] !== page.id || !isCodeId(page.id)) return ref
  const path = routeKey(page.route) || '/'
  return index.resolve(path) === page ? `page:${path}${m[2] || ''}` : ref
}

/**
 * Every page reference in a site's page and layout records, through `map`: each section's content
 * in every language, its params and its subsections, and each page's `redirect` and child pages.
 * Mutates the records.
 *
 * @param {{ pages?: Array<object>, layoutSections?: Array<object> }} records
 * @param {(ref: string) => string} map - `storedPageRef` or `writtenPageRef`, bound to an index
 */
export function mapPageRefs({ pages, layoutSections }, map) {
  const section = (record) => {
    if (!record || typeof record !== 'object') return
    if (record.content && typeof record.content === 'object') mapContent(record.content, map)
    if (record.params && typeof record.params === 'object') record.params = mapValue(record.params, map)
    for (const child of record.$children || []) section(child)
  }
  const page = (record) => {
    if (!record || typeof record !== 'object') return
    if (typeof record.redirect === 'string') record.redirect = map(record.redirect)
    for (const s of record.page_sections || []) section(s)
    for (const child of record.$children || []) page(child)
  }
  for (const record of pages || []) page(record)
  for (const record of layoutSections || []) section(record)
}

/** A section's content: one document, or one per language (`{ en: doc, fr: doc }`). */
function mapContent(content, map) {
  if (content.type === 'doc') return mapDoc(content, map)
  for (const doc of Object.values(content)) if (doc?.type === 'doc') mapDoc(doc, map)
}

/** Each `href` on a node or a mark in a rich-text document — a link, a button, a linked image. */
function mapDoc(node, map) {
  if (!node || typeof node !== 'object') return
  if (typeof node.attrs?.href === 'string') node.attrs.href = map(node.attrs.href)
  for (const mark of node.marks || []) {
    if (typeof mark?.attrs?.href === 'string') mark.attrs.href = map(mark.attrs.href)
  }
  if (Array.isArray(node.content)) for (const child of node.content) mapDoc(child, map)
}

/** A params value, with each string that is one `page:` reference through `map`. */
function mapValue(value, map) {
  if (typeof value === 'string') return PAGE_REF.test(value) ? map(value) : value
  if (Array.isArray(value)) return value.map((v) => mapValue(v, map))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) out[key] = mapValue(v, map)
    return out
  }
  return value
}
