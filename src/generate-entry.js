/**
 * Foundation Entry Point Generator
 *
 * Auto-generates the foundation entry point based on discovered components.
 *
 * Exports:
 * - `components` - Object map of component name -> React component
 * - `capabilities` - what the runtime reads of src/main.js (`extractFoundationRuntime`): the
 *   code it calls, referenced from the module, and its data, lean — plus the discovered layouts
 * - `meta` - Per-component runtime metadata extracted from meta.js files
 *
 * The `meta` export contains only properties needed at runtime:
 * - `background` - 'self' opt-out when component handles its own background
 * - `data` - the `content.data` keys the component declares, with their schema refs
 * - `defaults` - Param default values
 * - `context` - Static capabilities for cross-block coordination
 * - `initialState` - Initial values for mutable block state
 *
 * Full component metadata lives in schema.json (for the visual editor).
 * Foundation identity (name, description) comes from package.json in the editor schema.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  discoverComponents,
  discoverLayoutsInPath,
  loadFoundationConfig,
  DEFAULT_SECTION_PATHS,
  LAYOUTS_PATH
} from './schema.js'
import { extractAllRuntimeSchemas, extractAllLayoutRuntimeSchemas, extractFoundationRuntime } from './runtime-schema.js'
import { SCHEMA_EXTENSIONS } from './resolve-data-schema.js'

/**
 * The files a foundation's data schemas are read from, relative to its source root:
 * `@/name` is `schemas/name.<ext>` (`resolve-data-schema.js::findSelfSchemaFile`), and
 * `schemas.config.js` says where a scope's schemas live (`loadSchemaAliases`).
 */
const SCHEMAS_PATH = 'schemas'
const SCHEMA_ALIASES_FILE = 'schemas.config.js'

/**
 * Packages that may be bundled inside a foundation but require single-instance
 * access from a host environment (currently: unipress). When a foundation
 * declares any of these as a dependency, we re-export the named symbols
 * from the generated entry so the host can reach the foundation's bundled
 * copy instead of importing its own — avoiding the dual-instance trap
 * (each side gets its own React.createContext, registrations land in a
 * context the other side can't see).
 *
 * Detection is by `dependencies` / `peerDependencies` declaration. Vite
 * would fail to resolve an undeclared bare import anyway, so "declared"
 * and "imported" stay aligned in practice. A foundation that declares one
 * of these and never actually imports it pays the cost of bundling it (the
 * re-export keeps the symbols alive) — minor and easily fixed by removing
 * the unused dep.
 *
 * The export list is a public-API contract: removing a symbol here breaks
 * hosts compiled against older built foundations that re-exported it. Add
 * conservatively.
 */
const HOST_SHAREABLE_PACKAGES = {
  '@uniweb/press': ['compileSubtree', 'compileDocument']
}

/**
 * Detect which HOST_SHAREABLE_PACKAGES the foundation declares as a dep.
 * Reads the foundation's own package.json (one level above srcDir).
 * Returns [] if package.json is missing or unreadable.
 */
async function detectHostShareableImports(srcDir) {
  const packages = Object.keys(HOST_SHAREABLE_PACKAGES)
  if (packages.length === 0) return []

  const pkgPath = join(dirname(srcDir), 'package.json')
  if (!existsSync(pkgPath)) return []

  let pkg
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
  } catch {
    return []
  }

  const declared = { ...pkg.dependencies, ...pkg.peerDependencies }
  return packages.filter(p => p in declared)
}

/**
 * The foundation's `main.js` — its declarations, read by `loadFoundationConfig` as the schema
 * reads them. `main.js` is the only name: ⛔ until 2026-10-01 this also took a `main.jsx`, which
 * nothing else read, so the editor saw none of its declarations while the runtime saw all of them.
 */
function detectFoundationExports(srcDir) {
  return existsSync(join(srcDir, 'main.js')) ? { path: './main.js', ext: 'js' } : null
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
    foundationRuntime = { code: [], data: {} },
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

  // The foundation's `main.js` — imported for the code the runtime calls, and only referenced for
  // it, so the bundler drops the rest of its default export (measured 2026-10-01). With no such
  // code, imported for its side effects alone. Its data is written below, lean.
  if (foundationExports) {
    lines.push(
      foundationRuntime.code.length > 0
        ? `import * as _foundationModule from '${foundationExports.path}'`
        : `import '${foundationExports.path}'`
    )
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

  // Foundation capabilities — what the runtime reads of `main.js`, and nothing else of it
  // (`extractFoundationRuntime`, ruled 2026-10-01 [Diego]): the code it calls, referenced from the
  // module, and its data as a lean literal — `vars` (each var's `default`, `type`, `applyTo`, as
  // `loadFoundationConfig` reads them, named export first), `data` (each key's schema ref), and the
  // defaults that pick a layout, a section type, transitions and scroll. Plus the discovered layouts.
  // ⛔ Until 2026-10-01 the whole default export was spread in, so a foundation's name, description
  // and its vars' descriptions shipped in every published bundle.
  lines.push('')
  if (foundationExports || layoutNames.length > 0) {
    const capParts = []
    if (foundationExports) {
      for (const key of foundationRuntime.code) capParts.push(`${key}: _foundationModule.default?.${key}`)
      for (const [key, value] of Object.entries(foundationRuntime.data)) capParts.push(`${key}: ${JSON.stringify(value)}`)
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

  // Per-layout runtime metadata (transitions, layers, scroll, defaults)
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

  // The foundation's `main.js`, and what the runtime reads of it — read as the schema reads it
  // (`loadFoundationConfig`: the named `vars` first, JSX imports transpiled), so the editor and the
  // runtime see one declaration.
  // Asked even with no main.js: it refuses a `foundation.js` or `main.jsx` left in its place.
  const foundationExports = detectFoundationExports(srcDir)
  const foundationConfig = await loadFoundationConfig(srcDir)
  const foundationRuntime = foundationExports ? extractFoundationRuntime(foundationConfig) : { code: [], data: {} }

  // Per-component runtime metadata. ⭐ No data schema is resolved for it: the runtime reads a
  // declared key's ref and nothing of its shape (2026-10-05), so the entry no longer depends on
  // a schema file — `schema.js` resolves them, for schema.json, and a missing one stops the
  // build there. ⛔ Until then the entry carried each key's field defaults, resolved here, and a
  // foundation-tier `data:` key got none, having no per-component place to put them.
  const meta = extractAllRuntimeSchemas(components)

  // Extract per-layout runtime metadata from meta.js files
  const layoutMeta = extractAllLayoutRuntimeSchemas(layouts)

  // Detect which host-shareable packages the foundation imports
  const hostShareableImports = await detectHostShareableImports(srcDir)

  // Generate source
  const source = generateEntrySource(components, {
    cssPath,
    foundationExports,
    foundationRuntime,
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
    foundationRuntime,
    meta,
    layoutMeta,
    hostShareableImports,
  }
}

/** Normalize native path separators so matching is platform-independent. */
const toPosix = path => path.replace(/\\/g, '/')

/**
 * Structural paths worth watching, given a foundation source root.
 *
 * Lives next to `shouldRegenerateForFile` so the watch surface and the match
 * predicate stay in sync — anything this returns is a path that predicate can
 * match, and nothing it matches lies outside these paths.
 *
 * Derived from the same discovery constants `generateEntryPoint` scans, and
 * takes the same `sectionPaths` override, so a foundation that declares extra
 * search paths via `defineFoundationConfig({ sections })` is watched wherever
 * its sections actually live. Foundation folder layout is free-form — `src/`,
 * `foundations/blog/`, `marketing/src/` — but every path here is relative to
 * the resolved source root, so layout does not matter.
 *
 * Deliberately does NOT include the source root itself. Under the flat layout
 * (`main: "./_entry.generated.js"`) the source root IS the foundation package
 * root, so handing it to a watcher pulls in `node_modules/`, `dist/` and
 * `.git/` — thousands of directories, and on Linux one inotify watch each.
 *
 * @param {string} srcDir - Foundation source directory (absolute)
 * @param {Object} [options]
 * @param {string[]} [options.sectionPaths] - Section search paths (relative to srcDir)
 * @returns {string[]} Absolute paths to hand to a watcher
 */
export function getStructuralWatchPaths(srcDir, options = {}) {
  const { sectionPaths = DEFAULT_SECTION_PATHS } = options

  const rootFiles = [
    'meta.js',
    'main.js',
    'main.jsx',
    'styles.css',
    'index.css',
    SCHEMA_ALIASES_FILE
  ]

  return [
    ...sectionPaths.map(path => join(srcDir, path)),
    join(srcDir, LAYOUTS_PATH),
    join(srcDir, SCHEMAS_PATH),
    ...rootFiles.map(file => join(srcDir, file))
  ]
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
 * The bare-file and entry-file rules below are scoped to the primary `sections`
 * path on purpose: that is the only path where relaxed discovery applies.
 * Additional paths declared via `defineFoundationConfig({ sections })` use
 * strict discovery, where a section is only registered once it has a `meta.js`
 * — and the "meta.js anywhere" rule already covers those. Widening the bare-file
 * rule to every configured path would fire on files discovery ignores.
 *
 * @param {string} file - Absolute path of the changed file
 * @param {string} srcDir - Foundation source directory (absolute)
 * @returns {string|null} Reason string if regeneration needed, null otherwise
 */
export function shouldRegenerateForFile(file, srcDir) {
  // Both sides arrive with native separators — chokidar normalizes the paths it
  // emits with path.normalize() on Windows, and srcDir comes from path.resolve().
  // Comparing against a hardcoded '/' silently matched nothing on Windows, so
  // entry regeneration never fired there and new sections needed a dev restart.
  const normalized = toPosix(file)
  const base = toPosix(srcDir).replace(/\/+$/, '')

  if (!normalized.startsWith(base + '/')) return null

  const rel = normalized.slice(base.length + 1)

  // meta.js anywhere — affects runtime metadata
  if (rel.endsWith('/meta.js') || rel === 'meta.js') {
    return 'meta.js changed'
  }

  // main.js / main.jsx at root —
  // the authored declarations file affects the capabilities import.
  if (/^(main|foundation)\.(js|jsx)$/.test(rel)) {
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

  // The foundation's data schemas — `schemas/<name>.<ext>` and `schemas.config.js`.
  // ⚠️ The entry holds nothing read from one since 2026-10-05 (no field defaults), so
  // regenerating it changes nothing. The match stays for the dev rebuild of a
  // runtime-linked foundation (`dev/plugin.js`), which also writes the editor's
  // schema.json — whose `dataSchemas` a schema change does move.
  if (rel.startsWith(`${SCHEMAS_PATH}/`)) {
    const inner = rel.slice(SCHEMAS_PATH.length + 1)
    if (!inner.includes('/') && SCHEMA_EXTENSIONS.some(ext => inner.endsWith(ext))) {
      return `data schema: ${inner}`
    }
  }
  if (rel === SCHEMA_ALIASES_FILE) {
    return 'schema aliases changed'
  }

  return null
}
