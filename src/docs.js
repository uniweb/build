/**
 * Documentation Generator
 *
 * Generates markdown documentation from foundation schema.json
 * or directly from component meta files.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildSchema } from './schema.js'

/**
 * Generate markdown documentation for a single component
 *
 * @param {string} name - Component name
 * @param {Object} meta - Component metadata
 * @returns {string} Markdown content
 */
function generateComponentDocs(name, meta) {
  const lines = []

  // Component header
  lines.push(`## ${name}`)
  lines.push('')

  // Description
  if (meta.description) {
    lines.push(meta.description)
    lines.push('')
  }

  // Parameters/Properties (shown first - most important for content authors)
  if (meta.properties && Object.keys(meta.properties).length > 0) {
    lines.push('### Parameters')
    lines.push('')

    for (const [key, prop] of Object.entries(meta.properties)) {
      const defaultVal = prop.default !== undefined ? prop.default : ''

      // Parameter name with default
      if (defaultVal !== '') {
        lines.push(`**${key}** = \`${defaultVal}\``)
      } else {
        lines.push(`**${key}**`)
      }

      // For select type, show options on next line
      if (prop.type === 'select' && prop.options) {
        const optionValues = prop.options.map(o =>
          typeof o === 'object' ? o.value : o
        ).join(' | ')
        lines.push(`  ${optionValues}`)
      } else if (prop.type === 'boolean') {
        // For boolean, show the label as description
        if (prop.label) {
          lines.push(`  ${prop.label}`)
        }
      } else if (prop.label) {
        // For other types, show label
        lines.push(`  ${prop.label}`)
      }

      lines.push('')
    }
  }

  // Presets
  if (meta.presets && meta.presets.length > 0) {
    lines.push('### Presets')
    lines.push('')

    for (const preset of meta.presets) {
      const settings = preset.settings
        ? Object.entries(preset.settings)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
        : ''
      lines.push(`- **${preset.name}**${settings ? ` — ${settings}` : ''}`)
    }
    lines.push('')
  }

  // Content Elements (condensed - less important)
  if (meta.elements && Object.keys(meta.elements).length > 0) {
    const elements = Object.entries(meta.elements)
    const elementList = elements.map(([key, el]) => {
      return el.required ? `${key} (required)` : key
    }).join(', ')

    lines.push('### Content')
    lines.push('')
    lines.push(elementList)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Generate full markdown documentation for a foundation
 *
 * @param {Object} schema - Foundation schema object
 * @param {Object} options - Generation options
 * @param {string} [options.title] - Document title
 * @returns {string} Complete markdown documentation
 */
export function generateDocsFromSchema(schema, options = {}) {
  const { title = 'Foundation Components' } = options
  const lines = []

  // Header
  lines.push(`# ${title}`)
  lines.push('')

  // Foundation description
  const foundationMeta = schema._self
  if (foundationMeta?.description) {
    lines.push(foundationMeta.description)
    lines.push('')
  }

  lines.push('---')
  lines.push('')

  // Table of contents
  const componentNames = Object.keys(schema).filter(k => k !== '_self')

  if (componentNames.length > 0) {
    lines.push('## Components')
    lines.push('')
    lines.push(componentNames.map(name => `[${name}](#${name.toLowerCase()})`).join(' · '))
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // Component documentation
  for (const name of componentNames) {
    const meta = schema[name]
    lines.push(generateComponentDocs(name, meta))
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n').trim() + '\n'
}

/**
 * Generate documentation for a foundation directory
 *
 * Can read from existing schema.json or build schema from source.
 *
 * @param {string} foundationDir - Path to foundation directory
 * @param {Object} options - Options
 * @param {string} [options.output] - Output file path (default: COMPONENTS.md)
 * @param {boolean} [options.fromSource] - Build schema from source instead of dist
 * @returns {Promise<{outputPath: string, componentCount: number}>}
 */
export async function generateDocs(foundationDir, options = {}) {
  const {
    output = 'COMPONENTS.md',
    fromSource = false,
  } = options

  let schema

  // Try to load schema.json from dist
  const schemaPath = join(foundationDir, 'dist', 'schema.json')

  if (!fromSource && existsSync(schemaPath)) {
    // Load from existing schema.json
    const schemaContent = await readFile(schemaPath, 'utf-8')
    schema = JSON.parse(schemaContent)
  } else {
    // Build schema from source
    const srcDir = join(foundationDir, 'src')
    if (!existsSync(srcDir)) {
      throw new Error(`Source directory not found: ${srcDir}`)
    }
    schema = await buildSchema(srcDir)
  }

  // Get foundation name for title
  const pkgPath = join(foundationDir, 'package.json')
  let title = 'Foundation Components'
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
    if (pkg.name) {
      title = `${pkg.name} Components`
    }
  }

  // Generate markdown
  const markdown = generateDocsFromSchema(schema, { title })

  // Write output
  const outputPath = join(foundationDir, output)
  await writeFile(outputPath, markdown)

  // Count components
  const componentCount = Object.keys(schema).filter(k => k !== '_self').length

  return { outputPath, componentCount }
}
