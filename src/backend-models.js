/**
 * The system Models whose records only a backend holds — `@uniweb/catalog`, a site backend's store.
 *
 * A site READS one and holds none. It names one in a query (`queries.yml`: `schema: '@uniweb/catalog'`)
 * and in a data key (`meta.js`: `data: { store: { schema: '@uniweb/catalog', whole: true } }`), and the
 * published site's records service answers it: the catalogs its owner made public, each with its
 * offerings and prices, which a visitor who isn't signed in may see. Its records are written in the
 * app, on the site's backend, so no file of a site is one: a build or a push that finds one stops.
 *
 * ⭐ NOTHING HERE DEFINES ONE. The backend's definition is the only one, and the app edits it with its
 * own screen, so a copy kept here could only drift from it. That is the difference from the system
 * Models a site's records may name (`@uniweb/schemas/system`: `@uniweb/link`, `@uniweb/file`), whose
 * definitions a site with no backend builds and validates its own records with.
 *
 * ⛔ Until 2026-11-16 every build refused the name as reserved, and a push named it a Model the backend
 * has none of (the backend's data-schema read answers 404 for its system Models, `@uniweb/link`
 * included, measured on a local backend that day), so a site could not declare its store at all.
 */

/** The backend-held system Models, by their full name. */
export const BACKEND_MODELS = Object.freeze(['@uniweb/catalog'])

/** Is this ref one of them? */
export function isBackendModel(ref) {
  return typeof ref === 'string' && BACKEND_MODELS.includes(ref)
}

/**
 * The refusal for files kept as records of one — `records/uniweb/catalog/`.
 *
 * @param {string} where - the directory, as the author wrote it (`records/uniweb/catalog/`)
 * @param {string} ref - the Model (`@uniweb/catalog`)
 */
export function backendRecordsRefusal(where, ref) {
  return (
    `${where}: ${ref} is a site backend's own, so a site holds none of its records. Its owner writes ` +
    `them in the app, on the site's backend; the site reads them with a query (\`schema: '${ref}'\` in ` +
    `queries.yml). Remove these files.`
  )
}

/**
 * What a build says about a query of one, which no build has records for: the published site's
 * records service answers it, and a local run sees it with `uniweb dev --published`.
 *
 * @param {string} name - the query's name
 * @param {string} ref - the Model
 */
export function backendQueryNote(name, ref) {
  return (
    `Query "${name}" reads ${ref}, which only a site backend holds, so a build has none of its records. ` +
    'On the published site, its records service answers it, with what the site\'s owner made public; ' +
    '`uniweb dev --published` shows that here.'
  )
}
