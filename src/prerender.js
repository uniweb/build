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
 * Guarantee item has flat content structure
 */
function guaranteeItemStructure(item) {
  return {
    title: item.title || '',
    pretitle: item.pretitle || '',
    subtitle: item.subtitle || '',
    paragraphs: item.paragraphs || [],
    links: item.links || [],
    imgs: item.imgs || [],
    lists: item.lists || [],
    icons: item.icons || [],
    videos: item.videos || [],
    buttons: item.buttons || [],
    data: item.data || {},
    cards: item.cards || [],
    documents: item.documents || [],
    forms: item.forms || [],
    quotes: item.quotes || [],
    headings: item.headings || [],
  }
}

/**
 * Guarantee content structure exists (mirrors runtime/prepare-props.js)
 * Returns a flat content object with all standard fields guaranteed to exist
 */
function guaranteeContentStructure(parsedContent) {
  const content = parsedContent || {}

  return {
    // Flat header fields
    title: content.title || '',
    pretitle: content.pretitle || '',
    subtitle: content.subtitle || '',
    subtitle2: content.subtitle2 || '',
    alignment: content.alignment || null,

    // Flat body fields
    paragraphs: content.paragraphs || [],
    links: content.links || [],
    imgs: content.imgs || [],
    lists: content.lists || [],
    icons: content.icons || [],
    videos: content.videos || [],
    buttons: content.buttons || [],
    data: content.data || {},
    cards: content.cards || [],
    documents: content.documents || [],
    forms: content.forms || [],
    quotes: content.quotes || [],
    headings: content.headings || [],

    // Items with guaranteed structure
    items: (content.items || []).map(guaranteeItemStructure),

    // Sequence for ordered rendering
    sequence: content.sequence || [],

    // Preserve raw content if present
    raw: content.raw,
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
 * Apply a schema to a single object
 * Only processes fields defined in the schema, preserves unknown fields
 */
function applySchemaToObject(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj
  }

  const result = { ...obj }

  for (const [field, fieldDef] of Object.entries(schema)) {
    const defaultValue = typeof fieldDef === 'object' ? fieldDef.default : undefined

    if (result[field] === undefined && defaultValue !== undefined) {
      result[field] = defaultValue
    }

    if (typeof fieldDef === 'object' && fieldDef.type === 'object' && fieldDef.schema && result[field]) {
      result[field] = applySchemaToObject(result[field], fieldDef.schema)
    }

    if (typeof fieldDef === 'object' && fieldDef.type === 'array' && fieldDef.of && result[field]) {
      if (typeof fieldDef.of === 'object') {
        result[field] = result[field].map(item => applySchemaToObject(item, fieldDef.of))
      }
    }
  }

  return result
}

/**
 * Apply a schema to a value (object or array of objects)
 */
function applySchemaToValue(value, schema) {
  if (Array.isArray(value)) {
    return value.map(item => applySchemaToObject(item, schema))
  }
  return applySchemaToObject(value, schema)
}

/**
 * Apply schemas to content.data
 * Only processes tags that have a matching schema, leaves others untouched
 */
function applySchemas(data, schemas) {
  if (!schemas || !data || typeof data !== 'object') {
    return data || {}
  }

  const result = { ...data }

  for (const [tag, rawValue] of Object.entries(data)) {
    const schema = schemas[tag]
    if (!schema) continue

    result[tag] = applySchemaToValue(rawValue, schema)
  }

  return result
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
  const componentSchema = runtimeSchema[componentName] || null
  const defaults = componentSchema?.defaults || {}
  const schemas = componentSchema?.schemas || null

  // Build content and params with runtime guarantees (same as runtime's BlockRenderer)
  let content, params
  if (block.parsedContent?._isPoc) {
    // Simple PoC format - content was passed directly
    content = block.parsedContent._pocContent
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

    // Apply schemas to content.data
    if (schemas && content.data) {
      content.data = applySchemas(content.data, schemas)
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
