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
 */
export function siteContentPlugin(options = {}) {
  const {
    sitePath = './',
    pagesDir = 'pages',
    variableName = '__SITE_CONTENT__',
    inject = true,
    filename = 'site-content.json',
    watch: shouldWatch = true,
    seo = {}
  } = options

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
  let watcher = null
  let server = null

  return {
    name: 'uniweb:site-content',

    configResolved(config) {
      resolvedSitePath = resolve(config.root, sitePath)
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
        const watchPath = resolve(resolvedSitePath, pagesDir)

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

        try {
          watcher = watch(watchPath, { recursive: true }, scheduleRebuild)
          console.log(`[site-content] Watching ${watchPath}`)
        } catch (err) {
          console.warn('[site-content] Could not watch pages directory:', err.message)
        }
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

    generateBundle() {
      // Emit content as JSON file in production build
      this.emitFile({
        type: 'asset',
        fileName: filename,
        source: JSON.stringify(siteContent, null, 2)
      })

      // Generate SEO files if enabled
      if (seoEnabled && siteContent?.pages) {
        // Generate sitemap.xml
        const sitemap = generateSitemap(siteContent.pages, seoOptions.baseUrl, seoOptions.locales)
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
