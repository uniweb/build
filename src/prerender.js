/**
 * SSG Prerendering for Uniweb Sites
 *
 * Renders each page to static HTML at build time.
 * The output includes full HTML with hydration support.
 *
 * Uses @uniweb/runtime/ssr for rendering components, ensuring
 * the same code path for both SSG and client-side rendering.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { executeFetch, mergeDataIntoContent, singularize } from './site/data-fetcher.js'

/**
 * Resolve an extension URL to a filesystem path for prerender.
 * Browser URLs like "/effects/foundation.js" need mapping to local files.
 *
 * Resolution order:
 * 1. dist directory (post-build copy target, e.g., site/dist/effects/foundation.js)
 * 2. Project root with dist subdir (dev layout, e.g., project/effects/dist/foundation.js)
 * 3. Original URL (absolute or remote — let import() handle it)
 */
function resolveExtensionPath(url, distDir, projectRoot) {
  // Only resolve URLs that look like root-relative paths
  if (url.startsWith('/')) {
    // Try dist directory first (production: files copied to site/dist/)
    const distPath = join(distDir, url)
    if (existsSync(distPath)) return distPath

    // Try project root with dist subdir (dev layout: effects/dist/foundation.js)
    // "/effects/foundation.js" → "effects/dist/foundation.js"
    const parts = url.slice(1).split('/')
    if (parts.length >= 2) {
      const pkgName = parts[0]
      const rest = parts.slice(1).join('/')
      const devPath = join(projectRoot, pkgName, 'dist', rest)
      if (existsSync(devPath)) return devPath
    }
  }

  // Return as-is for absolute paths or remote URLs
  return url
}

// Lazily loaded dependencies
let React, renderToString, createUniweb
let preparePropsSSR, getComponentMetaSSR

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
    if (!isNonDefaultLocale || !config.path?.startsWith('/data/')) return config
    return { ...config, path: `/${localeInfo.locale}${config.path}` }
  }

  // Fetch options pointing to dist/ for localized data
  const localizedFetchOptions = isNonDefaultLocale
    ? { siteRoot: localeInfo.distDir, publicDir: '.' }
    : fetchOptions

  // 1. Site-level fetch
  const siteFetch = siteContent.config?.fetch
  if (siteFetch && siteFetch.prerender !== false) {
    const cfg = localizeFetch(siteFetch)
    const opts = cfg !== siteFetch ? localizedFetchOptions : fetchOptions
    onProgress(`  Fetching site data: ${cfg.path || cfg.url}`)
    const result = await executeFetch(cfg, opts)
    if (result.data && !result.error) {
      fetchedData.push({ config: cfg, data: result.data })
    }
  }

  // 2. Process each page and track fetched data by route
  const pageFetchedData = new Map()

  for (const page of siteContent.pages || []) {
    // Page-level fetch
    const pageFetch = page.fetch
    if (pageFetch && pageFetch.prerender !== false) {
      const cfg = localizeFetch(pageFetch)
      const opts = cfg !== pageFetch ? localizedFetchOptions : fetchOptions
      onProgress(`  Fetching page data for ${page.route}: ${cfg.path || cfg.url}`)
      const result = await executeFetch(cfg, opts)
      if (result.data && !result.error) {
        fetchedData.push({ config: cfg, data: result.data })
        // Store for dynamic route expansion
        pageFetchedData.set(page.route, {
          schema: pageFetch.schema,
          data: result.data,
        })
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
function expandDynamicPages(pages, pageFetchedData, onProgress) {
  const expandedPages = []

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
    const singularSchema = singularize(schema)

    onProgress(`  Expanding ${page.route} → ${items.length} pages from ${schema}`)

    // Create a concrete page for each item
    for (const item of items) {
      // Get the param value from the item (e.g., item.slug for :slug)
      const paramValue = item[paramName]
      if (!paramValue) {
        onProgress(`    Skipping item without ${paramName}`)
        continue
      }

      // Create concrete route: /blog/:slug → /blog/my-post
      const concreteRoute = page.route.replace(`:${paramName}`, paramValue)

      // Deep clone the page with modifications
      const concretePage = JSON.parse(JSON.stringify(page))
      concretePage.route = concreteRoute
      concretePage.isDynamic = false // No longer dynamic
      concretePage.paramName = undefined
      concretePage.parentSchema = undefined

      // Store the dynamic route context for runtime data resolution
      concretePage.dynamicContext = {
        paramName,
        paramValue,
        schema,           // Plural: 'articles'
        singularSchema,   // Singular: 'article'
        currentItem: item,    // The item for this specific route
        allItems: items,      // All items from parent
      }

      // Use item data for page metadata if available
      if (item.title) concretePage.title = item.title
      if (item.description || item.excerpt) concretePage.description = item.description || item.excerpt

      expandedPages.push(concretePage)
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
    // Execute section-level fetch
    const sectionFetch = section.fetch
    if (sectionFetch && sectionFetch.prerender !== false) {
      onProgress(`  Fetching section data: ${sectionFetch.path || sectionFetch.url}`)
      const result = await executeFetch(sectionFetch, fetchOptions)
      if (result.data && !result.error) {
        // Merge fetched data into section's parsedContent
        section.parsedContent = mergeDataIntoContent(
          section.parsedContent || {},
          result.data,
          sectionFetch.schema,
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
 * Load dependencies dynamically from the site's context
 * This ensures we use the same React instance as the foundation
 *
 * @param {string} siteDir - Path to the site directory
 */
async function loadDependencies(siteDir) {
  if (React) return // Already loaded

  // Load React from the site's node_modules using createRequire.
  // This ensures we get the same React instance as the foundation
  // components (which are loaded via pathToFileURL and externalize React
  // to the same node_modules). Using bare import('react') would resolve
  // from @uniweb/build's context, creating a dual-React instance problem.
  const absoluteSiteDir = resolve(siteDir)
  const siteRequire = createRequire(join(absoluteSiteDir, 'package.json'))

  try {
    const reactMod = siteRequire('react')
    const serverMod = siteRequire('react-dom/server')
    React = reactMod.default || reactMod
    renderToString = serverMod.renderToString
  } catch {
    const [reactMod, serverMod] = await Promise.all([
      import('react'),
      import('react-dom/server')
    ])
    React = reactMod.default || reactMod
    renderToString = serverMod.renderToString
  }

  // Load @uniweb/core
  const coreMod = await import('@uniweb/core')
  createUniweb = coreMod.createUniweb

  // Load pure utility functions from runtime SSR bundle.
  // These are plain functions (no hooks), so they work even if the SSR
  // bundle resolves a different React instance internally.
  const runtimeMod = await import('@uniweb/runtime/ssr')
  preparePropsSSR = runtimeMod.prepareProps
  getComponentMetaSSR = runtimeMod.getComponentMeta
}

/**
 * Pre-fetch icons from CDN and populate the Uniweb icon cache.
 * This allows the Icon component to render SVGs synchronously during SSR
 * instead of producing empty placeholders.
 */
async function prefetchIcons(siteContent, uniweb, onProgress) {
  const icons = siteContent.icons?.used || []
  if (icons.length === 0) return

  const cdnBase = siteContent.config?.icons?.cdnUrl || 'https://uniweb.github.io/icons'

  onProgress(`Fetching ${icons.length} icons for SSR...`)

  const results = await Promise.allSettled(
    icons.map(async (iconRef) => {
      const [family, name] = iconRef.split(':')
      const url = `${cdnBase}/${family}/${family}-${name}.svg`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const svg = await response.text()
      uniweb.iconCache.set(`${family}:${name}`, svg)
    })
  )

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  if (failed > 0) {
    console.warn(`[prerender] Fetched ${succeeded}/${icons.length} icons (${failed} failed)`)
  }

  // Store icon cache on siteContent for embedding in HTML
  // This allows the client runtime to populate the cache before rendering
  if (uniweb.iconCache.size > 0) {
    siteContent._iconCache = Object.fromEntries(uniweb.iconCache)
  }
}

/**
 * Valid color contexts for section theming
 */
const VALID_CONTEXTS = ['light', 'medium', 'dark']

/**
 * Build wrapper props from block configuration
 * Mirrors getWrapperProps in BlockRenderer.jsx
 */
function getWrapperProps(block) {
  const theme = block.themeName
  const blockClassName = block.state?.className || ''

  let contextClass = ''
  if (theme && VALID_CONTEXTS.includes(theme)) {
    contextClass = `context-${theme}`
  }

  let className = contextClass
  if (blockClassName) {
    className = className ? `${className} ${blockClassName}` : blockClassName
  }

  const { background = {} } = block.standardOptions
  const style = {}
  if (background.mode) {
    style.position = 'relative'
  }

  // Apply context overrides as inline CSS custom properties (mirrors BlockRenderer.jsx)
  if (block.contextOverrides) {
    for (const [key, value] of Object.entries(block.contextOverrides)) {
      style[`--${key}`] = value
    }
  }

  const sectionId = block.stableId || block.id
  return { id: `section-${sectionId}`, style, className, background }
}

/**
 * Render a background element for SSR
 * Mirrors the Background component in Background.jsx (image, color, gradient only)
 * Video backgrounds are skipped in SSR (they require JS for autoplay)
 */
function renderBackground(background) {
  if (!background?.mode) return null

  const containerStyle = {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    zIndex: 0,
  }

  const children = []

  // Resolve URL against basePath for subdirectory deployments
  const basePath = globalThis.uniweb?.activeWebsite?.basePath || ''
  function resolveUrl(url) {
    if (!url || !url.startsWith('/')) return url
    if (!basePath) return url
    if (url.startsWith(basePath + '/') || url === basePath) return url
    return basePath + url
  }

  if (background.mode === 'color' && background.color) {
    children.push(
      React.createElement('div', {
        key: 'bg-color',
        className: 'background-color',
        style: { position: 'absolute', inset: '0', backgroundColor: background.color },
        'aria-hidden': 'true'
      })
    )
  }

  if (background.mode === 'gradient' && background.gradient) {
    const g = background.gradient
    // Raw CSS gradient string (e.g., "linear-gradient(to bottom, #000, #333)")
    const bgValue = typeof g === 'string' ? g
      : `linear-gradient(${g.angle || 0}deg, ${g.start || 'transparent'} ${g.startPosition || 0}%, ${g.end || 'transparent'} ${g.endPosition || 100}%)`
    children.push(
      React.createElement('div', {
        key: 'bg-gradient',
        className: 'background-gradient',
        style: {
          position: 'absolute', inset: '0',
          background: bgValue
        },
        'aria-hidden': 'true'
      })
    )
  }

  if (background.mode === 'image' && background.image?.src) {
    const img = background.image
    children.push(
      React.createElement('div', {
        key: 'bg-image',
        className: 'background-image',
        style: {
          position: 'absolute', inset: '0',
          backgroundImage: `url(${resolveUrl(img.src)})`,
          backgroundPosition: img.position || 'center',
          backgroundSize: img.size || 'cover',
          backgroundRepeat: 'no-repeat'
        },
        'aria-hidden': 'true'
      })
    )
  }

  // Overlay
  if (background.overlay?.enabled) {
    const ov = background.overlay
    let overlayStyle

    if (ov.gradient) {
      const g = ov.gradient
      overlayStyle = {
        position: 'absolute', inset: '0', pointerEvents: 'none',
        background: `linear-gradient(${g.angle || 180}deg, ${g.start || 'rgba(0,0,0,0.7)'} ${g.startPosition || 0}%, ${g.end || 'rgba(0,0,0,0)'} ${g.endPosition || 100}%)`,
        opacity: ov.opacity ?? 0.5
      }
    } else {
      const baseColor = ov.type === 'light' ? '255, 255, 255' : '0, 0, 0'
      overlayStyle = {
        position: 'absolute', inset: '0', pointerEvents: 'none',
        backgroundColor: `rgba(${baseColor}, ${ov.opacity ?? 0.5})`
      }
    }

    children.push(
      React.createElement('div', {
        key: 'bg-overlay',
        className: 'background-overlay',
        style: overlayStyle,
        'aria-hidden': 'true'
      })
    )
  }

  if (children.length === 0) return null

  return React.createElement('div', {
    className: `background background--${background.mode}`,
    style: containerStyle,
    'aria-hidden': 'true'
  }, ...children)
}

/**
 * Render a single block for SSR
 * Mirrors BlockRenderer.jsx but without hooks (no runtime data fetching in SSR).
 * block.dataLoading is always false at prerender time — runtime fetches only happen client-side.
 */
function renderBlock(block, { pure = false } = {}) {
  const Component = block.initComponent()

  if (!Component) {
    return React.createElement('div', {
      className: 'block-error',
      style: { padding: '1rem', background: '#fef2f2', color: '#dc2626' }
    }, `Component not found: ${block.type}`)
  }

  // Build content and params with runtime guarantees
  const meta = getComponentMetaSSR(block.type)
  const prepared = preparePropsSSR(block, meta)
  let params = prepared.params
  let content = {
    ...prepared.content,
    ...block.properties,
  }

  // Resolve inherited entity data (mirrors BlockRenderer.jsx)
  // EntityStore walks page/site hierarchy to find data matching meta.inheritData
  const entityStore = block.website?.entityStore
  if (entityStore) {
    const resolved = entityStore.resolve(block, meta)
    if (resolved.status === 'ready' && resolved.data) {
      const merged = { ...content.data }
      for (const key of Object.keys(resolved.data)) {
        if (merged[key] === undefined) {
          merged[key] = resolved.data[key]
        }
      }
      content.data = merged
    }
  }

  const componentProps = { content, params, block }

  // Pure mode: render component without section wrapper (used by ChildBlocks)
  if (pure) {
    return React.createElement(Component, componentProps)
  }

  // Background handling (mirrors BlockRenderer.jsx)
  const { background, ...wrapperProps } = getWrapperProps(block)

  // Merge Component.className (static classes declared on the component function)
  // Order: context-{theme} + block.state.className + Component.className
  const componentClassName = Component.className
  if (componentClassName) {
    wrapperProps.className = wrapperProps.className
      ? `${wrapperProps.className} ${componentClassName}`
      : componentClassName
  }

  const hasBackground = background?.mode && meta?.background !== 'self'

  block.hasBackground = hasBackground

  // Use Component.as as the wrapper tag (default: 'section')
  const wrapperTag = Component.as || 'section'

  if (hasBackground) {
    return React.createElement(wrapperTag, wrapperProps,
      renderBackground(background),
      React.createElement('div', { className: 'relative z-10' },
        React.createElement(Component, componentProps)
      )
    )
  }

  return React.createElement(wrapperTag, wrapperProps,
    React.createElement(Component, componentProps)
  )
}

/**
 * Render an array of blocks for SSR
 */
function renderBlocks(blocks) {
  if (!blocks || blocks.length === 0) return null
  return blocks.map((block, index) =>
    React.createElement(React.Fragment, { key: block.id || index },
      renderBlock(block)
    )
  )
}

/**
 * Render page layout for SSR
 */
function renderLayout(page, website) {
  const layoutName = page.getLayoutName()
  const RemoteLayout = website.getRemoteLayout(layoutName)
  const layoutMeta = website.getLayoutMeta(layoutName)

  const bodyBlocks = page.getBodyBlocks()
  const areas = page.getLayoutAreas()

  const bodyElement = bodyBlocks ? renderBlocks(bodyBlocks) : null
  const areaElements = {}
  for (const [name, blocks] of Object.entries(areas)) {
    areaElements[name] = renderBlocks(blocks)
  }

  if (RemoteLayout) {
    const params = { ...(layoutMeta?.defaults || {}), ...(page.getLayoutParams() || {}) }

    return React.createElement(RemoteLayout, {
      page, website, params,
      body: bodyElement,
      ...areaElements,
    })
  }

  return React.createElement(React.Fragment, null,
    areaElements.header && React.createElement('header', null, areaElements.header),
    bodyElement && React.createElement('main', null, bodyElement),
    areaElements.footer && React.createElement('footer', null, areaElements.footer)
  )
}

/**
 * Create a page element for SSR
 */
function createPageElement(page, website) {
  return renderLayout(page, website)
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
  const defaultLocale = defaultContent.config?.defaultLanguage || 'en'

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
      if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(entry)) continue

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
    if (process.env.DEBUG) {
      console.error('Error discovering locale contents:', err.message)
    }
  }

  return locales
}

/**
 * Pre-render all pages in a built site to static HTML
 *
 * @param {string} siteDir - Path to the site directory
 * @param {Object} options
 * @param {string} options.foundationDir - Path to foundation directory (default: ../foundation)
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<{pages: number, files: string[]}>}
 */
export async function prerenderSite(siteDir, options = {}) {
  const {
    foundationDir = join(siteDir, '..', 'foundation'),
    onProgress = () => {}
  } = options

  const distDir = join(siteDir, 'dist')

  // Verify build exists
  if (!existsSync(distDir)) {
    throw new Error(`Site must be built first. No dist directory found at: ${distDir}`)
  }

  // Load dependencies from site's context (ensures same React instance as foundation)
  onProgress('Loading dependencies...')
  await loadDependencies(siteDir)

  // Load default site content
  onProgress('Loading site content...')
  const contentPath = join(distDir, 'site-content.json')
  if (!existsSync(contentPath)) {
    throw new Error(`site-content.json not found at: ${contentPath}`)
  }
  const defaultSiteContent = JSON.parse(await readFile(contentPath, 'utf8'))

  // Discover all locale content files
  const localeConfigs = await discoverLocaleContents(distDir, defaultSiteContent)
  if (localeConfigs.length > 1) {
    onProgress(`Found ${localeConfigs.length} locales: ${localeConfigs.map(l => l.locale).join(', ')}`)
  }

  // Load the foundation module (shared across all locales)
  onProgress('Loading foundation...')
  const foundationPath = join(foundationDir, 'dist', 'foundation.js')
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
    const siteContent = JSON.parse(await readFile(localeContentPath, 'utf8'))

    // Set the active locale in the content
    siteContent.config = siteContent.config || {}
    siteContent.config.activeLocale = locale

    // Execute data fetches (site, page, section levels)
    // For non-default locales, collection data is read from dist/{locale}/data/
    onProgress('Executing data fetches...')
    const defaultLocale = defaultSiteContent.config?.defaultLanguage || 'en'
    const { pageFetchedData, fetchedData } = await executeAllFetches(
      siteContent, siteDir, onProgress,
      { locale, defaultLocale, distDir }
    )

    // Store fetchedData on siteContent for runtime DataStore pre-population
    siteContent.fetchedData = fetchedData

    // Expand dynamic pages (e.g., /blog/:slug → /blog/post-1, /blog/post-2)
    if (siteContent.pages?.some(p => p.isDynamic)) {
      onProgress('Expanding dynamic routes...')
      siteContent.pages = expandDynamicPages(siteContent.pages, pageFetchedData, onProgress)
    }

    // Load the HTML shell for this locale
    const shellPath = existsSync(htmlPath) ? htmlPath : join(distDir, 'index.html')
    const htmlShell = await readFile(shellPath, 'utf8')

    // Initialize the Uniweb runtime for this locale
    onProgress('Initializing runtime...')
    const uniweb = createUniweb(siteContent)

    // Pre-populate DataStore so EntityStore can resolve data during prerender
    if (fetchedData.length > 0 && uniweb.activeWebsite?.dataStore) {
      for (const entry of fetchedData) {
        uniweb.activeWebsite.dataStore.set(entry.config, entry.data)
      }
    }

    uniweb.setFoundation(foundation)

    // Load extensions (secondary foundations via URL)
    const extensions = siteContent.config?.extensions
    if (extensions?.length) {
      onProgress(`Loading ${extensions.length} extension(s)...`)
      const projectRoot = join(siteDir, '..')
      for (const ext of extensions) {
        try {
          const url = typeof ext === 'string' ? ext : ext.url
          const extPath = resolveExtensionPath(url, distDir, projectRoot)
          const extModule = await import(pathToFileURL(extPath).href)
          uniweb.registerExtension(extModule)
          onProgress(`  Extension loaded: ${url}`)
        } catch (err) {
          onProgress(`  Warning: Extension failed to load: ${ext} (${err.message})`)
        }
      }
    }

    // Set base path from site config so components can access it during SSR
    // (e.g., <Link reload> needs basePath to prefix hrefs for subdirectory deployments)
    if (siteContent.config?.base && uniweb.activeWebsite?.setBasePath) {
      uniweb.activeWebsite.setBasePath(siteContent.config.base)
    }

    // Set foundation capabilities (Layout, props, etc.)
    if (foundation.default?.capabilities) {
      uniweb.setFoundationConfig(foundation.default.capabilities)
    }

    // Attach layout metadata (areas, transitions, defaults)
    if (foundation.default?.layoutMeta && uniweb.foundationConfig) {
      uniweb.foundationConfig.layoutMeta = foundation.default.layoutMeta
    }

    // Set childBlockRenderer so foundation components using ChildBlocks/Visual
    // can render child blocks and insets during prerender (inline, no hooks)
    uniweb.childBlockRenderer = function InlineChildBlocks({ blocks, from, pure = false }) {
      const blockList = blocks || from?.childBlocks || []
      return blockList.map((childBlock, index) =>
        React.createElement(React.Fragment, { key: childBlock.id || index },
          renderBlock(childBlock, { pure })
        )
      )
    }

    // Pre-fetch icons for SSR embedding
    await prefetchIcons(siteContent, uniweb, onProgress)

    // Pre-render each page
    const pages = uniweb.activeWebsite.pages
    const website = uniweb.activeWebsite

    for (const page of pages) {
      // Skip dynamic template pages — they exist in the content for runtime
      // route matching but can't be pre-rendered (no concrete route)
      if (page.route.includes(':')) continue

      // Build the output route with locale prefix
      // For non-default locales, translate route slugs (e.g., /about → /acerca-de)
      const translatedPageRoute = isDefault ? page.route : website.translateRoute(page.route, locale)
      const outputRoute = routePrefix + translatedPageRoute

      onProgress(`Rendering ${outputRoute}...`)

      // Set this as the active page
      uniweb.activeWebsite.setActivePage(page.route)

      // Create the page element for SSR
      const element = createPageElement(page, website)

      // Render to HTML string
      let renderedContent
      try {
        renderedContent = renderToString(element)
      } catch (err) {
        const msg = err.message || ''

        if (msg.includes('Invalid hook call') || msg.includes('useState') || msg.includes('useEffect')) {
          console.warn(
            `  Skipped SSG for ${outputRoute} — contains components with React hooks ` +
            `(useState/useEffect) that cannot render during pre-rendering. ` +
            `The page will render correctly client-side.`
          )
        } else if (msg.includes('Element type is invalid') && msg.includes('null')) {
          console.warn(
            `  Skipped SSG for ${outputRoute} — a component resolved to null during pre-rendering. ` +
            `This often happens with components that use React hooks. ` +
            `The page will render correctly client-side.`
          )
        } else {
          console.warn(`  Warning: Failed to render ${outputRoute}: ${msg}`)
        }

        if (process.env.DEBUG) {
          console.error(err.stack)
        }
        continue
      }

      // Inject into shell
      const html = injectContent(htmlShell, renderedContent, page, siteContent)

      // Output to the locale-prefixed route
      const outputPath = getOutputPath(distDir, outputRoute)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, html)

      renderedFiles.push(outputPath)
      onProgress(`  → ${outputPath.replace(distDir, 'dist')}`)
    }
  }

  onProgress(`\nPre-rendered ${renderedFiles.length} pages across ${localeConfigs.length} locale(s)`)

  return {
    pages: renderedFiles.length,
    files: renderedFiles
  }
}

/**
 * Inject rendered content into HTML shell
 */
function injectContent(shell, renderedContent, page, siteContent) {
  let html = shell

  // Inject theme CSS if not already present
  if (siteContent?.theme?.css && !html.includes('id="uniweb-theme"')) {
    html = html.replace(
      '</head>',
      `  <style id="uniweb-theme">\n${siteContent.theme.css}\n    </style>\n  </head>`
    )
  }

  // Replace the empty root div with pre-rendered content
  html = html.replace(
    /<div id="root">[\s\S]*?<\/div>/,
    `<div id="root">${renderedContent}</div>`
  )

  // Update page title
  if (page.title) {
    html = html.replace(
      /<title>.*?<\/title>/,
      `<title>${escapeHtml(page.title)}</title>`
    )
  }

  // Add meta description if available
  if (page.description) {
    const metaDesc = `<meta name="description" content="${escapeHtml(page.description)}">`
    if (html.includes('<meta name="description"')) {
      html = html.replace(
        /<meta name="description"[^>]*>/,
        metaDesc
      )
    } else {
      html = html.replace(
        '</head>',
        `  ${metaDesc}\n  </head>`
      )
    }
  }

  // Inject site content as JSON for hydration
  // Replace existing content if present, otherwise add it
  // Strip CSS from theme (it's already in a <style> tag)
  const contentForJson = { ...siteContent }
  if (contentForJson.theme?.css) {
    contentForJson.theme = { ...contentForJson.theme }
    delete contentForJson.theme.css
  }
  const contentScript = `<script id="__SITE_CONTENT__" type="application/json">${JSON.stringify(contentForJson).replace(/</g, '\\u003c')}</script>`
  if (html.includes('__SITE_CONTENT__')) {
    // Replace existing site content with updated version (includes expanded dynamic routes)
    // Match script tag with attributes in any order
    html = html.replace(
      /<script[^>]*id="__SITE_CONTENT__"[^>]*>[\s\S]*?<\/script>/,
      contentScript
    )
  } else {
    html = html.replace(
      '</head>',
      `  ${contentScript}\n  </head>`
    )
  }

  // Inject icon cache so client can render icons immediately without CDN fetches
  if (siteContent._iconCache) {
    const iconScript = `<script id="__ICON_CACHE__" type="application/json">${JSON.stringify(siteContent._iconCache).replace(/</g, '\\u003c')}</script>`
    if (html.includes('__ICON_CACHE__')) {
      html = html.replace(
        /<script[^>]*id="__ICON_CACHE__"[^>]*>[\s\S]*?<\/script>/,
        iconScript
      )
    } else {
      html = html.replace(
        '</head>',
        `  ${iconScript}\n  </head>`
      )
    }
  }

  return html
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
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default prerenderSite
