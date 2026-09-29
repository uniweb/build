/**
 * Documentation Generator
 *
 * Generates markdown documentation from foundation schema.json
 * or directly from component meta files.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { describeContent } from '@uniweb/schemas/content'
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

  // Content expectations — what an author writes in the markdown, read through
  // `describeContent`: a built schema holds the lowered list (`SCHEMA_FORMAT` 2), a
  // `meta.js` the declaration as written, and both describe alike. ⛔ This read
  // `meta.content` as a map of labels until 2026-09-29 — which the lowered list is not —
  // and as `meta.elements`, the pre-rename name, until 2026-09-16.
  //
  // The LABEL is the point: `paragraphs` alone tells an author nothing, and the count is
  // the part that says how much to write — shown in the bracket syntax they write.
  const { elements } = describeContent(meta)
  if (elements.length > 0) {
    lines.push('### Content')
    lines.push('')

    for (const el of elements) {
      const name = el.kind === 'concept' ? `md:${el.key}` : el.element
      const types = el.element === 'media' && el.types.length < 3 ? ` (${el.types.join(', ')})` : ''
      const count = bracketCount(el)
      const label = [el.label, count].filter(Boolean).join(' ')
      lines.push(`**${name}**${types}${label ? ` — ${label}` : ''}`)
      if (el.hint) lines.push(`  ${el.hint}`)
      if (el.except) lines.push(`  Leaves out: ${el.except.join(', ')}`)
      if (el.content) {
        lines.push(`  Each entry: ${el.content.map((c) => [c.element, c.label].filter(Boolean).join(' — ')).join(' · ')}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

/** A lowered entry's count, as a developer writes it: `[1]`, `[3-6]`, `[2+]` — or ''. */
function bracketCount({ min, max }) {
  if (typeof min !== 'number') return ''
  if (typeof max !== 'number') return `[${min}+]`
  return min === max ? `[${min}]` : `[${min}-${max}]`
}

/** The section types of a foundation schema: every key but `_self`, `_layouts` and `dataSchemas`. */
function sectionTypesOf(schema) {
  return Object.keys(schema).filter((key) => !key.startsWith('_') && key !== 'dataSchemas')
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

  // Table of contents. A schema's section types are its keys but `_self`, `_layouts` and
  // `dataSchemas` (`buildSchema`); ⛔ until 2026-09-29 only `_self` was left out, so a
  // foundation with layouts or data schemas documented both as components.
  const componentNames = sectionTypesOf(schema)

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
  const componentCount = sectionTypesOf(schema).length

  return { outputPath, componentCount }
}
