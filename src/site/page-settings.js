/**
 * ⭐ A PAGE THAT IS ONE `.md` FILE HOLDS ITS PAGE'S SETTINGS IN ITS FRONTMATTER — an atomic page, one
 * file in folder mode, beside its section's `type` and params. The file is the page and its one
 * section, so a key a `page.yml` would give the page is the page's, and a param of the same name is
 * written under `props:`, which merges into the params (`SECTION_KEYS.props`, `@uniweb/schemas/section`).
 *
 * One list, for every lane that reads or writes such a page: the build
 * (`content-collector.js::processFileAsPage`), the push (`uwx/site.js::folderModePageRecords`) and the
 * pull (`uwx/page-files.js::mdPageCannotHold`, `uwx/site-project.js::writeMdPage`).
 *
 * ⛔ NOT IN IT, each for a reason:
 * - `id` — a section key, the section's id, as it has always been. A page's identity in an atomic-parent
 *   is its file's name, so a page renamed in the app keeps its section's id without the page taking a
 *   new one. A page id its file name does not give is held by a pull.
 * - `hidden` — a section key too, already the page's: the file IS the page, so it drafts the page.
 * - `query`, `fetch` — the section's own data. For a page of one section with no child page, the page's
 *   data and its section's reach the same section.
 * - `redirect`, `rewrite` — they make a page that holds no section, which an atomic page is not.
 * - `index`, `pages`, `sections`, `nest`, `mount` — they shape or order pages and sections, which a page
 *   of one file has none of.
 *
 * Until 2026-11-08 every one of these keys was a section param: the build gave the page its first
 * heading as its title and nothing else, the push sent only that title, and a pull held any page the
 * app gave a description, a label or any other setting.
 */

/** The keys of an atomic page's frontmatter that are its page's settings, as a `page.yml` spells them. */
export const ATOMIC_PAGE_KEYS = Object.freeze([
  'title',
  'description',
  'label',
  'keywords',
  'slug',
  'hideIn',
  'layout',
  'seo',
  'knowledge',
  'trackSections',
])

const KEYS = new Set(ATOMIC_PAGE_KEYS)

/**
 * Whether `name` is one of an atomic page's settings in its frontmatter.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isAtomicPageKey(name) {
  return KEYS.has(name)
}

/**
 * The page's settings an atomic page's frontmatter holds, as written.
 *
 * @param {object} frontmatter - the file's frontmatter
 * @returns {object} each page key the frontmatter gives, and no other
 */
export function atomicPageConfig(frontmatter) {
  const out = {}
  if (!frontmatter || typeof frontmatter !== 'object') return out
  for (const key of ATOMIC_PAGE_KEYS) if (frontmatter[key] !== undefined) out[key] = frontmatter[key]
  return out
}

/**
 * Say, with the file in hand, each page key of an atomic page's frontmatter that its section type
 * also declares as a param: the page takes the value, and the section receives none. A warning, since
 * the page renders; writing the param under `props:` gives it to the section.
 *
 * @param {object} pageConfig - the page's settings as written (`atomicPageConfig`)
 * @param {string|null} type - the section's `type:`; with none, the foundation's `defaultSection`
 * @param {Object|null} sectionTypes - the foundation's schema, each section type's entry by name;
 *   null when it is not at hand
 * @param {(message: string) => void} warn - prints one message, prefixed with the file
 */
export function warnPageKeysNamingParams(pageConfig, type, sectionTypes, warn) {
  const name = type || sectionTypes?._self?.defaultSection || null
  const entry = name && !name.startsWith('_') ? sectionTypes?.[name] : null
  const params = entry && typeof entry === 'object' ? entry.params : null
  if (!params || typeof params !== 'object') return
  for (const key of Object.keys(pageConfig)) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue
    warn(
      `\`${key}:\` is the page's ${key}, since the page is this one file. ${name} has a \`${key}\` param too, ` +
        `which receives nothing: write it under \`props:\` to give it to the section (\`props: { ${key}: … }\`).`
    )
  }
}
