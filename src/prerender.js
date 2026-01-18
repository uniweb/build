/**
 * SSG Prerendering for Uniweb Sites
 *
 * Renders each page to static HTML at build time.
 * The output includes full HTML with hydration support.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
  const siteRequire = createRequire(join(siteDir, 'package.json'))

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

  if (foundation.config || foundation.site) {
    uniweb.setFoundationConfig(foundation.config || foundation.site)
  }

  // Pre-render each page
  const renderedFiles = []
  const pages = uniweb.activeWebsite.pages

  for (const page of pages) {
    const route = page.route
    onProgress(`Rendering ${route}...`)

    // Set this as the active page
    uniweb.activeWebsite.setActivePage(route)

    // Create the page element
    // Note: We don't need StaticRouter for SSG since we're just rendering
    // components to strings. The routing context isn't needed for static HTML.
    const element = React.createElement(PageRenderer, { page, foundation })

    // Render to HTML string
    let renderedContent
    try {
      renderedContent = renderToString(element)
    } catch (err) {
      console.warn(`Warning: Failed to render ${route}: ${err.message}`)
      if (process.env.DEBUG) {
        console.error(err.stack)
      }
      continue
    }

    // Inject into shell
    const html = injectContent(htmlShell, renderedContent, page, siteContent)

    // Determine output path
    const outputPath = getOutputPath(distDir, route)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, html)

    renderedFiles.push(outputPath)
    onProgress(`  → ${outputPath.replace(distDir, 'dist')}`)
  }

  onProgress(`Pre-rendered ${renderedFiles.length} pages`)

  return {
    pages: renderedFiles.length,
    files: renderedFiles
  }
}

/**
 * Minimal page renderer for SSG
 * Renders blocks using foundation components
 */
function PageRenderer({ page, foundation }) {
  const blocks = page.getPageBlocks()

  return React.createElement(
    'main',
    null,
    blocks.map((block, index) =>
      React.createElement(BlockRenderer, {
        key: block.id || index,
        block,
        foundation
      })
    )
  )
}

/**
 * Block renderer - maps block to foundation component
 */
function BlockRenderer({ block, foundation }) {
  // Get component from foundation
  const componentName = block.component
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

  // Build content object (same as runtime's BlockRenderer)
  let content
  if (block.parsedContent?.raw) {
    content = block.parsedContent.raw
  } else {
    content = {
      ...block.parsedContent,
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
    params: block.properties,
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
