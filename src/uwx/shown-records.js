/**
 * The queries whose records a site's pages SHOW live — what the `records` service is for.
 *
 * ⭐ `records` is the live delivery of records to a published site, nothing else
 * [Diego, 2026-10-07: "syncing records is unrelated to `records` being on/off. The
 * service is the live delivery of records to published site"]. So what decides whether a
 * site needs it is what its published pages fetch — never whether it has records to sync.
 * A query counts when a page, a section or the site fetches it, and its records have a
 * data schema (the declaration names one) and come from the site's own folder (no `url:`).
 * A schema-less query's records are delivered as static files, which `records` does not
 * touch; an external query is fetched from its own address.
 *
 * @module
 */

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {object} doc - a site-content document, as a push sends it
 * @returns {string[]} the query names, sorted
 */
export function recordQueriesShown(doc) {
  const fetched = new Set()
  const take = (fetch) => {
    for (const one of [fetch].flat()) if (isMap(one) && typeof one.query === 'string' && one.query) fetched.add(one.query)
  }
  const walkSections = (sections) => {
    for (const section of Array.isArray(sections) ? sections : []) {
      take(section?.params?.fetch)
      take(section?.fetch)
      walkSections(section?.$children)
    }
  }
  const walkPages = (pages) => {
    for (const page of Array.isArray(pages) ? pages : []) {
      take(page?.fetch)
      walkSections(page?.page_sections)
      walkPages(page?.$children)
    }
  }
  take(doc?.settings?.fetch)
  walkPages(doc?.pages)
  walkSections(doc?.layout_sections)
  const live = new Set()
  for (const query of Array.isArray(doc?.queries) ? doc.queries : []) {
    if (!isMap(query) || typeof query.name !== 'string') continue
    if (typeof query.schema !== 'string' || !query.schema) continue
    if (isMap(query.source) && query.source.url !== undefined) continue
    live.add(query.name)
  }
  return [...fetched].filter((name) => live.has(name)).sort()
}
