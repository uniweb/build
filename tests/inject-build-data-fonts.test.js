/**
 * Font <link> tags in the prerendered head.
 *
 * The vite plugin injects the theme's font links into `dist/index.html`, and
 * the prerenderer post-processes that HTML per page. Both stages can write the
 * block, so the marker decides who does: exactly one copy per page, whichever
 * path produced the shell.
 *
 * The links themselves are load-bearing, not a hint — the theme CSS carries no
 * `@import`, so a page that loses them preconnects to the font host and then
 * never requests the stylesheet.
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

describe('injectBuildData — theme font links', () => {
  const siteContent = { theme: THEME, pages: [], config: {} }

  it('injects the font links when the shell has none', () => {
    const out = injectBuildData(SHELL, siteContent)

    expect(out).toContain('<!--uniweb-fonts-->')
    expect(out).toContain('rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"')
    expect(out.indexOf('<!--uniweb-fonts-->')).toBeLessThan(out.indexOf('</head>'))
  })

  it('does not duplicate links the plugin already injected', () => {
    // What the real pipeline hands it: index.html already carries the block.
    const shell = SHELL.replace('</head>', `<!--uniweb-fonts-->\n${THEME.links}\n</head>`)

    const out = injectBuildData(shell, siteContent)

    expect(out.match(/<!--uniweb-fonts-->/g)).toHaveLength(1)
    expect(out.match(/rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/g)).toHaveLength(1)
  })

  it('keeps css and links out of the embedded JSON — both are already in <head>', () => {
    const out = injectBuildData(SHELL, siteContent)
    const payload = payloadOf(out)

    expect(payload.theme.css).toBeUndefined()
    expect(payload.theme.links).toBeUndefined()
    // and the source object is untouched for the next page's injection
    expect(siteContent.theme.css).toBe(THEME.css)
    expect(siteContent.theme.links).toBe(THEME.links)
  })

  it('is a no-op when the theme declares no links', () => {
    const out = injectBuildData(SHELL, { theme: { css: THEME.css }, pages: [], config: {} })

    expect(out).not.toContain('<!--uniweb-fonts-->')
    expect(out).toContain('id="uniweb-theme"')
  })
})
