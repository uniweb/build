/**
 * What `injectBuildData` still owns for the theme — and what it no longer does.
 *
 * Until 2026-07-28 this function injected BOTH the theme `<style>` and the font
 * `<link>` block. Both are derived from the website graph, so both moved to the
 * shared seam (`@uniweb/runtime/ssr`'s `injectPageContent`) where every
 * prerender lane gets them rather than only lanes running this package. Sites
 * served by any other lane had been rendering with no semantic tokens at all,
 * and would have kept falling back to system fonts.
 *
 * The injections are covered by `head-seam-parity.test.js`. What is left here
 * is the half that genuinely belongs to a build: **stripping** both from the
 * embedded JSON, because by then they are already in `<head>` and shipping ~6KB
 * of generated CSS twice is pure payload.
 *
 * That strip is also why "no css on the graph" cannot be used to mean "no css on
 * the page" — see the DOM guard in the runtime's `setup.js`.
 */

import { injectBuildData } from '../src/prerender.js'

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

const THEME = {
  css: ':root { --font-body: Inter; }',
  links: '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
}

function payloadOf(html) {
  const m = html.match(/<script id="__SITE_CONTENT__" type="application\/json">([\s\S]*?)<\/script>/)
  return m ? JSON.parse(m[1].replace(/\\u003c/g, '<')) : null
}

describe('injectBuildData — theme head content', () => {
  const siteContent = { theme: THEME, pages: [], config: {} }

  it('does NOT inject the theme <style> — that moved to the shared seam', () => {
    // A second copy here would be worse than the original bug: the two would
    // drift and only one lane would ever show it.
    const out = injectBuildData(SHELL, siteContent)

    expect(out).not.toContain('id="uniweb-theme"')
  })

  it('does NOT inject the font <link>s — same move, same reasoning', () => {
    const out = injectBuildData(SHELL, siteContent)

    expect(out).not.toContain('<!--uniweb-fonts-->')
    expect(out).not.toContain('family=Inter')
  })

  it('still strips css and links from the embedded JSON — both are already in <head>', () => {
    const out = injectBuildData(SHELL, siteContent)
    const payload = payloadOf(out)

    expect(payload.theme.css).toBeUndefined()
    expect(payload.theme.links).toBeUndefined()
  })

  it('leaves the source object untouched for the next page in the loop', () => {
    injectBuildData(SHELL, siteContent)

    expect(siteContent.theme.css).toBe(THEME.css)
    expect(siteContent.theme.links).toBe(THEME.links)
  })
})
