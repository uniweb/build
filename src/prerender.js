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
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { executeFetch, mergeDataIntoContent } from './site/data-fetcher.js'

// Lazily loaded dependencies
let React, renderToString, createUniweb, PageElement

/**
 * Execute all data fetches for prerender
 * Processes site, page, and section level fetches, merging data appropriately
 *
 * @param {Object} siteContent - The site content from site-content.json
 * @param {string} siteDir - Path to the site directory
 * @param {function} onProgress - Progress callback
 */
async function executeAllFetches(siteContent, siteDir, onProgress) {
  const fetchOptions = { siteRoot: siteDir, publicDir: 'public' }

  // 1. Site-level fetch (cascades to all pages)
  let siteCascadedData = {}
  const siteFetch = siteContent.config?.fetch
  if (siteFetch && siteFetch.prerender !== false) {
    onProgress(`  Fetching site data: ${siteFetch.path || siteFetch.url}`)
    const result = await executeFetch(siteFetch, fetchOptions)
    if (result.data && !result.error) {
      siteCascadedData[siteFetch.schema] = result.data
    }
  }

  // 2. Process each page
  for (const page of siteContent.pages || []) {
    // Page-level fetch (cascades to sections in this page)
    let pageCascadedData = { ...siteCascadedData }
    const pageFetch = page.fetch
    if (pageFetch && pageFetch.prerender !== false) {
      onProgress(`  Fetching page data for ${page.route}: ${pageFetch.path || pageFetch.url}`)
      const result = await executeFetch(pageFetch, fetchOptions)
      if (result.data && !result.error) {
        pageCascadedData[pageFetch.schema] = result.data
      }
    }

    // Process sections recursively (handles subsections too)
    await processSectionFetches(page.sections, pageCascadedData, fetchOptions, onProgress)
  }
}

/**
 * Process fetch configs for sections (and subsections recursively)
 *
 * @param {Array} sections - Array of section objects
 * @param {Object} cascadedData - Data cascaded from site/page level
 * @param {Object} fetchOptions - Options for executeFetch
 * @param {function} onProgress - Progress callback
 */
async function processSectionFetches(sections, cascadedData, fetchOptions, onProgress) {
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

    // Attach cascaded data for components with inheritData
    section.cascadedData = cascadedData

    // Process subsections recursively
    if (section.subsections && section.subsections.length > 0) {
      await processSectionFetches(section.subsections, cascadedData, fetchOptions, onProgress)
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

  // Create a require function that resolves from the site's perspective
  // This ensures we get the same React instance that the foundation uses
  const absoluteSiteDir = resolve(siteDir)
  const siteRequire = createRequire(join(absoluteSiteDir, 'package.json'))

  try {
    // Try to load React from site's node_modules
    const reactMod = siteRequire('react')
    const serverMod = siteRequire('react-dom/server')

    React = reactMod.default || reactMod
    renderToString = serverMod.renderToString
  } catch {
    // Fallback to dynamic import if require fails
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

  // Load @uniweb/runtime/ssr for rendering components
  const ssrMod = await import('@uniweb/runtime/ssr')
  PageElement = ssrMod.PageElement
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

  // Load site content
  onProgress('Loading site content...')
  const contentPath = join(distDir, 'site-content.json')
  if (!existsSync(contentPath)) {
    throw new Error(`site-content.json not found at: ${contentPath}`)
  }
  const siteContent = JSON.parse(await readFile(contentPath, 'utf8'))

  // Execute data fetches (site, page, section levels)
  onProgress('Executing data fetches...')
  await executeAllFetches(siteContent, siteDir, onProgress)

  // Load the HTML shell
  onProgress('Loading HTML shell...')
  const shellPath = join(distDir, 'index.html')
  if (!existsSync(shellPath)) {
    throw new Error(`index.html not found at: ${shellPath}`)
  }
  const htmlShell = await readFile(shellPath, 'utf8')

  // Load the foundation module
  onProgress('Loading foundation...')
  const foundationPath = join(foundationDir, 'dist', 'foundation.js')
  if (!existsSync(foundationPath)) {
    throw new Error(`Foundation not found at: ${foundationPath}. Build foundation first.`)
  }
  const foundationUrl = pathToFileURL(foundationPath).href
  const foundation = await import(foundationUrl)

  // Initialize the Uniweb runtime (this sets globalThis.uniweb)
  onProgress('Initializing runtime...')
  const uniweb = createUniweb(siteContent)
  uniweb.setFoundation(foundation)

  // Set foundation capabilities (Layout, props, etc.)
  if (foundation.capabilities) {
    uniweb.setFoundationConfig(foundation.capabilities)
  }

  // Pre-render each page
  const renderedFiles = []
  const pages = uniweb.activeWebsite.pages
  const website = uniweb.activeWebsite

  for (const page of pages) {
    // Determine which routes to render this page at
    // Index pages are rendered at both their actual route and their nav route
    const routesToRender = [page.route]
    if (page.isIndex) {
      const navRoute = page.getNavRoute()
      if (navRoute !== page.route) {
        routesToRender.push(navRoute)
      }
    }

    // Render once, output to multiple paths
    onProgress(`Rendering ${routesToRender[0]}...`)

    // Set this as the active page
    uniweb.activeWebsite.setActivePage(page.route)

    // Create the page element using the runtime's SSR components
    const element = React.createElement(PageElement, { page, website })

    // Render to HTML string
    let renderedContent
    try {
      renderedContent = renderToString(element)
    } catch (err) {
      console.warn(`Warning: Failed to render ${page.route}: ${err.message}`)
      if (process.env.DEBUG) {
        console.error(err.stack)
      }
      continue
    }

    // Inject into shell
    const html = injectContent(htmlShell, renderedContent, page, siteContent)

    // Output to all routes for this page
    for (const route of routesToRender) {
      const outputPath = getOutputPath(distDir, route)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, html)

      renderedFiles.push(outputPath)
      onProgress(`  → ${outputPath.replace(distDir, 'dist')}`)
    }
  }

  onProgress(`Pre-rendered ${renderedFiles.length} pages`)

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
  const contentScript = `<script id="__SITE_CONTENT__" type="application/json">${JSON.stringify(siteContent)}</script>`
  if (!html.includes('__SITE_CONTENT__')) {
    html = html.replace(
      '</head>',
      `  ${contentScript}\n  </head>`
    )
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
