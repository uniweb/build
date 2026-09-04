/**
 * SSG Prerendering for Uniweb Sites
 *
 * Renders each page to static HTML at build time.
 * Uses @uniweb/runtime/ssr for the rendering pipeline (init, render, inject).
 * This file handles build-specific orchestration: data fetching, locale discovery,
 * dynamic route expansion, extension loading, and build-specific HTML injections.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDefaultLocale, isDataUrl } from '@uniweb/core'
import { executeFetch, mergeDataIntoContent, toFetchList, stripBuildOnlyFetchKeys } from './site/data-fetcher.js'
import { shouldSplitContent } from './site/split-content.js'
import { FONT_LINKS_MARKER } from './site/head-markers.js'
import { getAdapter } from './hosts/index.js'
import { detectCiContext } from './hosts/detect-ci-context.js'
import { stripBasePath } from './site/extension-urls.js'

/**
 * Resolve an extension URL to a filesystem path for prerender.
 * Browser URLs like "/effects/entry.js" need mapping to local files.
 *
 * Resolution order:
 * 1. dist directory (post-build copy target, e.g., site/dist/effects/entry.js)
 * 2. Project root with dist subdir (dev layout, e.g., project/effects/dist/entry.js)
 * 3. Original URL (absolute or remote — let import() handle it)
 */
export function resolveExtensionPath(url, distDir, projectRoot, base) {
  // The payload now carries FINAL, base-resolved URLs (see
  // site/extension-urls.js), but `dist/` has no base segment — a site deployed
  // at `/docs/` still writes `dist/effects/entry.js`. Strip the base before
  // mapping onto the build tree. A URL without the base is returned unchanged,
  // so a payload produced before this change still resolves.
  url = stripBasePath(url, base)

  // Only resolve URLs that look like root-relative paths
  if (url.startsWith('/')) {
    // Try dist directory first (production: files copied to site/dist/)
    const distPath = join(distDir, url)
    if (existsSync(distPath)) return distPath

    // Workspace layouts: "/effects/entry.js" → "<pkg>/dist/entry.js", checked
    // both at the project root and under an `extensions/` parent — the standard
    // multi-foundation layout puts extensions in `extensions/<name>/`, so the
    // bare-root candidate alone misses the built module and prerender can't load
    // the extension.
    const parts = url.slice(1).split('/')
    if (parts.length >= 2) {
      const pkgName = parts[0]
      const rest = parts.slice(1).join('/')
      const candidates = [
        join(projectRoot, pkgName, 'dist', rest),
        join(projectRoot, 'extensions', pkgName, 'dist', rest),
      ]
      for (const devPath of candidates) {
        if (existsSync(devPath)) return devPath
      }
    }
  }

  // Return as-is for absolute paths or remote URLs
  return url
}

/**
 * Execute all data fetches for prerender
 * Processes site, page, and section level fetches, merging data appropriately
 *
 * @param {Object} siteContent - The site content from site-content.json
 * @param {string} siteDir - Path to the site directory
 * @param {function} onProgress - Progress callback
 * @param {Object} [localeInfo] - Locale info for collection data localization
 * @param {string} [localeInfo.locale] - Active locale code
 * @param {string} [localeInfo.defaultLocale] - Default locale code
 * @param {string} [localeInfo.distDir] - Path to dist directory (where locale-specific data lives)
 * @returns {Object} { pageFetchedData, fetchedData } - Fetched data for dynamic route expansion and DataStore pre-population
 */
async function executeAllFetches(siteContent, siteDir, onProgress, localeInfo) {
  const fetchOptions = { siteRoot: siteDir, publicDir: 'public' }
  const fetchedData = [] // Collected for DataStore pre-population

  // For non-default locales, translated collection data lives in dist/{locale}/data/
  // instead of public/data/. Create a localized fetch helper.
  const isNonDefaultLocale = localeInfo &&
    localeInfo.locale !== localeInfo.defaultLocale &&
    localeInfo.distDir

  function localizeFetch(config) {
    if (!isNonDefaultLocale || !isDataUrl(config.path)) return config
    return { ...config, path: `/${localeInfo.locale}${config.path}` }
  }

  // Fetch options pointing to dist/ for localized data
  const localizedFetchOptions = isNonDefaultLocale
    ? { siteRoot: localeInfo.distDir, publicDir: '.' }
    : fetchOptions

  // 1. Site-level fetch. ⛔ `toFetchList` rather than a property read: a `fetch:`
  // or `data:` LIST parses to an array, and `siteFetch.prerender` on one is
  // `undefined` — which passes the `!== false` test and then fetches nothing.
  for (const oneFetch of toFetchList(siteContent.config?.fetch)) {
    if (oneFetch.prerender === false) continue
    const cfg = localizeFetch(oneFetch)
    const opts = cfg !== oneFetch ? localizedFetchOptions : fetchOptions
    onProgress(`  Fetching site data: ${cfg.path || cfg.url}`)
    const result = await executeFetch(cfg, opts)
    if (result.data && !result.error) {
      fetchedData.push({ config: cfg, data: result.data, _scope: '__site__' })
    }
  }

  // 2. Process each page and track fetched data by route
  const pageFetchedData = new Map()

  for (const page of siteContent.pages || []) {
    // Page-level fetch — every declaration on the page.
    for (const oneFetch of toFetchList(page.fetch)) {
      if (oneFetch.prerender === false) continue
      const cfg = localizeFetch(oneFetch)
      const opts = cfg !== oneFetch ? localizedFetchOptions : fetchOptions
      onProgress(`  Fetching page data for ${page.route}: ${cfg.path || cfg.url}`)
      const result = await executeFetch(cfg, opts)
      if (result.data && !result.error) {
        fetchedData.push({ config: cfg, data: result.data, _scope: page.route })
        // ⚖️ Dynamic-route expansion consumes ONE query — a `[slug]` template
        // expands over a single record set. With several declared, the first
        // that prerenders is the route query, matching `parentSchema` in the
        // collector; `expandDynamicPages` is what reads this back.
        if (!pageFetchedData.has(page.route)) {
          pageFetchedData.set(page.route, {
            schema: oneFetch.as,
            data: result.data,
          })
        }
      }
    }

    // Process section-level fetches (own fetch → parsedContent.data, not cascaded)
    await processSectionFetches(page.sections, fetchOptions, onProgress)
  }

  return { pageFetchedData, fetchedData }
}

/**
 * Expand dynamic pages into concrete pages based on fetched data
 * A dynamic page like /blog/:slug with parent data [{ slug: 'post-1' }, { slug: 'post-2' }]
 * becomes /blog/post-1 and /blog/post-2
 *
 * @param {Array} pages - Original pages array
 * @param {Map} pageFetchedData - Map of route -> { schema, data }
 * @param {function} onProgress - Progress callback
 * @returns {Array} Expanded pages array with dynamic pages replaced by concrete instances
 */
/**
 * Where a content-less container's redirect stub should point, in THIS locale.
 *
 * A folder with no body of its own gets a `<meta http-equiv="refresh">` stub so
 * the redirect works without JS. `page.getNavigableRoute()` answers in CANONICAL
 * routes — right, because the hierarchy is canonical and "does this folder have
 * a page of its own?" is not a language question. But the stub is per-locale, so
 * the destination has to be localized exactly the way `outputRoute` is: translate
 * the slug, then re-apply the locale prefix.
 *
 * Emitting the canonical route raw sent a reader who asked for `/fr/<container>`
 * to the DEFAULT-locale page — a language switch they never asked for, from a
 * URL that was correct. The runtime's copy of this redirect (PageRenderer.jsx)
 * had the identical bug and was fixed first; this is its twin, and the two must
 * agree or a container behaves differently on a cold load than on an in-app
 * navigation.
 *
 * The DECISION to redirect stays canonical (`target !== page.route`) — only the
 * destination is localized. Comparing a localized destination against a
 * canonical route would make a folder with an index child redirect to itself.
 *
 * @param {string} target - Canonical route from getNavigableRoute()
 * @param {Object} ctx
 * @param {Object} ctx.website - Website instance (for translateRoute / basePath)
 * @param {string} ctx.locale - Locale being rendered
 * @param {boolean} ctx.isDefault - Is this the site's default locale?
 * @param {string} ctx.routePrefix - Locale prefix for this pass ('' or '/fr')
 * @returns {string} Absolute path for the stub's refresh + canonical link
 */
export function localizeRedirectTarget(target, { website, locale, isDefault, routePrefix = '' }) {
  const localized = isDefault ? target : routePrefix + website.translateRoute(target, locale)
  const withSlash = localized.startsWith('/') ? localized : '/' + localized
  return (website.basePath || '') + withSlash
}

export function expandDynamicPages(pages, pageFetchedData, onProgress = () => {}, stats = { unrouted: {} }) {
  if (!stats.unrouted) stats.unrouted = {}
  const expandedPages = []

  // Static pages win over the dynamic `[slug]` catch-all, matching the SPA's
  // route resolution (Website.getPage checks exact static routes before the
  // `:param` loop). Without this guard, a record whose param value collides
  // with a static sibling's segment (e.g. slug:'about' + a static /blog/about)
  // would emit a duplicate concrete route; the write loops are keyed on
  // page.route and last-writer-wins, silently clobbering the static page's
  // HTML. Collect the static routes up front so we can skip + warn on collision.
  const staticRoutes = new Set(
    pages.filter((p) => !p.isDynamic).map((p) => p.route)
  )

  for (const page of pages) {
    if (!page.isDynamic) {
      // Regular page - include as-is
      expandedPages.push(page)
      continue
    }

    // Dynamic page - expand based on parent's data
    const { paramName, parentSchema } = page

    if (!parentSchema) {
      onProgress(`  Warning: Dynamic page ${page.route} has no parentSchema, keeping as template for runtime`)
      expandedPages.push(page)
      continue
    }

    // Find the parent's data
    // The parent route is the route without the :param suffix
    const parentRoute = page.route.replace(/\/:[\w]+$/, '') || '/'
    const parentData = pageFetchedData.get(parentRoute)

    if (!parentData || !Array.isArray(parentData.data)) {
      // No build-time data available (e.g., prerender: false on parent fetch).
      // Keep the dynamic template so the runtime can match it client-side.
      onProgress(`  Keeping dynamic template ${page.route} for runtime (no build-time data)`)
      expandedPages.push(page)
      continue
    }

    const items = parentData.data
    const schema = parentData.schema

    onProgress(`  Expanding ${page.route} → ${items.length} pages from ${schema}`)

    // ⛔ COUNTED, not only logged per record. A record with no value for the
    // route's param gets no page — correct — but "Skipping item without slug"
    // once per record is a line nobody reads: an author who files twenty
    // records and names three gets three pages and no idea why. The total is
    // said once at the end, and handed back on `stats` for a caller to assert.
    let unrouted = 0

    // Create a concrete page for each item
    for (const item of items) {
      // Get the param value from the item (e.g., item.slug for :slug)
      const paramValue = item[paramName]
      if (!paramValue) {
        unrouted += 1
        continue
      }

      // Create concrete route: /blog/:slug → /blog/my-post
      const concreteRoute = page.route.replace(`:${paramName}`, paramValue)

      // Static sibling wins: skip a record whose concrete route collides with
      // an existing static page rather than overwriting its HTML at write time.
      if (staticRoutes.has(concreteRoute)) {
        onProgress(`    Skipping ${concreteRoute} — a static page already claims this route (${paramName}:'${paramValue}')`)
        continue
      }

      // Deep clone the page with modifications
      const concretePage = JSON.parse(JSON.stringify(page))
      concretePage.route = concreteRoute
      concretePage.isDynamic = false // No longer dynamic
      concretePage.paramName = undefined
      concretePage.parentSchema = undefined

      // Store the dynamic route context for runtime data resolution. Only the
      // keys the runtime actually uses — the entity cascade re-finds the record
      // from the fetched collection by paramName/paramValue/schema. The record
      // (`currentItem`) and the full sibling list (`allItems`) are deliberately
      // NOT baked in: nothing reads them (the documented dynamicContext shape is
      // { paramName, paramValue, schema }; the record is delivered via
      // content.data and siblings via `fetch: { refine: true, detail: false }`),
      // and embedding `allItems` duplicated the whole collection onto every
      // prerendered page in split mode.
      concretePage.dynamicContext = {
        paramName,
        paramValue,
        schema,           // Plural: 'articles'
      }

      // Use item data for page metadata if available
      if (item.title) concretePage.title = item.title
      if (item.description || item.excerpt) concretePage.description = item.description || item.excerpt

      expandedPages.push(concretePage)
    }

    if (unrouted > 0) {
      stats.unrouted[page.route] = unrouted
      onProgress(
        `  ⚠️ ${unrouted} of ${items.length} ${schema} records have no "${paramName}" — no page was ` +
          `generated for them under ${page.route}`
      )
    }
  }

  return expandedPages
}

/**
 * Process fetch configs for sections (and subsections recursively)
 * Section-level fetches merge data into parsedContent.data (not cascaded).
 *
 * @param {Array} sections - Array of section objects
 * @param {Object} fetchOptions - Options for executeFetch
 * @param {function} onProgress - Progress callback
 */
async function processSectionFetches(sections, fetchOptions, onProgress) {
  if (!sections || !Array.isArray(sections)) return

  for (const section of sections) {
    // Execute every section-level fetch. Each merges under its own key, so
    // several accumulate into one `parsedContent.data` — the same keyed map the
    // runtime's EntityStore builds.
    for (const sectionFetch of toFetchList(section.fetch)) {
      if (sectionFetch.prerender === false) continue
      onProgress(`  Fetching section data: ${sectionFetch.path || sectionFetch.url}`)
      const result = await executeFetch(sectionFetch, fetchOptions)
      if (result.data && !result.error) {
        section.parsedContent = mergeDataIntoContent(
          section.parsedContent || {},
          result.data,
          sectionFetch.as,
          sectionFetch.merge
        )
      }
    }

    // Process subsections recursively
    if (section.subsections && section.subsections.length > 0) {
      await processSectionFetches(section.subsections, fetchOptions, onProgress)
    }
  }
}

/**
 * Discover all locale content files in the dist directory
 * Returns an array of { locale, contentPath, htmlPath, isDefault }
 *
 * @param {string} distDir - Path to dist directory
 * @param {Object} defaultContent - Default site content (to get default locale)
 * @returns {Array} Locale configurations
 */
async function discoverLocaleContents(distDir, defaultContent) {
  const locales = []
  const defaultLocale = resolveDefaultLocale(defaultContent.config)

  // Add the default locale (root level)
  locales.push({
    locale: defaultLocale,
    contentPath: join(distDir, 'site-content.json'),
    htmlPath: join(distDir, 'index.html'),
    isDefault: true,
    routePrefix: ''
  })

  // Check for locale subdirectories with site-content.json
  try {
    const entries = readdirSync(distDir)
    for (const entry of entries) {
      const entryPath = join(distDir, entry)
      // Skip if not a directory
      if (!statSync(entryPath).isDirectory()) continue

      // Check if this looks like a locale code (2-3 letter code)
      if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(entry)) continue

      // Check if it has a site-content.json
      const localeContentPath = join(entryPath, 'site-content.json')
      const localeHtmlPath = join(entryPath, 'index.html')

      if (existsSync(localeContentPath)) {
        locales.push({
          locale: entry,
          contentPath: localeContentPath,
          htmlPath: localeHtmlPath,
          isDefault: false,
          routePrefix: `/${entry}`
        })
      }
    }
  } catch (err) {
    // Ignore errors reading directory
    if (process.env.UNIWEB_DEBUG) {
      console.error('Error discovering locale contents:', err.message)
    }
  }

  return locales
}

/**
 * Strip the internal `_scope` tag off a fetchedData entry, leaving the clean
 * `{ config, data }` shape the runtime's hydrateDataStore expects.
 */
function stripFetchScope(entry) {
  const { _scope, ...clean } = entry
  return clean
}

/**
 * Scope `fetchedData` for a single page's inline __SITE_CONTENT__.
 *
 * Every fetchedData entry is tagged (in executeAllFetches) with `_scope`:
 * '__site__' for a site-level fetch, or the owning page's route for a
 * page-level fetch. A page's first render only ever reads the cascade
 * block → page → page.parent → site (see @uniweb/core EntityStore), so in
 * split-content mode we embed just the entries that cascade can reach —
 * site-level plus the page's own route and its parent's route (`scopeRoutes`).
 * Other pages' data, and dynamic detail data reached only by client-side
 * navigation, is fetched on demand and must not ride in every page's payload.
 *
 * `scopeRoutes == null` means "don't scope" (non-split mode, or the SPA
 * fallback): keep every entry. Either way the internal `_scope` tag is stripped.
 *
 * @param {Array<{config: Object, data: any, _scope?: string}>} fetchedData
 * @param {Set<string>|null} scopeRoutes - Routes whose entries to keep, or null.
 * @returns {Array<{config: Object, data: any}>}
 */
export function scopeFetchedData(fetchedData, scopeRoutes) {
  if (!Array.isArray(fetchedData)) return fetchedData
  if (!scopeRoutes) return fetchedData.map(stripFetchScope)
  return fetchedData
    .filter((e) => e._scope === '__site__' || scopeRoutes.has(e._scope))
    .map(stripFetchScope)
}

/**
 * Inject build-specific data into HTML (theme CSS, __SITE_CONTENT__, icon cache).
 * Called after the shared injectPageContent for build-specific additions.
 *
 * @param {string} html - HTML with prerendered content already injected
 * @param {Object} siteContent - Site content JSON
 * @param {Object} [options]
 * @param {boolean} [options.splitContent=false] - Whether split content mode is active
 * @param {string|null} [options.currentRoute=null] - Route of the page this HTML is for
 * @returns {string} HTML with build-specific data injected
 */
export function injectBuildData(html, siteContent, { splitContent = false, currentRoute = null, scopeRoutes = null } = {}) {
  let result = html

  // Neither the theme <style> NOR the font <link>s are injected here anymore.
  // Both are derived from the website graph (`website.themeData`), so they
  // belong to the shared seam — @uniweb/runtime/ssr's injectPageContent(),
  // which runs just before this — and every lane gets them from one
  // implementation. The theme CSS sat here until 2026-07-28 and cloud-rendered
  // pages were unstyled the whole time; the font links followed once
  // FONT_LINKS_MARKER moved to @uniweb/theming, the one package both this and
  // the runtime can read it from.
  //
  // See the "which side of the seam?" note there before adding a new head
  // injection, and note that this file has now got it wrong twice. The guard
  // against a third is mechanical: tests/head-seam-parity.test.js fails if this
  // function's <head> output gains anything outside its BUILD_ONLY allowlist.

  // The pre-paint appearance script is NOT injected here. It belongs to the
  // shared seam — @uniweb/runtime/ssr's injectPageContent(), which runs just
  // before this — so the cloud worker's just-in-time render gets it too. See the
  // "which side of the seam?" note there before adding a new head injection.

  // Inject site content as JSON for hydration
  // Strip CSS and font links from theme (both are already in <head>)
  let contentForJson = { ...siteContent }
  if (contentForJson.theme?.css || contentForJson.theme?.links) {
    contentForJson.theme = { ...contentForJson.theme }
    delete contentForJson.theme.css
    delete contentForJson.theme.links
  }

  // Split mode: strip sections from all pages except the current one.
  // Dynamic templates (isDynamic) keep their sections — needed by _createDynamicPage().
  if (splitContent) {
    contentForJson = {
      ...contentForJson,
      pages: contentForJson.pages.map(page => {
        if (page.route === currentRoute) return page
        if (page.isDynamic) return page
        const { sections, ...metadata } = page
        return metadata
      })
    }
  }

  // Scope fetched (collection / API) data to this page's cascade in split mode,
  // so a page never carries other pages' collections. Non-split keeps it all
  // (single-file inline). Either way the internal `_scope` tag is stripped.
  if (Array.isArray(contentForJson.fetchedData)) {
    contentForJson = {
      ...contentForJson,
      fetchedData: scopeFetchedData(contentForJson.fetchedData, splitContent ? scopeRoutes : null),
    }
  }

  const contentScript = `<script id="__SITE_CONTENT__" type="application/json">${JSON.stringify(contentForJson).replace(/</g, '\\u003c')}</script>`
  if (result.includes('__SITE_CONTENT__')) {
    // Replace existing site content with updated version (includes expanded dynamic routes)
    result = result.replace(
      /<script[^>]*id="__SITE_CONTENT__"[^>]*>[\s\S]*?<\/script>/,
      contentScript
    )
  } else {
    result = result.replace(
      '</head>',
      `  ${contentScript}\n  </head>`
    )
  }

  // Inject icon cache so client can render icons immediately without CDN fetches
  if (siteContent._iconCache) {
    const iconScript = `<script id="__ICON_CACHE__" type="application/json">${JSON.stringify(siteContent._iconCache).replace(/</g, '\\u003c')}</script>`
    if (result.includes('__ICON_CACHE__')) {
      result = result.replace(
        /<script[^>]*id="__ICON_CACHE__"[^>]*>[\s\S]*?<\/script>/,
        iconScript
      )
    } else {
      result = result.replace(
        '</head>',
        `  ${iconScript}\n  </head>`
      )
    }
  }

  return result
}

/**
 * Get output path for a route
 */
function getOutputPath(distDir, route) {
  let normalizedRoute = route

  // Handle root route
  if (normalizedRoute === '/' || normalizedRoute === '') {
    return join(distDir, 'index.html')
  }

  // Remove leading slash
  if (normalizedRoute.startsWith('/')) {
    normalizedRoute = normalizedRoute.slice(1)
  }

  // Create directory structure: /about -> /about/index.html
  return join(distDir, normalizedRoute, 'index.html')
}

/**
 * Pre-render all pages in a built site to static HTML
 *
 * @param {string} siteDir - Path to the site directory
 * @param {Object} options
 * @param {string} options.foundationDir - Path to foundation directory (default: ../foundation)
 * @param {function} options.onProgress - Progress callback
 * @param {string} [options.host] - Name of the host adapter whose postBuild
 *   hook runs after pages are written. Default: 'cloudflare-pages'.
 * @returns {Promise<{pages: number, files: string[]}>}
 */
export async function prerenderSite(siteDir, options = {}) {
  const {
    foundationDir = join(siteDir, '..', 'foundation'),
    onProgress = () => {},
    host: hostOverride = null,
  } = options

  const distDir = join(siteDir, 'dist')

  // Verify build exists
  if (!existsSync(distDir)) {
    throw new Error(`Site must be built first. No dist directory found at: ${distDir}`)
  }

  // Load shared SSR functions from runtime (lazy — only when prerendering)
  const {
    initPrerender,
    hydrateDataStore,
    prefetchIcons,
    createPageRenderer,
    generate404Html,
  } = await import('@uniweb/runtime/ssr')

  // Load default site content
  onProgress('Loading site content...')
  const contentPath = join(distDir, 'site-content.json')
  if (!existsSync(contentPath)) {
    throw new Error(`site-content.json not found at: ${contentPath}`)
  }
  const defaultSiteContent = JSON.parse(await readFile(contentPath, 'utf8'))

  // Link-mode detection: if site.yml's foundation is a registry scoped ref
  // or a URL, the foundation lives on the hosting edge, not on disk. Static
  // prerender (which writes dist/<route>/index.html) has no local JS to
  // execute, so we skip cleanly here. This is the right call for CLI deploy
  // (where the Worker SSRs from R2 at serve time) and for any site whose
  // foundation is deliberately remote. Sites that still need prerender +
  // registry foundation would need a fetch-and-execute path, tracked as
  // future work.
  const fndRef = defaultSiteContent?.config?.foundation
  const isLinkModeFoundation = (
    (typeof fndRef === 'string' && (
      /^@[a-z0-9_-]+\/[a-z0-9_-]+@.+$/.test(fndRef) ||
      fndRef.startsWith('http://') ||
      fndRef.startsWith('https://')
    )) ||
    (fndRef && typeof fndRef === 'object' && fndRef.url)
  )
  if (isLinkModeFoundation) {
    onProgress(`Link-mode foundation (${typeof fndRef === 'string' ? fndRef : fndRef.url || fndRef.name}) — skipping prerender.`)
    onProgress('(HTML will be rendered by the serving worker / runtime.)')
    return { pages: 0, files: [] }
  }

  // Discover all locale content files
  const localeConfigs = await discoverLocaleContents(distDir, defaultSiteContent)
  if (localeConfigs.length > 1) {
    onProgress(`Found ${localeConfigs.length} locales: ${localeConfigs.map(l => l.locale).join(', ')}`)
  }

  // Load the foundation module (shared across all locales)
  onProgress('Loading foundation...')
  const foundationPath = join(foundationDir, 'dist', 'entry.js')
  if (!existsSync(foundationPath)) {
    throw new Error(`Foundation not found at: ${foundationPath}. Build foundation first.`)
  }
  const foundationUrl = pathToFileURL(foundationPath).href
  const foundation = await import(foundationUrl)

  // Pre-render each locale
  const renderedFiles = []

  for (const localeConfig of localeConfigs) {
    const { locale, contentPath: localeContentPath, htmlPath, isDefault, routePrefix } = localeConfig

    onProgress(`\nRendering ${isDefault ? 'default' : locale} locale...`)

    // Load locale-specific content
    let siteContent = JSON.parse(await readFile(localeContentPath, 'utf8'))

    // Set the active locale in the content
    siteContent.config = siteContent.config || {}
    siteContent.config.activeLocale = locale

    // Execute data fetches (site, page, section levels)
    // For non-default locales, collection data is read from dist/{locale}/data/
    onProgress('Executing data fetches...')
    const defaultLocale = resolveDefaultLocale(defaultSiteContent.config)
    const { pageFetchedData, fetchedData } = await executeAllFetches(
      siteContent, siteDir, onProgress,
      { locale, defaultLocale, distDir }
    )

    // Store fetchedData on siteContent for runtime DataStore pre-population
    siteContent.fetchedData = fetchedData

    // The build has consumed every build-only fetch key by now (`merge`, read
    // by the section fetches above); what ships in `__SITE_CONTENT__` is the
    // runtime's payload and carries none of them.
    siteContent = stripBuildOnlyFetchKeys(siteContent)

    // Expand dynamic pages (e.g., /blog/:slug → /blog/post-1, /blog/post-2)
    if (siteContent.pages?.some(p => p.isDynamic)) {
      onProgress('Expanding dynamic routes...')
      siteContent.pages = expandDynamicPages(siteContent.pages, pageFetchedData, onProgress)
    }

    // Determine whether to split content (after dynamic expansion, after data fetches)
    const splitContent = shouldSplitContent(
      siteContent.config?.build?.splitContent,
      siteContent.pages
    )

    // Emit per-page content files (after dynamic expansion so expanded pages get their own files)
    if (splitContent) {
      onProgress('Writing per-page content files...')
      const pagesBaseDir = routePrefix
        ? join(distDir, routePrefix.replace(/^\//, ''), '_pages')
        : join(distDir, '_pages')

      for (const page of siteContent.pages) {
        if (!page.sections?.length) continue  // Skip content-less pages
        if (page.isDynamic) continue           // Templates stay inline
        const routePath = page.route === '/' ? '/index' : page.route
        const outputPath = join(pagesBaseDir, `${routePath.replace(/^\//, '')}.json`)
        await mkdir(dirname(outputPath), { recursive: true })
        await writeFile(outputPath, JSON.stringify({ sections: page.sections }))
        onProgress(`  → _pages${routePath}.json`)
      }
    }

    // Load the HTML shell for this locale
    const shellPath = existsSync(htmlPath) ? htmlPath : join(distDir, 'index.html')
    const htmlShell = await readFile(shellPath, 'utf8')

    // Build-specific: load extensions (secondary foundations via URL) BEFORE
    // initPrerender so the Website's FetcherDispatcher sees their routes.
    const extensionSources = siteContent.config?.extensions
    const loadedExtensions = []
    if (extensionSources?.length) {
      onProgress(`Loading ${extensionSources.length} extension(s)...`)
      const projectRoot = join(siteDir, '..')
      for (const ext of extensionSources) {
        try {
          const url = typeof ext === 'string' ? ext : ext.url
          const extPath = resolveExtensionPath(url, distDir, projectRoot, siteContent.config?.base)
          const extModule = await import(pathToFileURL(extPath).href)
          loadedExtensions.push(extModule)
          onProgress(`  Extension loaded: ${url}`)
        } catch (err) {
          onProgress(`  Warning: Extension failed to load: ${ext} (${err.message})`)
        }
      }
    }

    // Initialize the Uniweb runtime using the shared SSR module
    const uniweb = initPrerender(siteContent, foundation, loadedExtensions, { onProgress })

    // One renderer for this run: the Website is already built and the shell is
    // fixed, so it is created once and asked per page.
    const renderer = createPageRenderer({ website: uniweb.activeWebsite, shell: htmlShell })

    // Build-specific: pre-populate DataStore so EntityStore can resolve data during prerender.
    // hydrateDataStore handles cache-key derivation + value-shape wrapping
    // — same helper used by the browser SPA boot and by the Cloudflare
    // Worker SSR isolate, so all three render paths agree on shape.
    hydrateDataStore(uniweb.activeWebsite, fetchedData)

    // Pre-fetch icons for SSR embedding
    await prefetchIcons(siteContent, uniweb, onProgress)

    // Pre-render each page
    const website = uniweb.activeWebsite

    for (const page of website.pages) {
      // Skip dynamic template pages — they exist in the content for runtime
      // route matching but can't be pre-rendered (no concrete route)
      if (page.route.includes(':')) continue

      // Build the output route with locale prefix
      // For non-default locales, translate route slugs (e.g., /about → /acerca-de)
      const translatedPageRoute = isDefault ? page.route : website.translateRoute(page.route, locale)
      const outputRoute = routePrefix + translatedPageRoute

      // Redirect pages: emit a redirect HTML instead of rendering content
      if (page.redirect) {
        onProgress(`  Redirect ${outputRoute} → ${page.redirect}`)
        const redirectHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${page.redirect}"><link rel="canonical" href="${page.redirect}"><title>Redirecting...</title></head><body><p>Redirecting to <a href="${page.redirect}">${page.redirect}</a></p></body></html>`
        const outputPath = getOutputPath(distDir, outputRoute)
        await mkdir(dirname(outputPath), { recursive: true })
        await writeFile(outputPath, redirectHtml)
        renderedFiles.push(outputPath)
        continue
      }

      // Rewrite pages: served by an external site, skip rendering entirely
      if (page.rewrite) {
        onProgress(`  Rewrite ${outputRoute} → ${page.rewrite}`)
        continue
      }

      // Content-less containers: auto-redirect to first descendant with content.
      // Mirrors the runtime's auto-redirect in PageRenderer.jsx so the redirect
      // works without JS (via <meta http-equiv="refresh">).
      if (!page.hasContent()) {
        const target = page.getNavigableRoute()
        if (target && target !== page.route) {
          const targetPath = localizeRedirectTarget(target, {
            website,
            locale,
            isDefault,
            routePrefix
          })
          onProgress(`  Auto-redirect ${outputRoute} → ${targetPath}`)
          const redirectHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${targetPath}"><link rel="canonical" href="${targetPath}"><title>Redirecting...</title></head><body><p>Redirecting to <a href="${targetPath}">${targetPath}</a></p></body></html>`
          const outputPath = getOutputPath(distDir, outputRoute)
          await mkdir(dirname(outputPath), { recursive: true })
          await writeFile(outputPath, redirectHtml)
          renderedFiles.push(outputPath)
          continue
        }
      }

      onProgress(`Rendering ${outputRoute}...`)

      // ⭐ `renderer.render` IS the sequence this loop used to spell out —
      // renderPage → classify → injectPageContent. It was moved into
      // `@uniweb/runtime/ssr` because an SSR isolate assembles the same three steps
      // per request, and two hand-written copies of one sequence is how the two
      // lanes drift. This lane passes the Page it already holds; the isolate passes
      // a route. See `runtime/src/page-renderer.js` for what it leaves to the host.
      const result = renderer.render(page)

      if (result.outcome === 'failed') {
        const { type, message } = result.error
        if (type === 'hooks' || type === 'null-component') {
          console.warn(
            `  Skipped SSG for ${outputRoute} — ${message}. ` +
            `The page will render correctly client-side.`
          )
        } else {
          console.warn(`  Warning: Failed to render ${outputRoute}: ${message}`)
        }
        continue
      }

      // ⛔ `notFound` cannot happen here — this loop iterates pages it already has,
      // so `render` never resolves. Handled anyway: silently writing nothing for a
      // page the loop selected would be the same shape of empty-success bug that
      // `renderPage`'s content-not-loaded guard exists to catch.
      if (result.outcome === 'notFound') {
        console.warn(`  Warning: ${outputRoute} resolved to no page; skipped`)
        continue
      }

      let html = result.html

      // Build-specific: theme CSS, __SITE_CONTENT__, icon cache.
      // scopeRoutes mirrors the runtime data cascade (page → page.parent → site)
      // so split-mode pages embed only the collection data their first render reads.
      const scopeRoutes = new Set([page.route, page.parent?.route].filter(Boolean))
      html = injectBuildData(html, siteContent, {
        splitContent,
        currentRoute: page.route,
        scopeRoutes,
      })

      // Output to the locale-prefixed route
      const outputPath = getOutputPath(distDir, outputRoute)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, html)

      renderedFiles.push(outputPath)
      onProgress(`  → ${outputPath.replace(distDir, 'dist')}`)
    }

    // Write 404.html — shared logic from @uniweb/runtime/ssr
    const fallbackBaseHtml = injectBuildData(htmlShell, siteContent, {
      splitContent,
      currentRoute: null,  // 404 has no current page — manifest only
      scopeRoutes: new Set(),  // SPA fallback carries site-level fetched data only
    })
    const { html: notFoundHtml, hasNotFoundPage } = generate404Html({
      baseHtml: fallbackBaseHtml,
      website,
      siteContent,
    })

    const fallbackDir = routePrefix ? join(distDir, routePrefix.replace(/^\//, '')) : distDir
    await mkdir(fallbackDir, { recursive: true })
    await writeFile(join(fallbackDir, '404.html'), notFoundHtml)
    const fallbackNote = hasNotFoundPage ? '404 page + SPA fallback' : 'SPA fallback'
    onProgress(`  → ${routePrefix || ''}404.html (${fallbackNote})`)

    // Rewrite site-content.json as lightweight manifest (for shell/CF mode)
    // Must happen after all HTML files are written since some code re-reads it.
    if (splitContent) {
      const manifest = {
        ...siteContent,
        pages: siteContent.pages.map(page => {
          if (page.isDynamic) return page
          const { sections, ...metadata } = page
          return metadata
        })
      }
      // The manifest is a single (non-per-page) file, so it keeps all fetched
      // data — but the internal `_scope` tag must never leak into it.
      if (Array.isArray(manifest.fetchedData)) {
        manifest.fetchedData = manifest.fetchedData.map(stripFetchScope)
      }
      await writeFile(localeContentPath, JSON.stringify(manifest))
      onProgress('Rewrote site-content.json as lightweight manifest')
    }
  }

  // Emit host-specific helper files via the selected host adapter.
  //
  // Resolution order:
  //   1) CLI --host flag (hostOverride)
  //   2) CI host detected from env vars (Vercel, CF Pages, Netlify)
  //   3) 'cloudflare-pages' default (preserves the historical
  //      `_redirects` output; same format also works on Netlify)
  //
  // The build does not read deploy.yml. When the orchestrator
  // (uniweb deploy) needs adapter-specific config (bucket,
  // distributionId, …) at deploy time, it passes deploy.yml's resolved
  // target to the adapter's deploy hook directly. postBuild consumes
  // only the host name and the ciContext (artifact provenance).
  const ciContext = detectCiContext()
  const hostName = hostOverride || ciContext?.host || 'cloudflare-pages'
  const adapter = getAdapter(hostName)
  if (ciContext?.runner) {
    onProgress(`CI runner: ${ciContext.runner}${ciContext.host ? '' : ' (host not implied)'}`)
  }
  onProgress(`Host adapter: ${adapter.name}`)
  await adapter.postBuild({
    distDir,
    siteContent: defaultSiteContent,
    localeConfigs,
    ciContext,
    onProgress,
  })

  onProgress(`\nPre-rendered ${renderedFiles.length} pages across ${localeConfigs.length} locale(s)`)

  return {
    pages: renderedFiles.length,
    files: renderedFiles
  }
}

export default prerenderSite
