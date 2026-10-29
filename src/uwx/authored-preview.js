/**
 * `site.yml::preview` — the site's card image — is an author's address: a URL, or a
 * path to an image in the project. This is the one test that says whether a value
 * is one.
 *
 * Anything else is not the author's. The app once recorded a card image it generated
 * as a token in this field, so a site.yml from an older pull may still hold one: the
 * push leaves such a value out (`site.js`), a pull removes it (`site-project.js`), and
 * `uniweb snapshot` replaces it.
 *
 * It recognizes the author's shapes rather than the token's, so it does not depend on
 * the token's format: a URL, a path starting `/`, `./` or `../`, or a relative path to
 * an image file (`images/card.png`).
 */

const IMAGE_FILE = /\.(avif|gif|jpe?g|png|svg|webp)$/i

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is an author's address
 */
export const isAuthoredPreview = (value) =>
  typeof value === 'string' &&
  (/^https?:\/\//i.test(value) || /^\.{0,2}\//.test(value) || IMAGE_FILE.test(value.trim()))
