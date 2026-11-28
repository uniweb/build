/**
 * WHAT `uniweb dev` SHOWS OF WHAT IS HIDDEN.
 *
 * `hidden: true` on a section or a page, and `draft: true` on a record, mean one thing wherever a
 * page is shown: left out. A published build leaves them out, the app's preview leaves a hidden
 * section out, and so does `uniweb dev` [Diego, 2026-11-28]. Seeing one while you work on it is a
 * choice of the tool, not a state of the content, so it is a flag: `uniweb dev --hidden` keeps them,
 * and marks each hidden section and page it shows, so nobody takes one for part of the published
 * page. The flag reaches the dev server `dev` starts in its environment (`HIDDEN_ENV`), as
 * `--published` does.
 *
 * ⛔ Until 2026-11-28 `uniweb dev` always kept them, and marked nothing: a section an author hid in
 * the app came back in the developer's dev server after a pull, while the author's own preview left
 * it out.
 *
 * The marks are the dev server's alone: a style and a small script in the page it serves. Nothing
 * here reaches the runtime, core, or what a build writes.
 */

import { sectionDomId } from '@uniweb/core/section-id'
import { withoutHidden } from './content-collector.js'

/** The environment variable `uniweb dev --hidden` sets for the dev server it starts. */
export const HIDDEN_ENV = 'UNIWEB_DEV_HIDDEN'

/**
 * Whether this dev server was asked to show what is hidden.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
export function showsHidden(env = process.env) {
  return env[HIDDEN_ENV] === '1'
}

/** Each section's DOM id, its child sections' included. */
function sectionIds(sections, into) {
  for (const section of Array.isArray(sections) ? sections : []) {
    into.push(sectionDomId(section))
    sectionIds(section?.subsections, into)
  }
  return into
}

/** The DOM ids of a list's hidden sections, each with its child sections, which are hidden with it. */
function hiddenSectionIds(sections, into = []) {
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section?.hidden === true) sectionIds([section], into)
    else hiddenSectionIds(section?.subsections, into)
  }
  return into
}

/**
 * What is hidden in the collected site: the routes of the hidden pages, each with its subtree, and
 * the DOM ids of the hidden sections, by the route of the page that holds them. A layout area's are
 * under `'*'`, since an area is drawn on every page of its layout.
 *
 * @param {Object} content - the collected site, hidden content kept
 * @returns {{ pages: string[], sections: Object<string, string[]>, count: { pages: number, sections: number } }}
 */
export function hiddenInSite(content) {
  const pages = Array.isArray(content?.pages) ? content.pages : []
  const shownRoutes = new Set((withoutHidden({ pages }).pages || []).map((page) => page.route))
  const hiddenPages = pages.filter((page) => !shownRoutes.has(page.route)).map((page) => page.route)
  if (content?.notFound?.hidden === true) hiddenPages.push(content.notFound.route)

  const sections = {}
  let count = 0
  const add = (route, ids) => {
    if (!ids.length) return
    sections[route] = [...(sections[route] || []), ...ids]
    count += ids.length
  }
  for (const page of pages) add(page.route, hiddenSectionIds(page.sections))
  if (content?.notFound) add(content.notFound.route, hiddenSectionIds(content.notFound.sections))
  for (const areas of Object.values(content?.layouts || {})) {
    for (const area of Object.values(areas || {})) add('*', hiddenSectionIds(area?.sections))
  }
  return { pages: hiddenPages, sections, count: { pages: hiddenPages.length, sections: count } }
}

/**
 * The line the dev server prints about what is hidden, or null when nothing is.
 *
 * @param {{ count: { pages: number, sections: number } }} hidden - `hiddenInSite`
 * @param {boolean} shown - whether this server shows what is hidden
 * @returns {string|null}
 */
export function hiddenNote(hidden, shown) {
  const { pages, sections } = hidden.count
  if (!pages && !sections) return null
  const parts = []
  if (sections) parts.push(`${sections} hidden section${sections === 1 ? '' : 's'}`)
  if (pages) parts.push(`${pages} hidden page${pages === 1 ? '' : 's'}`)
  const what = parts.join(' and ')
  return shown
    ? `[site-content] Showing ${what}, marked as hidden, and draft records (uniweb dev --hidden)`
    : `[site-content] Leaving out ${what}, as a published site does. To see them: uniweb dev --hidden`
}

/**
 * The style and script that mark what is hidden in a page the dev server serves: a dashed outline
 * and a label on each hidden section, and a banner on a hidden page. The script reads the page the
 * runtime shows (`activeWebsite.activePage`) after each render, since the browser renders every
 * page of the site itself. An attribute on a section the runtime drew, never an element inserted
 * into one: React owns what is inside.
 *
 * @param {{ pages: string[], sections: Object<string, string[]> }} hidden - `hiddenInSite`
 * @returns {string} HTML for the page's head
 */
export function hiddenMarks(hidden) {
  const data = JSON.stringify({ pages: hidden.pages, sections: hidden.sections }).replace(/</g, '\\u003c')
  const label = 'font:600 12px/1.6 system-ui,sans-serif;color:#fff;background:#b45309;padding:0 .5rem;border-radius:4px;pointer-events:none;z-index:2147483647'
  const style =
    `[data-uw-hidden]{outline:2px dashed #b45309;outline-offset:-2px;position:relative}` +
    `[data-uw-hidden]::after{content:'Hidden: not published';position:absolute;top:.5rem;right:.5rem;${label}}` +
    `html[data-uw-hidden-page]::before{content:'Hidden page: not published';position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);${label}}`
  const script =
    `(function(){var h=${data};function mark(){` +
    `var p=globalThis.uniweb&&globalThis.uniweb.activeWebsite&&globalThis.uniweb.activeWebsite.activePage;if(!p)return;` +
    `var ids=(h.sections[p.route]||[]).concat(h.sections['*']||[]);` +
    `document.querySelectorAll('[data-uw-hidden]').forEach(function(e){if(ids.indexOf(e.id)<0)e.removeAttribute('data-uw-hidden')});` +
    `ids.forEach(function(id){var e=document.getElementById(id);if(e&&!e.hasAttribute('data-uw-hidden'))e.setAttribute('data-uw-hidden','')});` +
    `document.documentElement.toggleAttribute('data-uw-hidden-page',h.pages.indexOf(p.route)>=0)}` +
    `new MutationObserver(mark).observe(document.documentElement,{childList:true,subtree:true});` +
    `addEventListener('DOMContentLoaded',mark)})()`
  return `    <style id="uw-dev-hidden">${style}</style>\n    <script id="uw-dev-hidden-marks">${script}</script>\n`
}
