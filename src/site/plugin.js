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

import { resolve } from 'node:path'
import { watch } from 'node:fs'
import { collectSiteContent } from './content-collector.js'
import { processAssets, rewriteSiteContentPaths } from './asset-processor.js'
import { processAdvancedAssets } from './advanced-processors.js'
import { generateSearchIndex, isSearchEnabled, getSearchIndexFilename } from '../search/index.js'

/**
 * Generate sitemap.xml content
 */
function generateSitemap(pages, baseUrl, locales = []) {
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
        const localeLoc = locale.default ? loc : `${baseUrl}/${locale.code}${page.route === '/' ? '' : page.route}`
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
    search: searchPluginConfig = {}
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

  return {
    name: 'uniweb:site-content',

    configResolved(config) {
      resolvedSitePath = resolve(config.root, sitePath)
      resolvedOutDir = resolve(config.root, config.build.outDir)
      isProduction = config.command === 'build'
    },

    async buildStart() {
      // Collect content at build start
      try {
        siteContent = await collectSiteContent(resolvedSitePath)
        console.log(`[site-content] Collected ${siteContent.pages?.length || 0} pages`)
      } catch (err) {
        console.error('[site-content] Failed to collect content:', err.message)
        siteContent = { config: {}, theme: {}, pages: [] }
      }
    },

    configureServer(devServer) {
      server = devServer

      // Watch for content changes in dev mode
      if (shouldWatch) {
        const pagesPath = resolve(resolvedSitePath, pagesDir)
        const siteYmlPath = resolve(resolvedSitePath, 'site.yml')
        const themeYmlPath = resolve(resolvedSitePath, 'theme.yml')

        // Debounce rebuilds
        let rebuildTimeout = null
        const scheduleRebuild = () => {
          if (rebuildTimeout) clearTimeout(rebuildTimeout)
          rebuildTimeout = setTimeout(async () => {
            console.log('[site-content] Content changed, rebuilding...')
            try {
              siteContent = await collectSiteContent(resolvedSitePath)
              console.log(`[site-content] Rebuilt ${siteContent.pages?.length || 0} pages`)

              // Send full reload to client
              server.ws.send({ type: 'full-reload' })
            } catch (err) {
              console.error('[site-content] Rebuild failed:', err.message)
            }
          }, 100)
        }

        // Track all watchers for cleanup
        const watchers = []

        // Watch pages directory
        try {
          watchers.push(watch(pagesPath, { recursive: true }, scheduleRebuild))
          console.log(`[site-content] Watching ${pagesPath}`)
        } catch (err) {
          console.warn('[site-content] Could not watch pages directory:', err.message)
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

        // Store watchers for cleanup
        watcher = { close: () => watchers.forEach(w => w.close()) }
      }

      // Serve content and SEO files
      devServer.middlewares.use((req, res, next) => {
        if (req.url === `/${filename}`) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(siteContent, null, 2))
          return
        }

        // Serve sitemap.xml in dev mode
        if (req.url === '/sitemap.xml' && seoEnabled && siteContent?.pages) {
          res.setHeader('Content-Type', 'application/xml')
          res.end(generateSitemap(siteContent.pages, seoOptions.baseUrl, seoOptions.locales))
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

        next()
      })
    },

    transformIndexHtml(html) {
      if (!siteContent) return html

      let headInjection = ''

      // Inject SEO meta tags
      if (seoEnabled) {
        const metaTags = generateMetaTags(siteContent, seoOptions)
        if (metaTags) {
          headInjection += `    ${metaTags}\n`
        }
      }

      // Inject content as JSON script tag
      if (inject) {
        headInjection += `    <script type="application/json" id="${variableName}">${JSON.stringify(siteContent)}</script>\n`
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

      // Emit content as JSON file in production build
      this.emitFile({
        type: 'asset',
        fileName: filename,
        source: JSON.stringify(finalContent, null, 2)
      })

      // Generate SEO files if enabled
      if (seoEnabled && finalContent?.pages) {
        // Generate sitemap.xml
        const sitemap = generateSitemap(finalContent.pages, seoOptions.baseUrl, seoOptions.locales)
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
