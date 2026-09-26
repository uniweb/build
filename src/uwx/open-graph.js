// ⭐ A PAGE'S OR A SITE'S OPEN GRAPH TITLE AND DESCRIPTION, PER LANGUAGE — `og_title` and
// `og_description` on the wire, `seo.ogTitle` / `seo.ogDescription` in a file.
//
// A file keeps them inside `seo`, whose other keys are crawler and sitemap directives a deployment
// stores as one object. Where the deployment's page — or `settings` — Section declares the two keys
// (`GET /dev/config` → `siteContent.pageFields` / `settingsFields`), a push sends them per language
// through those keys and the rest of `seo` as it is; elsewhere they ride inside `seo` as authored,
// in the source language only. A pull puts them back inside `seo`.
import { localizeScalar } from './locale-sync.js'
import { unwrapLocalized } from './backfill.js'

// wire key → the key inside a file's `seo`
const OPEN_GRAPH_KEYS = [
  ['og_title', 'ogTitle'],
  ['og_description', 'ogDescription'],
]

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Whether a Section's declared keys take the two. */
export function takesOpenGraph(fields) {
  return Array.isArray(fields) && OPEN_GRAPH_KEYS.every(([wire]) => fields.includes(wire))
}

/**
 * A file's `seo` as a push sends it: `{ og_title?, og_description?, seo? }`. The two are taken out
 * of `seo` and localized only where the Section takes them; `seo` is left out when nothing else is
 * in it. A value that is not a string stays where it is.
 */
export function splitOpenGraph(seo, fields, sourceLocale, translations, context = null) {
  if (!takesOpenGraph(fields) || !isRecord(seo)) return { seo }
  const rest = { ...seo }
  const out = {}
  for (const [wire, key] of OPEN_GRAPH_KEYS) {
    if (typeof seo[key] !== 'string') continue
    out[wire] = localizeScalar(seo[key], sourceLocale, translations, context)
    delete rest[key]
  }
  out.seo = Object.keys(rest).length ? rest : undefined
  return out
}

/** One of the two, as a push sends it — or undefined where the Section does not take them. */
export function openGraphValue(seo, wire, fields, sourceLocale, translations, context = null) {
  return splitOpenGraph(seo, fields, sourceLocale, translations, context)[wire]
}

/** `seo` as a push sends it beside the two — without them where the Section takes them. */
export function seoBesideOpenGraph(seo, fields) {
  return splitOpenGraph(seo, fields, null, null).seo
}

/**
 * A document's `og_title` / `og_description` folded back into a file's `seo` — the source
 * language's value — with the other languages handed to `collector` in `context`. Returns `seo`
 * unchanged when the holder carries neither, and undefined for an empty result.
 */
export function foldOpenGraph(holder, seo, sourceLocale, collector = null, context = null) {
  if (!OPEN_GRAPH_KEYS.some(([wire]) => holder?.[wire] !== undefined)) return seo
  const out = isRecord(seo) ? { ...seo } : {}
  for (const [wire, key] of OPEN_GRAPH_KEYS) {
    const value = holder?.[wire]
    if (value === undefined) continue
    collector?.add(value, context)
    const source = unwrapLocalized(value, sourceLocale)
    if (typeof source === 'string' && source !== '') out[key] = source
  }
  return Object.keys(out).length ? out : undefined
}
