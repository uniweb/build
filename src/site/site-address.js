/**
 * WHERE A STATICALLY BUILT SITE LIVES — the address a build states for it, `config.url`, which the
 * runtime reads (`@uniweb/core/site-address`) to state every absolute URL: a page's canonical,
 * `og:url` and hreflang, the sitemap, `robots.txt`, the agent index.
 *
 * A static host cannot tell a site where it is served, so the build states it: the origin its deploy
 * target gives — `ORIGIN_ENV` (the GitHub Pages workflow passes the one GitHub states), or the
 * production origin a host building the site says it serves it at (Netlify, Vercel:
 * `detectCiContext`) — else the author's (`site.yml::seo.origin`), joined to the base the site is
 * built for. A host that serves the site itself states its own, and none of this is consulted.
 *
 * ⭐ AN ORIGIN IS A SCHEME AND A HOST; THE PATH IS THE BASE'S. An origin written with a path is
 * refused: the path would be stated twice, and could disagree with the base the files are built for.
 * ⛔ Until 2026-10-25 the author wrote `seo.baseUrl`, which the docs called an origin while the
 * sitemap and the page tags read it as the whole address, so under a base path no value was right.
 */

import { siteAddress } from '@uniweb/core/site-address'
import { detectCiContext } from '../hosts/detect-ci-context.js'

/** The origin a deploy target states for the site it serves, e.g. `https://user.github.io`. */
export const ORIGIN_ENV = 'UNIWEB_ORIGIN'

/** Keys of `seo` that are retired, and what replaced each. */
const RETIRED_SEO_KEYS = {
  baseUrl:
    "`seo.baseUrl` is now `seo.origin`: the origin the site is served from, `https://example.com`. A path is the site's base — `base:` in site.yml, or UNIWEB_BASE from its deploy.",
  defaultImage: '`seo.defaultImage` is `seo.image`: the social card every page inherits.',
  locales: "`seo.locales` is retired: a page's hreflang follows the site's `languages:`.",
}

/** Keys of a site's config that whoever serves the site states, never its author. */
const STATED_KEYS = {
  url: "`url:` in site.yml is not read: a site's address is its origin (`seo.origin`) and its base, or what its deploy target states.",
  trailingSlash: "`trailingSlash:` in site.yml is not read: how a page's URL ends follows how the build lays out its files.",
}

/**
 * Stop on what `site.yml` says about where the site lives that nothing reads — a retired `seo` key,
 * an address or URL form only whoever serves the site states, an origin that is not one. Run
 * wherever `site.yml` is read for a build or a push, as `refuseRetiredServiceKeys` is.
 *
 * @param {Object} siteYml
 * @param {string} [where]
 * @throws {Error}
 */
export function refuseUnreadableAddress(siteYml, where = 'site.yml') {
  if (!siteYml || typeof siteYml !== 'object') return
  for (const [key, message] of Object.entries(STATED_KEYS)) {
    if (siteYml[key] !== undefined) throw new Error(`[uniweb] ${where}: ${message}`)
  }
  const seo = siteYml.seo
  if (!seo || typeof seo !== 'object') return
  for (const [key, message] of Object.entries(RETIRED_SEO_KEYS)) {
    if (seo[key] !== undefined) throw new Error(`[uniweb] ${where}: ${message}`)
  }
  readOrigin(seo.origin, `\`seo.origin\` in ${where}`)
}

/**
 * A site's effective `seo` block: `site.yml::seo`, with a caller's overrides over it key by key
 * (`defineSiteConfig({ seo })`). Refused when it holds a retired key, wherever that came from.
 *
 * @param {Object} [seo] - `site.yml::seo`
 * @param {Object} [overrides]
 * @returns {Object}
 */
export function effectiveSeo(seo, overrides = {}) {
  const merged = { ...(seo || {}), ...(overrides || {}) }
  for (const [key, message] of Object.entries(RETIRED_SEO_KEYS)) {
    if (merged[key] !== undefined) throw new Error(message)
  }
  return merged
}

/**
 * An origin as written, normalized — `https://example.com` — or null when none is written. Throws,
 * naming `where`, for a value that is not one.
 *
 * @param {*} value
 * @param {string} where - what to call it in the message (`seo.origin`, `UNIWEB_ORIGIN`)
 * @returns {string|null}
 */
export function readOrigin(value, where) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  let url = null
  try {
    url = new URL(text)
  } catch {
    // reported below
  }
  // A string that parses is not yet an origin: `example.com:443` parses, with `example.com:` as its scheme.
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) {
    throw new Error(`${where} is "${text}", which is not an origin. Write it with its scheme: https://example.com`)
  }
  if (url.pathname !== '/') {
    throw new Error(
      `${where} is "${text}", but an origin is a scheme and a host: ${url.origin}. ` +
        `The path ${url.pathname.replace(/\/?$/, '/')} is the site's base — \`base:\` in site.yml, or UNIWEB_BASE from its deploy.`
    )
  }
  if (url.search || url.hash) {
    throw new Error(`${where} is "${text}", but an origin is a scheme and a host: ${url.origin}.`)
  }
  return url.origin
}

/**
 * The address a static build states for its site — the origin from its deploy target or its
 * author, under the base it is built for — or null when neither states an origin.
 *
 * @param {Object} options
 * @param {Object} [options.config] - the site's collected config, its `seo` effective (`effectiveSeo`)
 * @param {string} [options.base] - the base the site is built for, `/handbook/`
 * @param {Object} [options.env]
 * @returns {string|null}
 */
export function resolveSiteAddress({ config = {}, base = '/', env = process.env } = {}) {
  const ci = detectCiContext(env)
  const origin =
    readOrigin(env[ORIGIN_ENV], ORIGIN_ENV) ??
    readOrigin(ci?.origin, `the production URL ${ci?.host} states`) ??
    readOrigin(config.seo?.origin, '`seo.origin`')
  if (!origin) return null
  return siteAddress(`${origin}${base || '/'}`)
}
