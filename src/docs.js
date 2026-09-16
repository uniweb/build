/**
 * Documentation Generator
 *
 * Generates markdown documentation from foundation schema.json
 * or directly from component meta files.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { buildSchema } from './schema.js'
import { resolveFoundationSrcPath } from './utils/foundation-source-root.js'

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

  // The standard section type this component claims. `family` replaced the
  // retired `category:` / `purpose:` pair, which this generator never emitted.
  if (meta.family) {
    lines.push(`*Family:* \`${meta.family}\``)
    lines.push('')
  }

  // Parameters (shown first - most important for content authors)
  if (meta.params && Object.keys(meta.params).length > 0) {
    lines.push('### Parameters')
    lines.push('')

    for (const [key, prop] of Object.entries(meta.params)) {
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

  // Presets — named param combinations. `meta.presets` is a KEYED OBJECT
  // ({ name: { label, params } }), not an array: this read `meta.presets.length`
  // until 2026-09-16, which is `undefined > 0` on an object, so every preset in
  // every foundation was dropped from COMPONENTS.md with nothing reporting it.
  const presets = Object.entries(meta.presets || {})
  if (presets.length > 0) {
    lines.push('### Presets')
    lines.push('')

    for (const [name, preset] of presets) {
      const settings = preset?.params
        ? Object.entries(preset.params)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
        : ''
      const label = preset?.label || name
      lines.push(`- **${name}**${label !== name ? ` — ${label}` : ''}${settings ? ` (${settings})` : ''}`)
    }
    lines.push('')
  }

  // Content expectations — what an author writes in the markdown. The key is
  // `content`; this read `meta.content` as `meta.elements` until 2026-09-16 —
  // the pre-rename name, which nothing has produced since. A dead branch reads
  // exactly like a component that declares nothing, so the whole section was
  // missing from every generated catalog.
  //
  // A value is either a label string ('Description [1-2]') or { label, hint }.
  // The LABEL is the point: `paragraphs` alone tells an author nothing, and the
  // count hint is the part that says how much to write.
  const elements = Object.entries(meta.content || {})
  if (elements.length > 0) {
    lines.push('### Content')
    lines.push('')

    for (const [key, el] of elements) {
      const label = typeof el === 'string' ? el : el?.label || ''
      lines.push(`**${key}**${label ? ` — ${label}` : ''}`)
      const hint = typeof el === 'object' && el?.hint ? el.hint : ''
      if (hint) lines.push(`  ${hint}`)
      lines.push('')
    }
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

  // Try to load schema.json from dist/meta (where foundation build outputs it)
  const schemaPath = join(foundationDir, 'dist', 'meta', 'schema.json')

  if (!fromSource && existsSync(schemaPath)) {
    // Load from existing schema.json
    const schemaContent = await readFile(schemaPath, 'utf-8')
    schema = JSON.parse(schemaContent)
  } else {
    // Build schema from source
    const srcDir = resolveFoundationSrcPath(foundationDir)
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

  // Write output (support absolute paths for site-based generation)
  const outputPath = isAbsolute(output) ? output : join(foundationDir, output)
  await writeFile(outputPath, markdown)

  // Count components
  const componentCount = Object.keys(schema).filter(k => k !== '_self').length

  return { outputPath, componentCount }
}
