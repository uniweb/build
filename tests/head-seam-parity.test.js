/**
 * Head-injection seam parity — the mechanical check.
 *
 * Prerendering happens in more than one lane. All of them call
 * `injectPageContent()` from @uniweb/runtime/ssr; only lanes running this
 * package additionally call `injectBuildData()`. The rule is:
 *
 *   derived from the page/website graph  → injectPageContent()  [every lane]
 *   derived from a build-only artifact   → injectBuildData()    [this lane]
 *
 * Getting it wrong is silent and asymmetric — the lane you tested works and
 * the other is wrong in production. **It has happened twice.** The pre-paint
 * appearance script shipped in injectBuildData, so cloud-rendered pages
 * flashed light for every dark-mode visitor. Then theme CSS was found in the
 * same function, four lines above the comment the first fix left behind
 * warning about exactly this — so every cloud-rendered page was unstyled.
 *
 * Two prose warnings in one file did not prevent the second case. This test is
 * the mechanical answer: it renders one page through both lanes and asserts
 * the static lane's head adds nothing to the shared lane's head except things
 * on an explicit, documented allowlist of genuine build artifacts.
 *
 * **If this test fails, the default assumption is that a new head injection
 * went into the wrong function.** Move it into injectPageContent(). Only widen
 * BUILD_ONLY if the thing genuinely cannot exist without a build — and say why
 * in the entry, because the next reader's alternative is to widen it again.
 */

import { injectBuildData } from '../src/prerender.js'
import { injectPageContent } from '@uniweb/runtime/ssr'

const SHELL =
  '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

const THEME = {
  css: ':root { --heading: #111; --section: #fff; }',
  links: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
  appearance: { default: 'light', allowToggle: true },
}

/**
 * Things only a build can produce. Each entry names WHY it cannot come from
 * the graph — that justification is the point of the list.
 */
const BUILD_ONLY = new Set([
  // The serialized site payload. It is the build's own output; a lane that
  // did not run the build has nothing to serialize.
  '__SITE_CONTENT__',
  // Icons resolved and cached at build time by prefetchIcons().
  '__ICON_CACHE__',
  // Font <link>s. Graph-derived in principle and the remaining half of the
  // 2026-07-28 seam fix — blocked only because FONT_LINKS_MARKER has a second
  // consumer in the vite plugin, which cannot import the SSR bundle. See the
  // note in src/prerender.js. Remove this entry when that constant gets a
  // shared home.
  '<!--uniweb-fonts-->',
])

/** Identifiers of the elements a head carries: element ids + bare markers. */
function headFeatures(html) {
  const head = html.slice(0, html.indexOf('</head>'))
  const features = new Set()
  for (const m of head.matchAll(/\sid="([^"]+)"/g)) features.add(m[1])
  for (const m of head.matchAll(/<!--[a-z-]+-->/g)) features.add(m[0])
  return features
}

function makePage() {
  const website = { themeData: { ...THEME } }
  return {
    title: 'Home',
    description: 'A page',
    route: '/',
    website,
    getTitle: () => 'Home',
  }
}

describe('head-injection seam parity', () => {
  const siteContent = { theme: THEME, pages: [], config: {} }

  it('the static lane adds only build artifacts on top of the shared lane', () => {
    const page = makePage()

    // Every lane: the shared seam alone.
    const shared = injectPageContent(SHELL, '<p>hi</p>', page, {})
    // This lane: the seam, then build-specific additions on top.
    const statics = injectBuildData(shared, siteContent)

    const sharedFeatures = headFeatures(shared)
    const extra = [...headFeatures(statics)].filter((f) => !sharedFeatures.has(f))
    const unjustified = extra.filter((f) => !BUILD_ONLY.has(f))

    expect(unjustified).toEqual([])
  })

  it('theme CSS reaches a lane that only calls the shared seam', () => {
    // The 2026-07-28 regression, stated directly: this is what a cloud-
    // rendered page gets, and it must include the site's theme.
    const out = injectPageContent(SHELL, '<p>hi</p>', makePage(), {})

    expect(out).toContain('id="uniweb-theme"')
    expect(out).toContain('--heading: #111')
  })

  it('the appearance script reaches it too — the first instance, still fixed', () => {
    const out = injectPageContent(SHELL, '<p>hi</p>', makePage(), {})

    expect(out).toContain('id="uniweb-appearance"')
  })

  it('running both lanes yields exactly one copy of each shared injection', () => {
    const page = makePage()
    const out = injectBuildData(injectPageContent(SHELL, '<p>hi</p>', page, {}), siteContent)

    expect(out.match(/id="uniweb-theme"/g)).toHaveLength(1)
    expect(out.match(/id="uniweb-appearance"/g)).toHaveLength(1)
  })
})
