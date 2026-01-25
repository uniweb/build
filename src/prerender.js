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
import { executeFetch, mergeDataIntoContent, singularize } from './site/data-fetcher.js'

// Lazily loaded dependencies
let React, renderToString, createUniweb
let preparePropsSSR, getComponentMetaSSR, guaranteeContentStructureSSR

/**
 * Execute all data fetches for prerender
 * Processes site, page, and section level fetches, merging data appropriately
 *
 * @param {Object} siteContent - The site content from site-content.json
 * @param {string} siteDir - Path to the site directory
 * @param {function} onProgress - Progress callback
 * @returns {Object} { siteCascadedData, pageFetchedData } - Fetched data for dynamic route expansion
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

  // 2. Process each page and track fetched data by route
  const pageFetchedData = new Map()

  for (const page of siteContent.pages || []) {
    // Page-level fetch (cascades to sections in this page)
    let pageCascadedData = { ...siteCascadedData }
    const pageFetch = page.fetch
    if (pageFetch && pageFetch.prerender !== false) {
      onProgress(`  Fetching page data for ${page.route}: ${pageFetch.path || pageFetch.url}`)
      const result = await executeFetch(pageFetch, fetchOptions)
      if (result.data && !result.error) {
        pageCascadedData[pageFetch.schema] = result.data
        // Store for dynamic route expansion
        pageFetchedData.set(page.route, {
          schema: pageFetch.schema,
          data: result.data,
        })
      }
    }

    // Process sections recursively (handles subsections too)
    await processSectionFetches(page.sections, pageCascadedData, fetchOptions, onProgress)
  }

  return { siteCascadedData, pageFetchedData }
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
      onProgress(`  Warning: Dynamic page ${page.route} has no parentSchema, skipping`)
      continue
    }

    // Find the parent's data
    // The parent route is the route without the :param suffix
    const parentRoute = page.route.replace(/\/:[\w]+$/, '') || '/'
    const parentData = pageFetchedData.get(parentRoute)

    if (!parentData || !Array.isArray(parentData.data)) {
      onProgress(`  Warning: No data found for dynamic page ${page.route} (parent: ${parentRoute})`)
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

      // Also inject into sections' cascadedData for components with inheritData
      injectDynamicData(concretePage.sections, {
        [singularSchema]: item,  // Current item as singular
        [schema]: items,          // All items as plural
      })

      // Use item data for page metadata if available
      if (item.title) concretePage.title = item.title
      if (item.description || item.excerpt) concretePage.description = item.description || item.excerpt

      expandedPages.push(concretePage)
    }
  }

  return expandedPages
}

/**
 * Inject dynamic route data into section cascadedData
 * This ensures components with inheritData receive the current item
 *
 * @param {Array} sections - Sections to update
 * @param {Object} data - Data to inject { article: {...}, articles: [...] }
 */
function injectDynamicData(sections, data) {
  if (!sections || !Array.isArray(sections)) return

  for (const section of sections) {
    section.cascadedData = {
      ...(section.cascadedData || {}),
      ...data,
    }

    // Recurse into subsections
    if (section.subsections && section.subsections.length > 0) {
      injectDynamicData(section.subsections, data)
    }
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

  // Load runtime utilities (prepare-props doesn't use React)
  const runtimeMod = await import('@uniweb/runtime/ssr')
  preparePropsSSR = runtimeMod.prepareProps
  getComponentMetaSSR = runtimeMod.getComponentMeta
  guaranteeContentStructureSSR = runtimeMod.guaranteeContentStructure
}

/**
 * Inline BlockRenderer for SSR
 * Uses React from prerender's scope to avoid module resolution issues
 */
function renderBlock(block) {
  const Component = block.initComponent()

  if (!Component) {
    return React.createElement('div', {
      className: 'block-error',
      style: { padding: '1rem', background: '#fef2f2', color: '#dc2626' }
    }, `Component not found: ${block.type}`)
  }

  // Build content and params with runtime guarantees
  let content, params

  if (block.parsedContent?._isPoc) {
    // Simple PoC format - content was passed directly
    content = block.parsedContent._pocContent
    params = block.properties
  } else {
    // Get runtime metadata for this component
    const meta = getComponentMetaSSR(block.type)

    // Prepare props with runtime guarantees
    const prepared = preparePropsSSR(block, meta)
    params = prepared.params
    content = {
      ...prepared.content,
      ...block.properties,
      _prosemirror: block.parsedContent
    }
  }

  const componentProps = {
    content,
    params,
    block,
    input: block.input
  }

  // Wrapper props
  const theme = block.themeName
  const wrapperProps = {
    id: `Section${block.id}`,
    className: theme || ''
  }

  return React.createElement('div', wrapperProps,
    React.createElement(Component, componentProps)
  )
}

/**
 * Inline Blocks renderer for SSR
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
 * Inline Layout renderer for SSR
 */
function renderLayout(page, website) {
  const RemoteLayout = website.getRemoteLayout()

  const headerBlocks = page.getHeaderBlocks()
  const bodyBlocks = page.getBodyBlocks()
  const footerBlocks = page.getFooterBlocks()
  const leftBlocks = page.getLeftBlocks()
  const rightBlocks = page.getRightBlocks()

  const headerElement = headerBlocks ? renderBlocks(headerBlocks) : null
  const bodyElement = bodyBlocks ? renderBlocks(bodyBlocks) : null
  const footerElement = footerBlocks ? renderBlocks(footerBlocks) : null
  const leftElement = leftBlocks ? renderBlocks(leftBlocks) : null
  const rightElement = rightBlocks ? renderBlocks(rightBlocks) : null

  if (RemoteLayout) {
    return React.createElement(RemoteLayout, {
      page,
      website,
      header: headerElement,
      body: bodyElement,
      footer: footerElement,
      left: leftElement,
      right: rightElement,
      leftPanel: leftElement,
      rightPanel: rightElement
    })
  }

  // Default layout
  return React.createElement(React.Fragment, null,
    headerElement,
    bodyElement,
    footerElement
  )
}

/**
 * Inline PageElement for SSR
 * Uses React from prerender's scope
 */
function createPageElement(page, website) {
  return React.createElement('main', null,
    renderLayout(page, website)
  )
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
  const { siteCascadedData, pageFetchedData } = await executeAllFetches(siteContent, siteDir, onProgress)

  // Expand dynamic pages (e.g., /blog/:slug → /blog/post-1, /blog/post-2)
  if (siteContent.pages?.some(p => p.isDynamic)) {
    onProgress('Expanding dynamic routes...')
    siteContent.pages = expandDynamicPages(siteContent.pages, pageFetchedData, onProgress)
  }

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

    // Create the page element using inline SSR rendering
    // (uses React from prerender's scope to avoid module resolution issues)
    const element = createPageElement(page, website)

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
  const contentScript = `<script id="__SITE_CONTENT__" type="application/json">${JSON.stringify(contentForJson)}</script>`
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
