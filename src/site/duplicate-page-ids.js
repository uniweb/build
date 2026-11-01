/**
 * Two pages with one `id:` — a `page:` link names one of them, and which one depends on the order
 * the site lists them in, so a link can lead to the wrong page with nothing to say so. Ids must be
 * unique across a site (`page-id-uniqueness`), and copying a folder of pages is how they stop being:
 * the id travels with the copy.
 *
 * @param {Array<{id?: string|null, route: string}>} pages
 * @returns {Array<{id: string, routes: string[]}>} what it warned about
 */
export function warnOfDuplicatePageIds(pages) {
  const routesOf = new Map()
  for (const { id, route } of pages) {
    if (id === null || id === undefined || id === '') continue
    routesOf.set(id, [...(routesOf.get(id) ?? []), route])
  }
  const duplicates = [...routesOf]
    .filter(([, routes]) => routes.length > 1)
    .map(([id, routes]) => ({ id, routes }))
  for (const { id, routes } of duplicates) {
    console.warn(
      `[uniweb] Page id "${id}" is on ${routes.length} pages: ${routes.join(', ')}. ` +
        `A \`page:${id}\` link leads to only one of them. Give each its own id, or remove the id and link by path.`
    )
  }
  return duplicates
}
