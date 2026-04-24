/**
 * Foundation Entry Point Generator
 *
 * Auto-generates the foundation entry point based on discovered components.
 *
 * Exports:
 * - `components` - Object map of component name -> React component
 * - `capabilities` - Custom Layout and props from src/foundation.js (if present)
 * - `meta` - Per-component runtime metadata extracted from meta.js files
 *
 * The `meta` export contains only properties needed at runtime:
 * - `background` - 'self' opt-out when component handles its own background
 * - `data` - CMS entity binding ({ type, limit })
 * - `defaults` - Param default values
 * - `context` - Static capabilities for cross-block coordination
 * - `initialState` - Initial values for mutable block state
 *
 * Full component metadata lives in schema.json (for the visual editor).
 * Foundation identity (name, description) comes from package.json in the editor schema.
 */

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { discoverComponents, discoverLayoutsInPath } from './schema.js'
import { extractAllRuntimeSchemas, extractAllLayoutRuntimeSchemas } from './runtime-schema.js'

/**
 * Packages that may be bundled inside a foundation but require single-instance
 * access from a host environment (currently: unipress). When a foundation
 * imports any of these, we re-export the named symbols from the generated
 * entry so the host can reach the foundation's bundled copy instead of
 * importing its own — avoiding the dual-instance trap (each side gets its
 * own React.createContext, registrations land in a context the other side
 * can't see).
 *
 * The export list is a public-API contract: removing a symbol here breaks
 * hosts compiled against older built foundations that re-exported it. Add
 * conservatively.
 */
const HOST_SHAREABLE_PACKAGES = {
  '@uniweb/press': ['compileSubtree']
}

const SCAN_EXTENSIONS = new Set(['.jsx', '.tsx', '.js', '.ts'])

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Walk srcDir recursively, yielding paths to scannable JS/TS source files.
 * Skips the auto-generated entry (we'd be reading our own output) and any
 * stray node_modules.
 */
async function* walkSrcFiles(srcDir) {
  const entries = await readdir(srcDir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === '_entry.generated.js') continue
    if (entry.parentPath?.includes('node_modules')) continue
    if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue
    yield join(entry.parentPath ?? srcDir, entry.name)
  }
}

/**
 * Detect which HOST_SHAREABLE_PACKAGES the foundation actually imports.
 * Lenient regex match on `from '<pkg>'` or `from '<pkg>/...'` — false
 * positives only mean a re-export is added when the foundation could
 * have skipped it (negligible, and the package was already in the
 * bundle anyway).
 */
async function detectHostShareableImports(srcDir) {
  const packages = Object.keys(HOST_SHAREABLE_PACKAGES)
  if (packages.length === 0) return []

  const patterns = packages.map(pkg => ({
    pkg,
    re: new RegExp(`from\\s+['"]${escapeRegex(pkg)}(?:/[^'"]*)?['"]`)
  }))

  const found = new Set()
  for await (const file of walkSrcFiles(srcDir)) {
    if (found.size === packages.length) break
    const text = await readFile(file, 'utf-8')
    for (const { pkg, re } of patterns) {
      if (!found.has(pkg) && re.test(text)) found.add(pkg)
    }
  }
  return [...found]
}

/**
 * Detect foundation config file (for props, vars, etc.)
 *
 * Looks for: foundation.js or foundation.jsx
 *
 * The file should export:
 * - props (optional) - Foundation-wide props
 * - vars (optional) - CSS custom properties (also read by schema builder)
 * - defaultLayout (optional) - Default layout name
 *
 * Note: Layout components are now discovered from src/layouts/
 */
function detectFoundationExports(srcDir) {
  const candidates = [
    { path: 'foundation.js', ext: 'js' },
    { path: 'foundation.jsx', ext: 'jsx' },
  ]

  for (const { path, ext } of candidates) {
    if (existsSync(join(srcDir, path))) {
      return { path: `./${path}`, ext }
    }
  }
  return null
}

/**
 * Detect CSS file
 * Looks for: src/styles.css, src/index.css
 */
function detectCssFile(srcDir) {
  const candidates = ['styles.css', 'index.css']
  for (const file of candidates) {
    if (existsSync(join(srcDir, file))) {
      return `./${file}`
    }
  }
  return null
}


/**
 * Generate the entry point source code
 *
 * @param {Object} components - Map of componentName -> { name, path, ext, ...meta }
 * @param {Object} options - Generation options
 */
function generateEntrySource(components, options = {}) {
  const {
    cssPath = null,
    foundationExports = null,
    meta = {},
    layouts = {},
    layoutMeta = {},
    hostShareableImports = [],
  } = options

  const componentNames = Object.keys(components).sort()
  const layoutNames = Object.keys(layouts).sort()

  const lines = [
    '// Auto-generated foundation entry point',
    '// DO NOT EDIT - This file is regenerated during build',
    ''
  ]

  // CSS import
  if (cssPath) {
    lines.push(`import '${cssPath}'`)
  }

  // Foundation capabilities import (for props, vars, etc.)
  // Note: Layout/layouts no longer merged from foundation.js — layouts come from src/layouts/ discovery
  if (foundationExports) {
    lines.push(`import * as _foundationModule from '${foundationExports.path}'`)
  }

  // Component imports
  for (const name of componentNames) {
    const { path, entryFile = `index.js` } = components[name]
    lines.push(`import ${name} from './${path}/${entryFile}'`)
  }

  // Layout imports
  for (const name of layoutNames) {
    const { path, entryFile = `index.js` } = layouts[name]
    lines.push(`import ${name} from './${path}/${entryFile}'`)
  }

  lines.push('')

  // Named exports — one per component
  if (componentNames.length > 0) {
    lines.push(`export { ${componentNames.join(', ')} }`)
  }

  // Foundation capabilities (props, vars, etc. + discovered layouts)
  lines.push('')
  if (foundationExports || layoutNames.length > 0) {
    const capParts = []
    if (foundationExports) {
      capParts.push('..._foundationModule.default')
    }
    if (layoutNames.length > 0) {
      capParts.push(`layouts: { ${layoutNames.join(', ')} }`)
    }
    lines.push(`const capabilities = { ${capParts.join(', ')} }`)
  } else {
    lines.push('const capabilities = null')
  }

  // Per-component runtime metadata (defaults, context, initialState, background, data)
  lines.push('')
  const metaJson = JSON.stringify(Object.keys(meta).length > 0 ? meta : {}, null, 2)
  lines.push(`const meta = ${metaJson}`)

  // Per-layout runtime metadata (areas, transitions, defaults)
  lines.push('')
  const layoutMetaJson = JSON.stringify(Object.keys(layoutMeta).length > 0 ? layoutMeta : {}, null, 2)
  lines.push(`const layoutMeta = ${layoutMetaJson}`)

  // Default export — non-component data (naturally unforgeable key)
  lines.push('')
  lines.push('export default { meta, capabilities, layoutMeta }')

  // Re-export host-shareable packages the foundation actually imports.
  // Lets unipress reach the foundation's bundled copy instead of importing
  // its own (which would create a dual-instance React-context trap).
  if (hostShareableImports.length > 0) {
    lines.push('')
    for (const pkg of hostShareableImports) {
      const symbols = HOST_SHAREABLE_PACKAGES[pkg]
      lines.push(`export { ${symbols.join(', ')} } from '${pkg}'`)
    }
  }

  lines.push('')

  return lines.join('\n')
}

/**
 * Detect the entry file for a component
 *
 * Supports two conventions:
 * - index.jsx (default)
 * - ComponentName.jsx (named file matching the directory name)
 *
 * Named files are checked first so that Hero/Hero.jsx takes precedence
 * over Hero/index.jsx when both exist (the named file is more intentional).
 *
 * @param {string} srcDir - Source directory
 * @param {string} componentPath - Relative path to component (e.g., 'components/Hero')
 * @param {string} componentName - Component name (e.g., 'Hero')
 * @returns {{ file: string, ext: string }} Entry file name and extension
 */
function detectComponentEntry(srcDir, componentPath, componentName) {
  const basePath = join(srcDir, componentPath)
  for (const ext of ['jsx', 'tsx', 'js', 'ts']) {
    // Check named file first: Hero/Hero.jsx
    if (existsSync(join(basePath, `${componentName}.${ext}`))) {
      return { file: `${componentName}.${ext}`, ext }
    }
    // Then index file: Hero/index.jsx
    if (existsSync(join(basePath, `index.${ext}`))) {
      return { file: `index.${ext}`, ext }
    }
  }
  return { file: 'index.js', ext: 'js' } // default
}

/**
 * Generate the foundation entry point file
 *
 * @param {string} srcDir - Source directory
 * @param {string} [outputPath] - Output file path (default: srcDir/_entry.generated.js)
 * @param {Object} [options] - Options
 * @param {string[]} [options.sectionPaths] - Paths to scan for section types (relative to srcDir)
 */
export async function generateEntryPoint(srcDir, outputPath = null, options = {}) {
  const { sectionPaths } = options

  // Discover section types (includes meta from meta.js files)
  const components = await discoverComponents(srcDir, sectionPaths)
  const componentNames = Object.keys(components).sort()

  if (componentNames.length === 0) {
    console.warn('Warning: No section types found')
  }

  // Discover layouts from src/layouts/
  const layouts = await discoverLayoutsInPath(srcDir)
  const layoutNames = Object.keys(layouts).sort()

  // Detect entry files for each component
  // Bare files discovered in sections/ already have entryFile set — skip detection for those
  for (const name of componentNames) {
    const component = components[name]
    if (!component.entryFile) {
      const entry = detectComponentEntry(srcDir, component.path, component.name)
      component.ext = entry.ext
      component.entryFile = entry.file
    }
  }

  // Detect entry files for each layout (same logic as components)
  for (const name of layoutNames) {
    const layout = layouts[name]
    if (!layout.entryFile) {
      const entry = detectComponentEntry(srcDir, layout.path, layout.name)
      layout.ext = entry.ext
      layout.entryFile = entry.file
    }
  }

  // Check for CSS file
  const cssPath = detectCssFile(srcDir)

  // Check for foundation exports (props, vars, etc.)
  const foundationExports = detectFoundationExports(srcDir)

  // Extract per-component runtime metadata from meta.js files
  const meta = extractAllRuntimeSchemas(components)

  // Extract per-layout runtime metadata from meta.js files
  const layoutMeta = extractAllLayoutRuntimeSchemas(layouts)

  // Detect which host-shareable packages the foundation imports
  const hostShareableImports = await detectHostShareableImports(srcDir)

  // Generate source
  const source = generateEntrySource(components, {
    cssPath,
    foundationExports,
    meta,
    layouts,
    layoutMeta,
    hostShareableImports,
  })

  // Write to file (skip if content unchanged to avoid unnecessary watcher triggers)
  const output = outputPath || join(srcDir, '_entry.generated.js')
  await mkdir(dirname(output), { recursive: true })

  let written = false
  if (existsSync(output)) {
    const existing = await readFile(output, 'utf-8')
    if (existing !== source) {
      await writeFile(output, source, 'utf-8')
      written = true
    }
  } else {
    await writeFile(output, source, 'utf-8')
    written = true
  }

  console.log(`${written ? 'Generated' : 'Unchanged'} entry point: ${output}`)
  console.log(`  - ${componentNames.length} components: ${componentNames.join(', ')}`)
  if (layoutNames.length > 0) {
    console.log(`  - ${layoutNames.length} layouts: ${layoutNames.join(', ')}`)
  }
  if (foundationExports) {
    console.log(`  - Foundation exports found: ${foundationExports.path}`)
  }
  if (hostShareableImports.length > 0) {
    console.log(`  - Host-shareable re-exports: ${hostShareableImports.join(', ')}`)
  }

  return {
    outputPath: output,
    componentNames,
    layoutNames,
    foundationExports,
    meta,
    layoutMeta,
    hostShareableImports,
  }
}

/**
 * Check if a file change should trigger entry point regeneration.
 *
 * Used by both the foundation dev plugin and the site's bundled-mode plugin
 * to decide when to re-run generateEntryPoint().
 *
 * The content-comparison guard in generateEntryPoint() makes false positives
 * cheap (discovery runs but no write), so we err on the side of regenerating.
 *
 * @param {string} file - Absolute path of the changed file
 * @param {string} srcDir - Foundation source directory (absolute)
 * @returns {string|null} Reason string if regeneration needed, null otherwise
 */
export function shouldRegenerateForFile(file, srcDir) {
  if (!file.startsWith(srcDir + '/')) return null

  const rel = file.slice(srcDir.length + 1)

  // meta.js anywhere — affects runtime metadata
  if (rel.endsWith('/meta.js') || rel === 'meta.js') {
    return 'meta.js changed'
  }

  // foundation.js / foundation.jsx at root — affects capabilities import
  if (/^foundation\.(js|jsx)$/.test(rel)) {
    return 'foundation config changed'
  }

  // styles.css / index.css at root — affects CSS import line
  if (/^(styles|index)\.css$/.test(rel)) {
    return 'foundation styles changed'
  }

  // sections/ — relaxed discovery (bare files + entry files in PascalCase dirs)
  if (rel.startsWith('sections/')) {
    const inner = rel.slice('sections/'.length)
    const parts = inner.split('/')

    // Bare file at sections root: sections/Hero.jsx
    if (parts.length === 1 && /^[A-Z].*\.(jsx|tsx|js|ts)$/.test(parts[0])) {
      return `section file: ${parts[0]}`
    }

    // Entry file in a PascalCase directory: sections/Hero/index.jsx or sections/Hero/Hero.jsx
    if (parts.length === 2 && /^[A-Z]/.test(parts[0]) && /\.(jsx|tsx|js|ts)$/.test(parts[1])) {
      const base = parts[1].replace(/\.(jsx|tsx|js|ts)$/, '')
      if (base === 'index' || base === parts[0]) {
        return `section entry: ${inner}`
      }
    }
  }

  // layouts/ — bare files and entry files
  if (rel.startsWith('layouts/')) {
    const inner = rel.slice('layouts/'.length)
    const parts = inner.split('/')

    // Bare file at layouts root: layouts/docs.jsx
    if (parts.length === 1 && /\.(jsx|tsx|js|ts)$/.test(parts[0])) {
      return `layout file: ${parts[0]}`
    }

    // Entry file in a directory: layouts/docs/index.jsx or layouts/docs/docs.jsx
    if (parts.length === 2 && /\.(jsx|tsx|js|ts)$/.test(parts[1])) {
      const base = parts[1].replace(/\.(jsx|tsx|js|ts)$/, '')
      if (base === 'index' || base === parts[0]) {
        return `layout entry: ${inner}`
      }
    }
  }

  return null
}
