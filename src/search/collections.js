/**
 * Generate search index for a file-based collection.
 *
 * Collection cascade files (`data/{name}.json`) contain all non-deferred fields.
 * If `search.fetchDetail: true` is set, the caller is responsible for merging
 * per-record detail files into each item before calling this function.
 */

/**
 * @param {string} name - Collection name (e.g. "articles")
 * @param {Object} config - Collection config from site.yml (config.collections[name])
 * @param {Object} collectionData - Parsed cascade JSON (`data/{name}.json`)
 * @param {string} locale - Locale code (e.g. "en")
 * @returns {Object} Collection search index
 */
export function generateCollectionIndex(name, config, collectionData, locale) {
  const fields = config.search?.fields || ['title']
  const weight = config.search?.weight ?? 0.7
  const items = collectionData?.items || []

  const entries = items.map(item => {
    const content = fields.map(f => item[f] || '').filter(Boolean).join(' ')
    const slug = item.slug || item.id || String(item.title || '').toLowerCase().replace(/\s+/g, '-')
    return {
      id: `collection:${name}:${slug}`,
      type: 'collection',
      collection: name,
      route: `${config.route}/${slug}`,
      title: item.title || item.name || slug,
      content,
      excerpt: content.length > 160
        ? content.slice(0, 160).trim() + '…'
        : content,
      weight,
      item: pickDisplayFields(item),
    }
  })

  return {
    type: 'collection',
    collection: name,
    locale,
    generated: new Date().toISOString(),
    entries,
  }
}

function pickDisplayFields(item) {
  const { slug, title, name, date, image, author, excerpt, role } = item
  return Object.fromEntries(
    Object.entries({ slug, title, name, date, image, author, excerpt, role })
      .filter(([, v]) => v != null)
  )
}
