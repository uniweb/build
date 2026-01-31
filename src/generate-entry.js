/**
 * Foundation Entry Point Generator
 *
 * Auto-generates the foundation entry point based on discovered components.
 *
 * Exports:
 * - `components` - Object map of component name -> React component
 * - `capabilities` - Custom Layout and props from src/exports.js (if present)
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

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { discoverComponents } from './schema.js'
import { extractAllRuntimeSchemas } from './runtime-schema.js'

/**
 * Detect foundation config/exports file (for custom Layout, props, vars, etc.)
 *
 * Looks for (in order of preference):
 * 1. foundation.js - New consolidated format
 * 2. exports.js - Legacy format (for backward compatibility)
 *
 * The file should export:
 * - Layout (optional) - Custom page layout component
 * - props (optional) - Foundation-wide props
 * - vars (optional) - CSS custom properties (also read by schema builder)
 */
function detectFoundationExports(srcDir) {
  // Prefer foundation.js (new consolidated format)
  const foundationCandidates = [
    { path: 'foundation.js', ext: 'js' },
    { path: 'foundation.jsx', ext: 'jsx' },
  ]

  for (const { path, ext } of foundationCandidates) {
    if (existsSync(join(srcDir, path))) {
      return { path: `./${path}`, ext, isFoundationJs: true }
    }
  }

  // Fall back to exports.js (legacy format)
  const legacyCandidates = [
    { path: 'exports.js', ext: 'js' },
    { path: 'exports.jsx', ext: 'jsx' },
    { path: 'exports/index.js', ext: 'js' },
    { path: 'exports/index.jsx', ext: 'jsx' },
  ]

  for (const { path, ext } of legacyCandidates) {
    if (existsSync(join(srcDir, path))) {
      return { path: `./${path.replace(/\/index\.(js|jsx)$/, '')}`, ext, isFoundationJs: false }
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
  } = options

  const componentNames = Object.keys(components).sort()

  const lines = [
    '// Auto-generated foundation entry point',
    '// DO NOT EDIT - This file is regenerated during build',
    ''
  ]

  // CSS import
  if (cssPath) {
    lines.push(`import '${cssPath}'`)
  }

  // Foundation capabilities import (for custom Layout, props, etc.)
  if (foundationExports) {
    lines.push(`import capabilities from '${foundationExports.path}'`)
  }

  // Component imports
  for (const name of componentNames) {
    const { path, entryFile = `index.js` } = components[name]
    lines.push(`import ${name} from './${path}/${entryFile}'`)
  }

  lines.push('')

  // Export components object
  if (componentNames.length > 0) {
    lines.push(`export const components = { ${componentNames.join(', ')} }`)
    lines.push('')
    lines.push(`export { ${componentNames.join(', ')} }`)
  } else {
    lines.push('export const components = {}')
  }

  // Foundation capabilities (Layout, props, etc.)
  lines.push('')
  if (foundationExports) {
    lines.push('export { capabilities }')
  } else {
    lines.push('export const capabilities = null')
  }

  // Per-component metadata (defaults, context, initialState, background, data)
  lines.push('')
  if (Object.keys(meta).length > 0) {
    const metaJson = JSON.stringify(meta, null, 2)
    lines.push(`// Per-component runtime metadata (from meta.js)`)
    lines.push(`export const meta = ${metaJson}`)
  } else {
    lines.push('export const meta = {}')
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
 * @param {string[]} [options.componentPaths] - Paths to search for components (relative to srcDir)
 */
export async function generateEntryPoint(srcDir, outputPath = null, options = {}) {
  const { componentPaths } = options

  // Discover components (includes meta from meta.js files)
  const components = await discoverComponents(srcDir, componentPaths)
  const componentNames = Object.keys(components).sort()

  if (componentNames.length === 0) {
    console.warn('Warning: No section types found (no meta.js files discovered)')
  }

  // Detect entry files for each component
  for (const name of componentNames) {
    const component = components[name]
    const entry = detectComponentEntry(srcDir, component.path, component.name)
    component.ext = entry.ext
    component.entryFile = entry.file
  }

  // Check for CSS file
  const cssPath = detectCssFile(srcDir)

  // Check for foundation exports (custom Layout, props, etc.)
  const foundationExports = detectFoundationExports(srcDir)

  // Extract per-component runtime metadata from meta.js files
  const meta = extractAllRuntimeSchemas(components)

  // Generate source
  const source = generateEntrySource(components, {
    cssPath,
    foundationExports,
    meta,
  })

  // Write to file
  const output = outputPath || join(srcDir, '_entry.generated.js')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, source, 'utf-8')

  console.log(`Generated entry point: ${output}`)
  console.log(`  - ${componentNames.length} components: ${componentNames.join(', ')}`)
  if (foundationExports) {
    console.log(`  - Foundation exports found: ${foundationExports.path}`)
  }

  return {
    outputPath: output,
    componentNames,
    foundationExports,
    meta,
  }
}

/**
 * Check if entry point needs regeneration
 * (Compare discovered components with existing generated file)
 */
export async function shouldRegenerateEntry(srcDir, entryPath) {
  if (!existsSync(entryPath)) return true

  // Could add more sophisticated checking here
  // For now, always regenerate during build
  return true
}
