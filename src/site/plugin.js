/**
 * Vite Plugin: Site Content
 *
 * Collects site content from pages/ directory and injects it into HTML.
 * Watches for changes in development mode.
 *
 * SEO Features:
 * - Generates sitemap.xml from collected pages
 * - Generates robots.txt
 * - Injects Open Graph, Twitter, and canonical meta tags
 * - Supports hreflang for multi-locale sites
 *
 * @module @uniweb/build/site
 *
 * @example
 * import { siteContentPlugin } from '@uniweb/build/site'
 *
 * export default defineConfig({
 *   plugins: [
 *     siteContentPlugin({
 *       sitePath: './site',
 *       inject: true,
 *       seo: {
 *         baseUrl: 'https://example.com',
 *         defaultImage: '/og-image.png',
 *         twitterHandle: '@example'
 *       }
 *     })
 *   ]
 * })
 */

import { resolve, join } from 'node:path'
import { watch, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { collectSiteContent } from './content-collector.js'
import { processAssets, rewriteSiteContentPaths } from './asset-processor.js'
import { processAdvancedAssets } from './advanced-processors.js'
import { processCollections, writeCollectionFiles } from './collection-processor.js'
import { executeFetch, mergeDataIntoContent } from './data-fetcher.js'

/**
 * Execute all fetches for site content (used in dev mode)
 * Collects fetchedData for DataStore pre-population at runtime
 *
 * @param {Object} siteContent - The collected site content
 * @param {string} siteDir - Path to site directory
 */
async function executeDevFetches(siteContent, siteDir) {
  const fetchOptions = { siteRoot: siteDir, publicDir: 'public' }
  const fetchedData = []

  // Site-level fetch
  const siteFetch = siteContent.config?.fetch
  if (siteFetch) {
    const result = await executeFetch(siteFetch, fetchOptions)
    if (result.data && !result.error) {
      fetchedData.push({ config: siteFetch, data: result.data })
    }
  }

  // Process each page
  for (const page of siteContent.pages || []) {
    // Page-level fetch
    const pageFetch = page.fetch
    if (pageFetch) {
      const result = await executeFetch(pageFetch, fetchOptions)
      if (result.data && !result.error) {
        fetchedData.push({ config: pageFetch, data: result.data })
      }
    }

    // Process section-level fetches (own fetch → parsedContent.data)
    await processDevSectionFetches(page.sections, fetchOptions)
  }

  // Store on siteContent for runtime DataStore pre-population
  siteContent.fetchedData = fetchedData
}

/**
 * Process fetches for sections recursively
 * Section-level fetches merge data into parsedContent.data (not cascaded).
 *
 * @param {Array} sections - Sections to process
 * @param {Object} fetchOptions - Options for executeFetch
 */
async function processDevSectionFetches(sections, fetchOptions) {
  if (!sections || !Array.isArray(sections)) return

  for (const section of sections) {
    // Execute section-level fetch
    const sectionFetch = section.fetch
    if (sectionFetch) {
      const result = await executeFetch(sectionFetch, fetchOptions)
      if (result.data && !result.error) {
        // Merge fetched data into section's parsedContent (not cascadedData)
        // This matches prerender behavior - section's own fetch goes to content.data
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
      await processDevSectionFetches(section.subsections, fetchOptions)
    }
  }
}
import { generateSearchIndex, isSearchEnabled, getSearchIndexFilename } from '../search/index.js'
import { mergeTranslations } from '../i18n/merge.js'

/**
 * Translate a canonical route for a given locale using route translations config
 * Supports exact and prefix matching (e.g., /blog → /noticias also applies to /blog/post)
 */
function applyRouteTranslation(route, locale, routeTranslations) {
  const localeMap = routeTranslations?.[locale]
  if (!localeMap) return route
  // Exact match
  if (localeMap[route]) return localeMap[route]
  // Prefix match
  for (const [canonical, translated] of Object.entries(localeMap)) {
    if (route.startsWith(canonical + '/')) {
      return translated + route.slice(canonical.length)
    }
  }
  return route
}

/**
 * Generate sitemap.xml content
 */
function generateSitemap(pages, baseUrl, locales = [], routeTranslations = {}) {
  const urls = []

  for (const page of pages) {
    // Skip pages marked as noindex
    if (page.seo?.noindex) continue

    const loc = baseUrl + (page.route === '/' ? '' : page.route)
    const lastmod = page.lastModified || new Date().toISOString().split('T')[0]
    const changefreq = page.seo?.changefreq || 'weekly'
    const priority = page.seo?.priority ?? (page.route === '/' ? '1.0' : '0.8')

    let urlEntry = `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod.split('T')[0]}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>`

    // Add hreflang entries for multi-locale sites
    if (locales.length > 1) {
      for (const locale of locales) {
        let localeLoc
        if (locale.default) {
          localeLoc = loc
        } else {
          const translatedRoute = page.route === '/' ? '' : applyRouteTranslation(page.route, locale.code, routeTranslations)
          localeLoc = `${baseUrl}/${locale.code}${translatedRoute}`
        }
        urlEntry += `\n    <xhtml:link rel="alternate" hreflang="${locale.code}" href="${escapeXml(localeLoc)}" />`
      }
      // Add x-default pointing to default locale
      urlEntry += `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(loc)}" />`
    }

    urlEntry += '\n  </url>'
    urls.push(urlEntry)
  }

  const xmlnsExtra = locales.length > 1 ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlnsExtra}>
${urls.join('\n')}
</urlset>`
}

/**
 * Escape special characters for XML
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generate robots.txt content
 */
function generateRobotsTxt(baseUrl, options = {}) {
  const {
    disallow = [],
    allow = [],
    crawlDelay = null,
    additionalSitemaps = []
  } = options

  let content = 'User-agent: *\n'

  for (const path of allow) {
    content += `Allow: ${path}\n`
  }

  for (const path of disallow) {
    content += `Disallow: ${path}\n`
  }

  if (crawlDelay) {
    content += `Crawl-delay: ${crawlDelay}\n`
  }

  content += `\nSitemap: ${baseUrl}/sitemap.xml\n`

  for (const sitemap of additionalSitemaps) {
    content += `Sitemap: ${sitemap}\n`
  }

  return content
}

/**
 * Generate meta tags for SEO
 */
function generateMetaTags(siteContent, seoOptions) {
  const { baseUrl, defaultImage, twitterHandle, locales = [] } = seoOptions
  const siteConfig = siteContent.config || {}
  const tags = []

  const siteName = siteConfig.name || siteConfig.title || ''
  const siteDescription = siteConfig.description || ''
  const ogImage = siteConfig.image || defaultImage

  // Basic meta
  if (siteDescription) {
    tags.push(`<meta name="description" content="${escapeHtml(siteDescription)}">`)
  }

  // Canonical URL (for homepage)
  if (baseUrl) {
    tags.push(`<link rel="canonical" href="${baseUrl}/">`)
  }

  // Open Graph
  tags.push(`<meta property="og:type" content="website">`)
  if (siteName) {
    tags.push(`<meta property="og:site_name" content="${escapeHtml(siteName)}">`)
    tags.push(`<meta property="og:title" content="${escapeHtml(siteName)}">`)
  }
  if (siteDescription) {
    tags.push(`<meta property="og:description" content="${escapeHtml(siteDescription)}">`)
  }
  if (baseUrl) {
    tags.push(`<meta property="og:url" content="${baseUrl}/">`)
  }
  if (ogImage) {
    const imageUrl = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`
    tags.push(`<meta property="og:image" content="${imageUrl}">`)
  }

  // Twitter Card
  tags.push(`<meta name="twitter:card" content="summary_large_image">`)
  if (twitterHandle) {
    tags.push(`<meta name="twitter:site" content="${twitterHandle}">`)
  }
  if (siteName) {
    tags.push(`<meta name="twitter:title" content="${escapeHtml(siteName)}">`)
  }
  if (siteDescription) {
    tags.push(`<meta name="twitter:description" content="${escapeHtml(siteDescription)}">`)
  }
  if (ogImage) {
    const imageUrl = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`
    tags.push(`<meta name="twitter:image" content="${imageUrl}">`)
  }

  // Hreflang for multi-locale sites
  if (baseUrl && locales.length > 1) {
    for (const locale of locales) {
      const href = locale.default ? `${baseUrl}/` : `${baseUrl}/${locale.code}/`
      tags.push(`<link rel="alternate" hreflang="${locale.code}" href="${href}">`)
    }
    tags.push(`<link rel="alternate" hreflang="x-default" href="${baseUrl}/">`)
  }

  return tags.join('\n    ')
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Create the site content plugin
 *
 * @param {Object} options
 * @param {string} [options.sitePath='./'] - Path to site directory
 * @param {string} [options.pagesDir='pages'] - Pages directory name
 * @param {string} [options.variableName='__SITE_CONTENT__'] - Script ID for injected content
 * @param {boolean} [options.inject=true] - Inject content into HTML
 * @param {string} [options.filename='site-content.json'] - Output filename
 * @param {boolean} [options.watch=true] - Watch for changes in dev mode
 * @param {Object} [options.seo] - SEO configuration
 * @param {string} [options.seo.baseUrl] - Base URL for sitemap and canonical URLs
 * @param {string} [options.seo.defaultImage] - Default OG image path
 * @param {string} [options.seo.twitterHandle] - Twitter handle for cards
 * @param {Array} [options.seo.locales] - Locales for hreflang [{code: 'en', default: true}, {code: 'es'}]
 * @param {Object} [options.seo.robots] - robots.txt configuration
 * @param {Array} [options.seo.robots.disallow] - Paths to disallow
 * @param {Array} [options.seo.robots.allow] - Paths to explicitly allow
 * @param {number} [options.seo.robots.crawlDelay] - Crawl delay in seconds
 * @param {Object} [options.assets] - Asset processing configuration
 * @param {boolean} [options.assets.process=true] - Process assets in production builds
 * @param {boolean} [options.assets.convertToWebp=true] - Convert images to WebP
 * @param {number} [options.assets.quality=80] - WebP quality (1-100)
 * @param {string} [options.assets.outputDir='assets'] - Output subdirectory for processed assets
 * @param {boolean} [options.assets.videoPosters=true] - Extract poster frames from videos (requires ffmpeg)
 * @param {boolean} [options.assets.pdfThumbnails=true] - Generate thumbnails for PDFs (requires pdf-lib)
 * @param {Object} [options.search] - Search index configuration
 * @param {boolean} [options.search.enabled=true] - Generate search index (uses site.yml config by default)
 * @param {string} [options.search.filename='search-index.json'] - Search index filename
 * @param {string} [options.foundationPath] - Path to foundation directory (for loading theme vars)
 */
export function siteContentPlugin(options = {}) {
  const {
    sitePath = './',
    pagesDir = 'pages',
    variableName = '__SITE_CONTENT__',
    inject = true,
    filename = 'site-content.json',
    watch: shouldWatch = true,
    seo = {},
    assets: assetsConfig = {},
    search: searchPluginConfig = {},
    foundationPath
  } = options

  // Extract asset processing options
  const assetsOptions = {
    process: assetsConfig.process !== false, // Default true
    convertToWebp: assetsConfig.convertToWebp !== false, // Default true
    quality: assetsConfig.quality || 80,
    outputDir: assetsConfig.outputDir || 'assets',
    videoPosters: assetsConfig.videoPosters !== false, // Default true
    pdfThumbnails: assetsConfig.pdfThumbnails !== false // Default true
  }

  // Extract SEO options with defaults
  const seoEnabled = !!seo.baseUrl
  const seoOptions = {
    baseUrl: seo.baseUrl?.replace(/\/$/, '') || '', // Remove trailing slash
    defaultImage: seo.defaultImage || null,
    twitterHandle: seo.twitterHandle || null,
    locales: seo.locales || [],
    robots: seo.robots || {}
  }

  let siteContent = null
  let resolvedSitePath = null
  let resolvedOutDir = null
  let isProduction = false
  let watcher = null
  let server = null
  let localeTranslations = {} // Cache: { locale: translations }
  let collectionTranslations = {} // Cache: { locale: collection translations }
  let localesDir = 'locales' // Default, updated from site config
  let collectionsConfig = null // Cached for watcher setup
  let resolvedPagesPath = null // Resolved from site.yml pagesDir or default
  let resolvedLayoutPath = null // Resolved from site.yml layoutDir or default
  let resolvedCollectionsBase = null // Resolved from site.yml collectionsDir
  let headHtml = '' // Contents of site/head.html for injection

  /**
   * Load translations for a specific locale
   */
  async function loadLocaleTranslations(locale) {
    if (localeTranslations[locale]) {
      return localeTranslations[locale]
    }

    const localePath = join(resolvedSitePath, localesDir, `${locale}.json`)
    if (!existsSync(localePath)) {
      return null
    }

    try {
      const content = await readFile(localePath, 'utf-8')
      const translations = JSON.parse(content)
      localeTranslations[locale] = translations
      return translations
    } catch {
      return null
    }
  }

  /**
   * Load collection translations for a specific locale
   */
  async function loadCollectionTranslations(locale) {
    if (collectionTranslations[locale]) {
      return collectionTranslations[locale]
    }

    const localePath = join(resolvedSitePath, localesDir, 'collections', `${locale}.json`)
    if (!existsSync(localePath)) {
      return null
    }

    try {
      const content = await readFile(localePath, 'utf-8')
      const translations = JSON.parse(content)
      collectionTranslations[locale] = translations
      return translations
    } catch {
      return null
    }
  }

  /**
   * Read head.html from site root (if it exists)
   */
  async function loadHeadHtml() {
    const headPath = resolve(resolvedSitePath, 'head.html')
    try {
      return await readFile(headPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Get available locales from locales directory
   */
  async function getAvailableLocales() {
    const localesPath = join(resolvedSitePath, localesDir)
    if (!existsSync(localesPath)) {
      return []
    }

    try {
      const files = await readdir(localesPath)
      return files
        .filter(f => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('_'))
        .map(f => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  /**
   * Get translated content for a locale
   *
   * Supports both hash-based (granular) and free-form (complete replacement) translations.
   * Free-form translations are checked first, falling back to hash-based when not found.
   */
  async function getTranslatedContent(locale) {
    if (!siteContent) return null

    const translations = await loadLocaleTranslations(locale)
    // Even with no hash-based translations, free-form might exist
    const hasTranslations = translations !== null

    // Check if free-form translations exist for this locale
    const freeformDir = join(resolvedSitePath, localesDir, 'freeform', locale)
    const hasFreeform = existsSync(freeformDir)

    // If no translations at all (neither hash-based nor free-form), return null
    if (!hasTranslations && !hasFreeform) return null

    // Use free-form enabled merge
    return mergeTranslations(siteContent, translations || {}, {
      locale,
      localesDir: join(resolvedSitePath, localesDir),
      freeformEnabled: hasFreeform
    })
  }

  return {
    name: 'uniweb:site-content',

    async configResolved(config) {
      resolvedSitePath = resolve(config.root, sitePath)
      resolvedOutDir = resolve(config.root, config.build.outDir)
      isProduction = config.command === 'build'

      // In dev mode, process collections early so JSON files exist before server starts
      // This runs before configureServer, ensuring data is available immediately
      if (!isProduction) {
        try {
          // Do an early content collection to get the collections config
          const earlyContent = await collectSiteContent(resolvedSitePath, { foundationPath })
          collectionsConfig = earlyContent.config?.collections

          // Resolve content directory paths from site.yml paths: group
          const paths = earlyContent?.config?.paths || {}
          resolvedPagesPath = paths.pages
            ? resolve(resolvedSitePath, paths.pages)
            : resolve(resolvedSitePath, pagesDir)
          resolvedLayoutPath = paths.layout
            ? resolve(resolvedSitePath, paths.layout)
            : resolve(resolvedSitePath, 'layout')
          resolvedCollectionsBase = paths.collections
            ? resolve(resolvedSitePath, paths.collections)
            : null

          if (collectionsConfig) {
            console.log('[site-content] Processing content collections...')
            const collections = await processCollections(resolvedSitePath, collectionsConfig, resolvedCollectionsBase)
            await writeCollectionFiles(resolvedSitePath, collections)
          }
        } catch (err) {
          console.warn('[site-content] Early collection processing failed:', err.message)
        }
      }

      // In production, resolve content paths from site.yml directly
      if (isProduction || !resolvedPagesPath) {
        const { readSiteConfig } = await import('./config.js')
        const cfg = readSiteConfig(resolvedSitePath)
        const paths = cfg.paths || {}
        resolvedPagesPath = paths.pages
          ? resolve(resolvedSitePath, paths.pages)
          : resolve(resolvedSitePath, pagesDir)
        resolvedLayoutPath = paths.layout
          ? resolve(resolvedSitePath, paths.layout)
          : resolve(resolvedSitePath, 'layout')
        resolvedCollectionsBase = paths.collections
          ? resolve(resolvedSitePath, paths.collections)
          : null
      }
    },

    async buildStart() {
      // Collect content at build start
      try {
        siteContent = await collectSiteContent(resolvedSitePath, { foundationPath })
        headHtml = await loadHeadHtml()
        console.log(`[site-content] Collected ${siteContent.pages?.length || 0} pages`)

        // Process content collections if defined in site.yml
        // In dev mode, this was already done in configResolved (before server starts)
        // In production, do it here
        if (isProduction && siteContent.config?.collections) {
          console.log('[site-content] Processing content collections...')
          const collections = await processCollections(resolvedSitePath, siteContent.config.collections, resolvedCollectionsBase)
          await writeCollectionFiles(resolvedSitePath, collections)
        }

        // Execute data fetches in dev mode
        // In production, prerender handles this
        if (!isProduction) {
          await executeDevFetches(siteContent, resolvedSitePath)
        }

        // Update localesDir from site config
        if (siteContent.config?.i18n?.localesDir) {
          localesDir = siteContent.config.i18n.localesDir
        }

        // Clear translation cache on rebuild
        localeTranslations = {}
        collectionTranslations = {}
      } catch (err) {
        console.error('[site-content] Failed to collect content:', err.message)
        siteContent = { config: {}, theme: {}, pages: [] }
      }
    },

    configureServer(devServer) {
      server = devServer

      // Watch for content changes in dev mode
      if (shouldWatch) {
        const siteYmlPath = resolve(resolvedSitePath, 'site.yml')
        const themeYmlPath = resolve(resolvedSitePath, 'theme.yml')

        // Debounce rebuilds
        let rebuildTimeout = null
        const scheduleRebuild = () => {
          if (rebuildTimeout) clearTimeout(rebuildTimeout)
          rebuildTimeout = setTimeout(async () => {
            console.log('[site-content] Content changed, rebuilding...')
            try {
              siteContent = await collectSiteContent(resolvedSitePath, { foundationPath })
              headHtml = await loadHeadHtml()
              // Execute fetches for the updated content
              await executeDevFetches(siteContent, resolvedSitePath)
              console.log(`[site-content] Rebuilt ${siteContent.pages?.length || 0} pages`)

              // Send full reload to client
              server.ws.send({ type: 'full-reload' })
            } catch (err) {
              console.error('[site-content] Rebuild failed:', err.message)
            }
          }, 100)
        }

        // Debounce collection rebuilds separately (writes to file system)
        let collectionRebuildTimeout = null
        const scheduleCollectionRebuild = () => {
          if (collectionRebuildTimeout) clearTimeout(collectionRebuildTimeout)
          collectionRebuildTimeout = setTimeout(async () => {
            console.log('[site-content] Collection content changed, regenerating JSON...')
            try {
              // Use collectionsConfig (cached from configResolved) or siteContent
              const collections = collectionsConfig || siteContent?.config?.collections
              if (collections) {
                const processed = await processCollections(resolvedSitePath, collections, resolvedCollectionsBase)
                await writeCollectionFiles(resolvedSitePath, processed)
              }
              // Send full reload to client
              server.ws.send({ type: 'full-reload' })
            } catch (err) {
              console.error('[site-content] Collection rebuild failed:', err.message)
            }
          }, 100)
        }

        // Track all watchers for cleanup
        const watchers = []

        // Watch pages directory (resolved from site.yml pagesDir or default)
        if (existsSync(resolvedPagesPath)) {
          try {
            watchers.push(watch(resolvedPagesPath, { recursive: true }, scheduleRebuild))
            console.log(`[site-content] Watching ${resolvedPagesPath}`)
          } catch (err) {
            console.warn('[site-content] Could not watch pages directory:', err.message)
          }
        }

        // Watch layout directory (resolved from site.yml layoutDir or default)
        if (existsSync(resolvedLayoutPath)) {
          try {
            watchers.push(watch(resolvedLayoutPath, { recursive: true }, scheduleRebuild))
            console.log(`[site-content] Watching ${resolvedLayoutPath}`)
          } catch (err) {
            console.warn('[site-content] Could not watch layout directory:', err.message)
          }
        }

        // Watch site.yml
        try {
          watchers.push(watch(siteYmlPath, scheduleRebuild))
        } catch (err) {
          // site.yml may not exist, that's ok
        }

        // Watch theme.yml
        try {
          watchers.push(watch(themeYmlPath, scheduleRebuild))
        } catch (err) {
          // theme.yml may not exist, that's ok
        }

        // Watch head.html
        const headHtmlPath = resolve(resolvedSitePath, 'head.html')
        try {
          watchers.push(watch(headHtmlPath, scheduleRebuild))
        } catch {
          // head.html may not exist, that's ok
        }

        // Watch content/ folder for collection changes
        // Use collectionsConfig cached from configResolved (siteContent may be null here)
        if (collectionsConfig) {
          const contentPaths = new Set()
          const collectionBase = resolvedCollectionsBase || resolvedSitePath
          for (const config of Object.values(collectionsConfig)) {
            const collectionPath = typeof config === 'string' ? config : config.path
            if (collectionPath) {
              contentPaths.add(resolve(collectionBase, collectionPath))
            }
          }

          for (const contentPath of contentPaths) {
            if (existsSync(contentPath)) {
              try {
                watchers.push(watch(contentPath, { recursive: true }, scheduleCollectionRebuild))
                console.log(`[site-content] Watching ${contentPath} for collection changes`)
              } catch (err) {
                console.warn('[site-content] Could not watch content directory:', err.message)
              }
            }
          }
        }

        // Store watchers for cleanup
        watcher = { close: () => watchers.forEach(w => w.close()) }
      }

      // Watch locales directory for translation changes
      const localesPath = resolve(resolvedSitePath, localesDir)
      const additionalWatchers = []

      if (existsSync(localesPath)) {
        try {
          const localeWatcher = watch(localesPath, { recursive: false }, () => {
            console.log('[site-content] Translation files changed, clearing cache...')
            localeTranslations = {}
            collectionTranslations = {}
            server.ws.send({ type: 'full-reload' })
          })
          additionalWatchers.push(localeWatcher)
          console.log(`[site-content] Watching ${localesPath} for translation changes`)
        } catch (err) {
          // locales dir may not exist, that's ok
        }

        // Watch free-form translations directory
        const freeformPath = resolve(localesPath, 'freeform')
        if (existsSync(freeformPath)) {
          try {
            const freeformWatcher = watch(freeformPath, { recursive: true }, () => {
              console.log('[site-content] Free-form translation changed, reloading...')
              server.ws.send({ type: 'full-reload' })
            })
            additionalWatchers.push(freeformWatcher)
            console.log(`[site-content] Watching ${freeformPath} for free-form translation changes`)
          } catch (err) {
            // freeform dir may not exist, that's ok
          }
        }

        // Watch collection translations directory
        const collectionsLocalesPath = resolve(localesPath, 'collections')
        if (existsSync(collectionsLocalesPath)) {
          try {
            const collWatcher = watch(collectionsLocalesPath, { recursive: false }, () => {
              console.log('[site-content] Collection translations changed, clearing cache...')
              collectionTranslations = {}
              server.ws.send({ type: 'full-reload' })
            })
            additionalWatchers.push(collWatcher)
            console.log(`[site-content] Watching ${collectionsLocalesPath} for collection translation changes`)
          } catch (err) {
            // collections locales dir may not exist, that's ok
          }
        }
      }

      // Add additional watchers to cleanup
      if (additionalWatchers.length > 0 && watcher) {
        const originalClose = watcher.close
        watcher.close = () => {
          originalClose()
          additionalWatchers.forEach(w => w.close())
        }
      }

      // Serve content and SEO files
      devServer.middlewares.use(async (req, res, next) => {
        // Handle default locale site-content request
        if (req.url === `/${filename}`) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(siteContent, null, 2))
          return
        }

        // Handle locale-prefixed site-content request (e.g., /es/site-content.json)
        const localeContentMatch = req.url.match(/^\/([a-z]{2})\/site-content\.json$/)
        if (localeContentMatch) {
          const locale = localeContentMatch[1]
          const translatedContent = await getTranslatedContent(locale)

          if (translatedContent) {
            // Add activeLocale to the content so runtime knows which locale is active
            const contentWithLocale = {
              ...translatedContent,
              config: {
                ...translatedContent.config,
                activeLocale: locale
              }
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(contentWithLocale, null, 2))
            return
          }
          // If no translations, fall through to serve default content
        }

        // Serve sitemap.xml in dev mode
        if (req.url === '/sitemap.xml' && seoEnabled && siteContent?.pages) {
          res.setHeader('Content-Type', 'application/xml')
          res.end(generateSitemap(siteContent.pages, seoOptions.baseUrl, seoOptions.locales, siteContent.config?.i18n?.routeTranslations))
          return
        }

        // Serve robots.txt in dev mode
        if (req.url === '/robots.txt' && seoEnabled) {
          res.setHeader('Content-Type', 'text/plain')
          res.end(generateRobotsTxt(seoOptions.baseUrl, seoOptions.robots))
          return
        }

        // Serve search-index.json in dev mode (supports locale prefixes)
        const searchIndexMatch = req.url.match(/^(?:\/([a-z]{2}))?\/search-index\.json$/)
        if (searchIndexMatch && siteContent) {
          const searchEnabled = searchPluginConfig.enabled !== false && isSearchEnabled(siteContent)
          if (searchEnabled) {
            const searchConfig = siteContent.config?.search || {}
            const defaultLocale = siteContent.config?.defaultLanguage || 'en'
            // Use requested locale from URL, fall back to active or default
            const requestedLocale = searchIndexMatch[1]
            const activeLocale = requestedLocale || siteContent.config?.activeLocale || defaultLocale

            const searchIndex = generateSearchIndex(siteContent, {
              locale: activeLocale,
              search: searchConfig
            })

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(searchIndex, null, 2))
            return
          }
        }

        // Handle localized collection data (e.g., /fr/data/articles.json)
        const localeDataMatch = req.url.match(/^\/([a-z]{2})\/data\/(.+\.json)$/)
        if (localeDataMatch) {
          const locale = localeDataMatch[1]
          const filename = localeDataMatch[2]
          const collectionName = filename.replace('.json', '')
          const sourcePath = join(resolvedSitePath, 'public', 'data', filename)

          if (existsSync(sourcePath)) {
            try {
              const raw = await readFile(sourcePath, 'utf-8')
              const items = JSON.parse(raw)

              // Load collection translations for this locale
              const translations = await loadCollectionTranslations(locale) || {}

              // Check for free-form translations
              const freeformDir = join(resolvedSitePath, localesDir, 'freeform', locale)
              const hasFreeform = existsSync(freeformDir)

              // Translate using the collections module
              const { translateCollectionData } = await import('../i18n/collections.js')
              const translated = await translateCollectionData(items, collectionName, resolvedSitePath, {
                locale,
                localesDir: join(resolvedSitePath, localesDir),
                translations,
                freeformEnabled: hasFreeform
              })

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(translated, null, 2))
              return
            } catch (err) {
              console.warn(`[site-content] Failed to serve localized collection ${filename}: ${err.message}`)
              // Fall through to Vite's static server
            }
          }
        }

        next()
      })
    },

    async transformIndexHtml(html, ctx) {
      if (!siteContent) return html

      // Detect locale from URL (e.g., /es/about → 'es')
      let contentToInject = siteContent
      let activeLocale = null

      if (ctx?.originalUrl) {
        const localeMatch = ctx.originalUrl.match(/^\/([a-z]{2})(\/|$)/)
        if (localeMatch) {
          activeLocale = localeMatch[1]
          const translatedContent = await getTranslatedContent(activeLocale)
          if (translatedContent) {
            contentToInject = {
              ...translatedContent,
              config: {
                ...translatedContent.config,
                activeLocale
              }
            }
          }
        }
      }

      let headInjection = ''

      // Inject user's head.html (analytics, third-party scripts)
      if (headHtml) {
        headInjection += headHtml + '\n'
      }

      // Inject theme CSS
      if (contentToInject.theme?.css) {
        headInjection += `    <style id="uniweb-theme">\n${contentToInject.theme.css}\n    </style>\n`
      }

      // Inject SEO meta tags
      if (seoEnabled) {
        const metaTags = generateMetaTags(contentToInject, seoOptions)
        if (metaTags) {
          headInjection += `    ${metaTags}\n`
        }
      }

      // Inject content as JSON script tag
      if (inject) {
        headInjection += `    <script type="application/json" id="${variableName}">${JSON.stringify(contentToInject)}</script>\n`
      }

      if (!headInjection) return html

      // Insert before </head>
      return html.replace('</head>', headInjection + '  </head>')
    },

    async generateBundle() {
      let finalContent = siteContent

      // Process assets in production builds
      if (isProduction && assetsOptions.process && siteContent?.assets) {
        const assetCount = Object.keys(siteContent.assets).length

        if (assetCount > 0) {
          console.log(`[site-content] Processing ${assetCount} assets...`)

          // Process standard assets (images)
          const { pathMapping, results } = await processAssets(siteContent.assets, {
            outputDir: resolvedOutDir,
            assetsSubdir: assetsOptions.outputDir,
            convertToWebp: assetsOptions.convertToWebp,
            quality: assetsOptions.quality
          })

          // Process advanced assets (videos, PDFs)
          const advancedEnabled = assetsOptions.videoPosters || assetsOptions.pdfThumbnails
          let advancedResults = null

          if (advancedEnabled) {
            const { posterMapping, thumbnailMapping, results: advResults } = await processAdvancedAssets(
              siteContent.assets,
              {
                outputDir: resolvedOutDir,
                assetsSubdir: assetsOptions.outputDir,
                videoPosters: assetsOptions.videoPosters,
                pdfThumbnails: assetsOptions.pdfThumbnails,
                quality: assetsOptions.quality,
                // Pass explicit poster/preview sets to skip auto-generation
                hasExplicitPoster: siteContent.hasExplicitPoster || new Set(),
                hasExplicitPreview: siteContent.hasExplicitPreview || new Set()
              }
            )
            advancedResults = advResults

            // Log advanced processing results
            if (advResults.videos.processed > 0) {
              console.log(`[site-content] Extracted ${advResults.videos.processed} video posters`)
            }
            if (advResults.videos.explicit > 0) {
              console.log(`[site-content] Skipped ${advResults.videos.explicit} videos with explicit posters`)
            }
            if (advResults.pdfs.processed > 0) {
              console.log(`[site-content] Generated ${advResults.pdfs.processed} PDF thumbnails`)
            }
            if (advResults.pdfs.explicit > 0) {
              console.log(`[site-content] Skipped ${advResults.pdfs.explicit} PDFs with explicit previews`)
            }

            // Merge poster and thumbnail mappings into the path mapping
            // Videos: add a .poster property to the content (not replace the src)
            // PDFs: add a .thumbnail property to the content
            finalContent = rewriteSiteContentPaths(siteContent, pathMapping)

            // Add poster and thumbnail metadata to the site content
            if (Object.keys(posterMapping).length > 0 || Object.keys(thumbnailMapping).length > 0) {
              finalContent._assetMeta = {
                posters: posterMapping,
                thumbnails: thumbnailMapping
              }
            }
          } else {
            // Rewrite paths in content
            finalContent = rewriteSiteContentPaths(siteContent, pathMapping)
          }

          // Log results
          const sizeKB = (results.totalSize / 1024).toFixed(1)
          console.log(`[site-content] Processed ${results.processed} assets (${results.converted} converted to WebP, ${sizeKB}KB total)`)

          if (results.failed > 0) {
            console.warn(`[site-content] ${results.failed} assets failed to process`)
          }
        }
      } else {
        // In dev or when processing is disabled, just remove the assets manifest
        finalContent = { ...siteContent }
        delete finalContent.assets
      }

      // Clean up internal properties that shouldn't be in the output (Sets don't serialize)
      delete finalContent.hasExplicitPoster
      delete finalContent.hasExplicitPreview

      // Note: theme.css is kept here so prerender can inject it into HTML
      // Prerender will strip it from the JSON it injects into each page

      // Emit content as JSON file in production build
      this.emitFile({
        type: 'asset',
        fileName: filename,
        source: JSON.stringify(finalContent, null, 2)
      })

      // Generate SEO files if enabled
      if (seoEnabled && finalContent?.pages) {
        // Generate sitemap.xml
        const sitemap = generateSitemap(finalContent.pages, seoOptions.baseUrl, seoOptions.locales, finalContent.config?.i18n?.routeTranslations)
        this.emitFile({
          type: 'asset',
          fileName: 'sitemap.xml',
          source: sitemap
        })
        console.log('[site-content] Generated sitemap.xml')

        // Generate robots.txt
        const robotsTxt = generateRobotsTxt(seoOptions.baseUrl, seoOptions.robots)
        this.emitFile({
          type: 'asset',
          fileName: 'robots.txt',
          source: robotsTxt
        })
        console.log('[site-content] Generated robots.txt')
      }

      // Generate search index if enabled
      const searchEnabled = searchPluginConfig.enabled !== false && isSearchEnabled(finalContent)
      if (searchEnabled) {
        const searchConfig = finalContent.config?.search || {}
        const defaultLocale = finalContent.config?.defaultLanguage || 'en'
        const activeLocale = finalContent.config?.activeLocale || defaultLocale

        // Generate search index for current locale
        const searchIndex = generateSearchIndex(finalContent, {
          locale: activeLocale,
          search: searchConfig
        })

        const searchFilename = getSearchIndexFilename(activeLocale, defaultLocale)
        this.emitFile({
          type: 'asset',
          fileName: searchFilename,
          source: JSON.stringify(searchIndex, null, 2)
        })

        console.log(`[site-content] Generated ${searchFilename} (${searchIndex.count} entries)`)
      }
    },

    closeBundle() {
      // Clean up watcher
      if (watcher) {
        watcher.close()
        watcher = null
      }
    }
  }
}

export default siteContentPlugin
