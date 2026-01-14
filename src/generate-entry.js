/**
 * Foundation Entry Point Generator
 *
 * Auto-generates the foundation entry point based on discovered components.
 * The generated file exports components and runtime configuration.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  discoverComponents,
  loadFoundationMeta,
  extractRuntimeConfig,
} from './schema.js'

/**
 * Generate the entry point source code
 */
function generateEntrySource(componentNames, runtimeConfig, options = {}) {
  const { includeCss = true, cssPath = './index.css', componentExtensions = {} } = options

  const imports = []
  const exports = []

  // CSS import
  if (includeCss) {
    imports.push(`import '${cssPath}'`)
  }

  // Component imports (use detected extension or default to .js)
  for (const name of componentNames) {
    const ext = componentExtensions[name] || 'js'
    imports.push(`import ${name} from './components/${name}/index.${ext}'`)
  }

  // Build components object
  const componentsObj = `const components = {\n  ${componentNames.join(',\n  ')},\n}`

  // Runtime config (serialized)
  const configStr = JSON.stringify(runtimeConfig, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n')

  const runtimeConfigBlock = `
// Runtime configuration (extracted from meta files)
// Only includes properties needed at render time
const runtimeConfig = ${configStr}`

  // Export functions
  const exportFunctions = `
/**
 * Get a component by name
 */
export function getComponent(name) {
  return components[name]
}

/**
 * List all available component names
 */
export function listComponents() {
  return Object.keys(components)
}

/**
 * Get runtime config for a specific component
 * Returns input schema and other render-time properties
 */
export function getComponentConfig(name) {
  return runtimeConfig.components[name] || {}
}

/**
 * Get foundation-level runtime config
 */
export function getFoundationConfig() {
  return runtimeConfig.foundation
}

/**
 * Get all component schemas (for compatibility)
 * Note: Full schemas are in schema.json, this only returns runtime-relevant config
 */
export function getAllSchemas() {
  const schemas = {}
  for (const name of Object.keys(components)) {
    if (components[name].schema) {
      schemas[name] = components[name].schema
    }
  }
  return schemas
}

/**
 * Get schema for a specific component (for compatibility)
 */
export function getSchema(name) {
  return components[name]?.schema
}`

  // Named exports for direct imports
  const namedExports = componentNames.length > 0
    ? `\n// Named exports for direct imports\nexport { ${componentNames.join(', ')} }`
    : ''

  return `// Auto-generated foundation entry point
// DO NOT EDIT - This file is regenerated during build

${imports.join('\n')}

${componentsObj}
${runtimeConfigBlock}
${exportFunctions}
${namedExports}
`
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
  // Discover components
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

  // Load foundation meta and build runtime config
  const foundationMeta = await loadFoundationMeta(srcDir)

  const runtimeConfig = {
    foundation: extractRuntimeConfig(foundationMeta),
    components: {},
  }

  for (const [name, meta] of Object.entries(components)) {
    const config = extractRuntimeConfig(meta)
    if (Object.keys(config).length > 0) {
      runtimeConfig.components[name] = config
    }
  }

  // Check if CSS exists
  const cssExists = existsSync(join(srcDir, 'index.css'))

  // Generate source
  const source = generateEntrySource(componentNames, runtimeConfig, {
    includeCss: cssExists,
    componentExtensions,
  })

  // Write to file
  const output = outputPath || join(srcDir, '_entry.generated.js')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, source, 'utf-8')

  console.log(`Generated entry point: ${output}`)
  console.log(`  - ${componentNames.length} components: ${componentNames.join(', ')}`)

  return {
    outputPath: output,
    componentNames,
    runtimeConfig,
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
