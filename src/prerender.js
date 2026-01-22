/**
 * SSG Prerendering for Uniweb Sites
 *
 * Renders each page to static HTML at build time.
 * The output includes full HTML with hydration support.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// Lazily loaded dependencies (ESM with React)
let React, renderToString, createUniweb

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
  // Note: createRequire requires an absolute path
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

  // @uniweb/core can be imported normally
  const coreMod = await import('@uniweb/core')
  createUniweb = coreMod.createUniweb
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

  // Set foundation config if provided
  if (foundation.runtime) {
    uniweb.setFoundationConfig(foundation.runtime)
  }

  // Pre-render each page
  const renderedFiles = []
  const pages = uniweb.activeWebsite.pages

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

    // Create the page element
    // Note: We don't need StaticRouter for SSG since we're just rendering
    // components to strings. The routing context isn't needed for static HTML.
    const element = React.createElement(PageRenderer, { page, foundation })

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
 * Render an array of blocks
 */
function BlocksRenderer({ blocks, foundation }) {
  if (!blocks || blocks.length === 0) return null

  return blocks.map((block, index) =>
    React.createElement(BlockRenderer, {
      key: block.id || index,
      block,
      foundation
    })
  )
}

/**
 * Default layout - renders header, body, footer in sequence
 */
function DefaultLayout({ header, body, footer }) {
  return React.createElement(React.Fragment, null, header, body, footer)
}

/**
 * Layout component for SSG
 * Supports foundation-provided custom Layout via runtime.Layout
 */
function Layout({ page, website, foundation }) {
  const RemoteLayout = foundation.runtime?.Layout || null

  // Get block groups from page
  const headerBlocks = page.getHeaderBlocks()
  const bodyBlocks = page.getBodyBlocks()
  const footerBlocks = page.getFooterBlocks()
  const leftBlocks = page.getLeftBlocks()
  const rightBlocks = page.getRightBlocks()

  // Pre-render each area
  const headerElement = headerBlocks
    ? React.createElement(BlocksRenderer, { blocks: headerBlocks, foundation })
    : null
  const bodyElement = bodyBlocks
    ? React.createElement(BlocksRenderer, { blocks: bodyBlocks, foundation })
    : null
  const footerElement = footerBlocks
    ? React.createElement(BlocksRenderer, { blocks: footerBlocks, foundation })
    : null
  const leftElement = leftBlocks
    ? React.createElement(BlocksRenderer, { blocks: leftBlocks, foundation })
    : null
  const rightElement = rightBlocks
    ? React.createElement(BlocksRenderer, { blocks: rightBlocks, foundation })
    : null

  // Use foundation's custom Layout if provided
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
  return React.createElement(DefaultLayout, {
    header: headerElement,
    body: bodyElement,
    footer: footerElement
  })
}

/**
 * Page renderer for SSG
 * Uses Layout component for proper orchestration of layout areas
 */
function PageRenderer({ page, foundation }) {
  const website = globalThis.uniweb?.activeWebsite

  return React.createElement(
    'main',
    null,
    React.createElement(Layout, { page, website, foundation })
  )
}

/**
 * Guarantee content structure exists (mirrors runtime/prepare-props.js)
 * Returns a content object with all standard paths guaranteed to exist
 */
function guaranteeContentStructure(parsedContent) {
  const content = parsedContent || {}

  return {
    // Main content section
    main: {
      header: {
        title: content.main?.header?.title || '',
        pretitle: content.main?.header?.pretitle || '',
        subtitle: content.main?.header?.subtitle || '',
      },
      body: {
        paragraphs: content.main?.body?.paragraphs || [],
        links: content.main?.body?.links || [],
        imgs: content.main?.body?.imgs || [],
        lists: content.main?.body?.lists || [],
        icons: content.main?.body?.icons || [],
      },
    },
    // Content items (H3 sections)
    items: content.items || [],
    // Preserve any additional fields from parser
    ...content,
  }
}

/**
 * Apply param defaults from runtime schema
 */
function applyDefaults(params, defaults) {
  if (!defaults || Object.keys(defaults).length === 0) {
    return params || {}
  }

  return {
    ...defaults,
    ...(params || {}),
  }
}

/**
 * Block renderer - maps block to foundation component
 */
function BlockRenderer({ block, foundation }) {
  // Get component from foundation
  const componentName = block.type
  let Component = null

  if (typeof foundation.getComponent === 'function') {
    Component = foundation.getComponent(componentName)
  } else if (foundation[componentName]) {
    Component = foundation[componentName]
  }

  if (!Component) {
    // Return placeholder for unknown components
    return React.createElement(
      'div',
      {
        className: 'block-placeholder',
        'data-component': componentName,
        style: { display: 'none' }
      },
      `Component: ${componentName}`
    )
  }

  // Get runtime schema for defaults (from foundation.runtimeSchema)
  const runtimeSchema = foundation.runtimeSchema || {}
  const schema = runtimeSchema[componentName] || null
  const defaults = schema?.defaults || {}

  // Build content and params with runtime guarantees (same as runtime's BlockRenderer)
  let content, params
  if (block.parsedContent?.raw) {
    // Simple PoC format - content was passed directly
    content = block.parsedContent.raw
    params = block.properties
  } else {
    // Apply param defaults from meta.js
    params = applyDefaults(block.properties, defaults)

    // Guarantee content structure + merge with properties for backward compat
    content = {
      ...guaranteeContentStructure(block.parsedContent),
      ...block.properties,
      _prosemirror: block.parsedContent
    }
  }

  // Build wrapper props
  const theme = block.themeName
  const className = theme || ''
  const wrapperProps = {
    id: `Section${block.id}`,
    className
  }

  // Component props
  const componentProps = {
    content,
    params,
    block,
    page: globalThis.uniweb?.activeWebsite?.activePage,
    website: globalThis.uniweb?.activeWebsite,
    input: block.input
  }

  return React.createElement(
    'div',
    wrapperProps,
    React.createElement(Component, componentProps)
  )
}

/**
 * Inject rendered content into HTML shell
 */
function injectContent(shell, renderedContent, page, siteContent) {
  let html = shell

  // Replace the empty root div with pre-rendered content
  // Handle various formats of root div
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
  // This allows the client-side React to hydrate with the same data
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
  // Normalize route
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
