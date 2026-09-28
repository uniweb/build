// A folder entry's `label` — what an entry is called in its folder — in its two forms, and the one
// rule for which text a language gets. Every lane that touches a label reads it here: the authored
// file (`records-config.js`), the push (`uwx/folder.js`), the pull (`uwx/records-project.js`) and
// the static lane (`query-processor.js` for the site's language, `i18n/records.js` for the others).
//
// ⭐ A LABEL KEEPS EVERY LANGUAGE IT HOLDS [Diego, 2026-09-28]. `records/folder.yml` writes it as one
// text — the site's default language — or as one text per language, `{ en: …, fr: … }`. The form
// is framework's to choose; a map of languages is the start. ⛔ Until then the file held the
// default language only: a pull dropped a label's other languages, and the next push sent the one
// it had kept, so a label translated in an editor lost its translations on a round trip.
//
// On the wire a label is always a map of languages (`{ <locale>: text }`); a backend may also hold
// one plain text for every language, and a pull reads that too.

/** A text, as YAML may type one (`2024` is a number): a non-empty trimmed string, or null. */
function textOf(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text || null
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * A label as an author writes it in `records/folder.yml`, normalized: one text, or a map of
 * languages to texts — an empty one of either is no label.
 *
 * @param {*} value - the entry's `label:`
 * @returns {{ label: string|Object<string,string>|null } | { error: string }}
 */
export function readLabel(value) {
  if (value === undefined || value === null) return { label: null }
  if (typeof value === 'string' || typeof value === 'number') return { label: textOf(value) }
  if (!isPlainObject(value)) return { error: 'is neither a text nor one text per language' }
  const label = {}
  for (const [locale, text] of Object.entries(value)) {
    if (!locale.trim()) return { error: 'names a language with no code' }
    if (text === undefined || text === null) continue
    if (typeof text !== 'string' && typeof text !== 'number') {
      return { error: `gives \`${locale}\` something that is not text` }
    }
    const t = textOf(text)
    if (t) label[locale.trim()] = t
  }
  return { label: Object.keys(label).length ? label : null }
}

/**
 * A label as the wire carries it — a map of languages. One text is the source language's.
 *
 * @param {string|Object<string,string>} label - as `readLabel` returns it
 * @param {string} sourceLocale - the site's default language
 * @returns {Object<string,string>}
 */
export function labelOnWire(label, sourceLocale) {
  if (isPlainObject(label)) return { ...label }
  return { [sourceLocale]: String(label) }
}

/**
 * A label as `records/folder.yml` holds it, from what a store holds: one text when it holds the
 * source language's alone — the form an author writes most — and every language it holds
 * otherwise, the source language first. Null when it holds no text.
 *
 * @param {*} stored - the entry's `label` off the wire: a map of languages, or one text
 * @param {string} sourceLocale - the site's default language
 * @returns {string|Object<string,string>|null}
 */
export function labelForFile(stored, sourceLocale) {
  if (stored === undefined || stored === null) return null
  if (!isPlainObject(stored)) return textOf(stored)
  const texts = Object.entries(stored)
    .map(([locale, text]) => [locale, textOf(text)])
    .filter(([, text]) => text)
  if (texts.length === 0) return null
  if (texts.length === 1 && texts[0][0] === sourceLocale) return texts[0][1]
  // The source language first, then the others as stored.
  texts.sort(([a], [b]) => (a === sourceLocale ? -1 : b === sourceLocale ? 1 : 0))
  return Object.fromEntries(texts)
}

/** `fr-CA` → `fr`; a language with no region is its own base. */
const baseOf = (locale) => (typeof locale === 'string' ? locale.split(/[-_]/)[0] : null)

/**
 * The text a language gets of a label: that language, else its base language (`fr-CA` → `fr`),
 * else the site's default language and its base; else none — as a records service answers `$label`
 * in the read's language and not at all when the label holds none of its chain. One text is every
 * language's.
 *
 * With no language known at all (a caller that did not say), the first text the label holds.
 *
 * @param {string|Object<string,string>|null|undefined} label
 * @param {string|null} locale - the language being answered
 * @param {string|null} [defaultLocale] - the site's default language
 * @returns {string|null}
 */
export function labelIn(label, locale, defaultLocale = null) {
  if (label === undefined || label === null) return null
  if (!isPlainObject(label)) return textOf(label)
  const chain = [locale, baseOf(locale), defaultLocale, baseOf(defaultLocale)].filter(Boolean)
  for (const code of chain) {
    const text = textOf(label[code])
    if (text) return text
  }
  if (!locale && !defaultLocale) {
    for (const text of Object.values(label)) if (textOf(text)) return textOf(text)
  }
  return null
}
