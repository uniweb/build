/**
 * ⭐ A SOURCE EDIT KEEPS ITS TRANSLATION UNTIL SOMEONE REVIEWS IT, in a file as in the app: a slightly
 * outdated sentence beats a sudden one in the source language, and a typo fixed in the source should
 * not change a translated page. So a row with no translation, in a place where a similar text has gone,
 * takes that text's translation, and its entry says so (`{ default, outdated: { place: older text } }`).
 * It is what a pull writes for an edit made in the app (`uwx/locale-sync.js::settleEntry`), and a push
 * sends it back as the app keeps it.
 *
 * ⛔ Until 2026-10-31 the row fell back to the source at the next build or push, whatever the edit.
 *
 * Each lane reads the old text from its own record: `uniweb i18n sync` from the manifest it is about to
 * replace, a push from the store it is about to change. Only a block element's text in a page's section,
 * as the app's rows are: a picture, a data block's string, a page's title and a record's body fall back
 * as they did.
 */

import { computeHash } from './hash.js'
import { toPlainText } from './merge.js'
import { isSmallEdit, wordOverlap } from './word-overlap.js'
import { discoverLocales, loadLocaleTranslations, translationFor, addTranslationEntries } from '../uwx/locale-sync.js'

// A language's words for a text here. Not an empty one, nor the text's own: `uniweb i18n init` starts a
// language's file with each text's source, and that is nothing to keep.
function translationHere(table, text, context) {
  const hash = computeHash(text)
  const said = translationFor(table[hash], context)
  if (typeof said !== 'string' || said.trim() === '' || computeHash(toPlainText(said)) === hash) return undefined
  return said
}

// Whether a language has nothing written for a row here.
function wants(table, row, context) {
  const said = translationFor(table[computeHash(row)], context)
  return typeof said !== 'string' || said.trim() === ''
}

/**
 * The entries a language takes for what changed. A row with a translation here keeps it, and a text
 * that has gone goes to one row, the most like it: of a sentence split in two, one half keeps it.
 *
 * @param {{ [place: string]: string[] }} previous - each place's rows as they were
 * @param {{ [place: string]: string[] }} current - each place's rows now, in order
 * @param {object} table - the language's translation file
 * @returns {{ [hash: string]: object }} what to add to the file
 */
export function carriedTranslations(previous, current, table) {
  const added = {}
  for (const [place, rows] of Object.entries(current)) {
    const context = { key: place }
    const now = new Set(rows.map(computeHash))
    const gone = new Map()
    for (const text of previous[place] || []) {
      const hash = computeHash(text)
      const said = translationHere(table, text, context)
      if (!now.has(hash) && said !== undefined) gone.set(hash, { text, said })
    }
    if (gone.size === 0) continue
    const wanting = new Map()
    for (const row of rows) {
      if (wants(table, row, context)) wanting.set(computeHash(row), row)
    }
    const pairs = []
    for (const [hash, row] of wanting) {
      for (const [from, { text }] of gone) {
        if (isSmallEdit(text, row)) pairs.push({ hash, from, overlap: wordOverlap(text, row) })
      }
    }
    pairs.sort((x, y) => y.overlap - x.overlap)
    const taken = new Set()
    for (const { hash, from } of pairs) {
      if (taken.has(hash) || !gone.has(from)) continue
      const { text, said } = gone.get(from)
      gone.delete(from)
      taken.add(hash)
      const entry = (added[hash] ||= table[hash] && typeof table[hash] === 'object' ? { ...table[hash] } : {})
      if (entry.default === undefined) entry.default = said
      else if (entry.default !== said) entry.overrides = { ...entry.overrides, [place]: said }
      entry.outdated = { ...entry.outdated, [place]: text }
    }
  }
  return added
}

/**
 * What each place held at the last extraction: a manifest's units that are a block element's text.
 *
 * @param {object|null} manifest
 * @returns {{ [place: string]: string[] }}
 */
export function manifestRows(manifest) {
  const rows = {}
  for (const unit of Object.values(manifest?.units || {})) {
    if (!/^(title|subtitle|heading|paragraph|list)(\.|$)/.test(unit.field || '')) continue
    for (const context of unit.contexts || []) {
      if (context.section === '_meta' || context.section === '_site') continue
      ;(rows[`${context.page}:${context.section}`] ||= []).push(unit.source)
    }
  }
  return rows
}

// Each language's translation file but the source's, if it has one.
function languageTables(siteRoot, sourceLocale) {
  return loadLocaleTranslations(siteRoot, discoverLocales(siteRoot).filter((locale) => locale !== sourceLocale))
}

/**
 * Whether a language has no words for one of these rows. Only such a row can keep a translation, so a
 * push that finds none has no reason to read the store.
 *
 * @param {string} siteRoot
 * @param {{ [place: string]: string[] }} current
 * @param {{ sourceLocale?: string }} [o]
 * @returns {boolean}
 */
export function rowsWantTranslation(siteRoot, current, { sourceLocale = null } = {}) {
  const tables = Object.values(languageTables(siteRoot, sourceLocale))
  return Object.entries(current).some(([place, rows]) =>
    rows.some((row) => tables.some((table) => wants(table, row, { key: place }))),
  )
}

/**
 * Give each language's file what `carriedTranslations` finds, and say what it found.
 *
 * @param {string} siteRoot
 * @param {{ [place: string]: string[] }} previous
 * @param {{ [place: string]: string[] }} current
 * @param {object} [o]
 * @param {string} [o.sourceLocale] - its file, if it has one, is no translation
 * @param {boolean} [o.dryRun]
 * @returns {{ [locale: string]: Array<{ was: string, now: string }> }} a language with nothing kept is absent
 */
export function keepEditedTranslations(siteRoot, previous, current, { sourceLocale = null, dryRun = false } = {}) {
  const sourceOf = new Map(Object.values(current).flat().map((text) => [computeHash(text), text]))
  const kept = {}
  for (const [locale, table] of Object.entries(languageTables(siteRoot, sourceLocale))) {
    const added = carriedTranslations(previous, current, table)
    if (Object.keys(added).length === 0) continue
    if (!dryRun) addTranslationEntries(siteRoot, locale, added)
    kept[locale] = Object.entries(added).flatMap(([hash, entry]) =>
      [...new Set(Object.values(entry.outdated))].map((was) => ({ was, now: sourceOf.get(hash) })),
    )
  }
  return kept
}
