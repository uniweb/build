/**
 * Foundation Entry Point Generator
 *
 * Auto-generates the foundation entry point based on discovered components.
 *
 * Exports:
 * - `components` - Object map of component name -> React component
 * - `runtime` - Custom Layout and props from src/runtime.js (if present)
 * - `meta` - Runtime metadata extracted from component meta.js files
 *
 * The `meta` export contains properties from meta.js that are needed at runtime,
 * not just editor-time. Currently this includes:
 * - `input` - Form input schemas (for components that accept user input)
 *
 * Full component metadata lives in schema.json (for the visual editor).
 * Only runtime-essential properties are extracted here to keep bundles small.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { discoverComponents } from './schema.js'

/**
 * Keys from meta.js that should be included in the runtime bundle.
 * These are properties needed at runtime, not just editor-time.
 *
 * - input: Form schemas for components that accept user input
 */
const RUNTIME_META_KEYS = ['input']

/**
 * Detect runtime configuration file (for custom Layout, props, etc.)
 * Looks for: src/runtime.js, src/runtime.jsx, src/runtime/index.js, src/runtime/index.jsx
 */
function detectRuntimeExports(srcDir) {
  const candidates = [
    { path: 'runtime.js', ext: 'js' },
    { path: 'runtime.jsx', ext: 'jsx' },
    { path: 'runtime/index.js', ext: 'js' },
    { path: 'runtime/index.jsx', ext: 'jsx' },
  ]

  for (const { path, ext } of candidates) {
    if (existsSync(join(srcDir, path))) {
      return { path: `./${path.replace(/\/index\.(js|jsx)$/, '')}`, ext }
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
 * Extract runtime-needed properties from component meta
 */
function extractRuntimeMeta(componentsMeta) {
  const meta = {}

  for (const [name, componentMeta] of Object.entries(componentsMeta)) {
    const extracted = {}
    for (const key of RUNTIME_META_KEYS) {
      if (componentMeta[key] !== undefined) {
        extracted[key] = componentMeta[key]
      }
    }
    if (Object.keys(extracted).length > 0) {
      meta[name] = extracted
    }
  }

  return meta
}

/**
 * Generate the entry point source code
 */
function generateEntrySource(componentNames, options = {}) {
  const { cssPath = null, componentExtensions = {}, runtimeExports = null, runtimeMeta = {} } = options

  const lines = [
    '// Auto-generated foundation entry point',
    '// DO NOT EDIT - This file is regenerated during build',
    ''
  ]

  // CSS import
  if (cssPath) {
    lines.push(`import '${cssPath}'`)
  }

  // Runtime exports import (for custom Layout, props, etc.)
  if (runtimeExports) {
    lines.push(`import runtime from '${runtimeExports.path}'`)
  }

  // Component imports (use detected extension or default to .js)
  for (const name of componentNames) {
    const ext = componentExtensions[name] || 'js'
    lines.push(`import ${name} from './components/${name}/index.${ext}'`)
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

  // Runtime exports (Layout, props, etc.)
  lines.push('')
  if (runtimeExports) {
    lines.push('export { runtime }')
  } else {
    lines.push('export const runtime = null')
  }

  // Runtime meta (form schemas, etc.) - only if non-empty
  lines.push('')
  if (Object.keys(runtimeMeta).length > 0) {
    const metaJson = JSON.stringify(runtimeMeta, null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : line))
      .join('\n')
    lines.push(`// Runtime metadata (form schemas, etc.)`)
    lines.push(`export const meta = ${metaJson}`)
  } else {
    lines.push('export const meta = {}')
  }

  lines.push('')

  return lines.join('\n')
}

/**
 * Detect the index file extension for a component
 */
function detectComponentExtension(srcDir, componentName) {
  const basePath = join(srcDir, 'components', componentName)
  for (const ext of ['jsx', 'tsx', 'js', 'ts']) {
    if (existsSync(join(basePath, `index.${ext}`))) {
      return ext
    }
  }
  return 'js' // default
}

/**
 * Generate the foundation entry point file
 */
export async function generateEntryPoint(srcDir, outputPath = null) {
  // Discover components (includes meta from meta.js files)
  const components = await discoverComponents(srcDir)
  const componentNames = Object.keys(components).sort()

  if (componentNames.length === 0) {
    console.warn('Warning: No exposed components found')
  }

  // Detect extensions for each component
  const componentExtensions = {}
  for (const name of componentNames) {
    componentExtensions[name] = detectComponentExtension(srcDir, name)
  }

  // Check for CSS file
  const cssPath = detectCssFile(srcDir)

  // Check for runtime exports (custom Layout, props, etc.)
  const runtimeExports = detectRuntimeExports(srcDir)

  // Extract runtime-needed meta (form schemas, etc.)
  const runtimeMeta = extractRuntimeMeta(components)

  // Generate source
  const source = generateEntrySource(componentNames, {
    cssPath,
    componentExtensions,
    runtimeExports,
    runtimeMeta,
  })

  // Write to file
  const output = outputPath || join(srcDir, '_entry.generated.js')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, source, 'utf-8')

  console.log(`Generated entry point: ${output}`)
  console.log(`  - ${componentNames.length} components: ${componentNames.join(', ')}`)
  if (runtimeExports) {
    console.log(`  - Runtime exports found: ${runtimeExports.path}`)
  }

  return {
    outputPath: output,
    componentNames,
    runtimeExports,
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
