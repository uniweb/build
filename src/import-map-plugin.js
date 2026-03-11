/**
 * Import Map Plugin
 *
 * Shared Vite plugin that emits import-map bridge modules so that
 * foundations loaded via dynamic import() can resolve bare specifiers
 * (react, @uniweb/core, etc.) to the same instances used by the host app.
 *
 * Production: emits deterministic chunks at _importmap/*.js with explicit
 * named re-exports, and injects a <script type="importmap"> into the HTML.
 *
 * Used by:
 * - Site builds (runtime mode + extensions)  — packages/build/src/site/config.js
 * - Runtime shell build                      — packages/runtime/vite.config.app.js
 * - Dynamic-runtime (editor preview)         — packages/uniweb-editor/dynamic-runtime/
 *
 * @module @uniweb/build/import-map-plugin
 */

/** Default externals shared between foundations and hosts */
const DEFAULT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@uniweb/core',
]

const IMPORT_MAP_PREFIX = '\0importmap:'

/** Valid JS identifier — filters out non-identifier keys from CJS modules */
const isValidId = (k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)

/**
 * Create the import map Vite plugin.
 *
 * @param {Object} [options]
 * @param {string[]} [options.externals] - Package specifiers to bridge (default: react, react-dom, @uniweb/core, etc.)
 * @param {string} [options.name] - Plugin name (default: 'uniweb:import-map')
 * @param {string} [options.basePath] - Base path prefix for import map URLs in HTML (default: '/')
 * @param {string} [options.resolveFrom] - Absolute path to resolve bare specifiers from inside virtual modules.
 *   Needed when the host project doesn't have the externals as direct dependencies (e.g., site builds
 *   under pnpm strict mode resolve from the foundation directory instead).
 * @param {Object} [options.devBridges] - Map of specifier → dev-mode URL for import map injection in dev.
 *   When provided, the import map is injected in both dev and prod (with different URLs).
 *   When omitted, the import map is only injected in prod (dev uses other mechanisms like transformRequest).
 * @returns {import('vite').Plugin}
 */
export function importMapPlugin({
  externals = DEFAULT_EXTERNALS,
  name = 'uniweb:import-map',
  basePath = '/',
  resolveFrom,
  devBridges,
} = {}) {
  let isBuild = false

  return {
    name,

    configResolved(config) {
      isBuild = config.command === 'build'
    },

    resolveId(id, importer) {
      if (id.startsWith(IMPORT_MAP_PREFIX)) return id
      // Bare specifiers inside our virtual modules (e.g. '@uniweb/core' re-exported
      // from '\0importmap:@uniweb/core') can't be resolved by Rollup because virtual
      // modules have no filesystem context. When a resolveFrom path is provided,
      // resolve from there (e.g. the foundation directory under pnpm strict mode).
      if (resolveFrom && importer?.startsWith(IMPORT_MAP_PREFIX) && externals.includes(id)) {
        return this.resolve(id, resolveFrom, { skipSelf: true })
      }
    },

    async load(id) {
      if (!id.startsWith(IMPORT_MAP_PREFIX)) return
      const pkg = id.slice(IMPORT_MAP_PREFIX.length)

      // Generate explicit named re-exports (not `export *`) because CJS
      // packages like React only expose a default via `export *`, losing
      // individual named exports (useState, jsx, etc.) that foundations need.
      try {
        const mod = await import(pkg)
        const names = Object.keys(mod).filter((k) => k !== '__esModule' && isValidId(k))
        const hasDefault = 'default' in mod
        const named = names.filter((k) => k !== 'default')
        const lines = []
        if (named.length) {
          lines.push(`export { ${named.join(', ')} } from '${pkg}'`)
        }
        if (hasDefault) {
          lines.push(`export { default } from '${pkg}'`)
        }
        return lines.join('\n') || 'export {}'
      } catch {
        // Fallback: generic re-export (may not preserve named exports for CJS)
        return `export * from '${pkg}'`
      }
    },

    // Emit deterministic chunks for each external (production only).
    // preserveSignature: 'exports-only' tells Rollup to preserve the original
    // export names (useState, jsx, etc.) instead of mangling them.
    buildStart() {
      if (!isBuild) return
      for (const ext of externals) {
        this.emitFile({
          type: 'chunk',
          id: `${IMPORT_MAP_PREFIX}${ext}`,
          fileName: `_importmap/${ext.replace(/\//g, '-')}.js`,
          preserveSignature: 'exports-only',
        })
      }
    },

    // Inject the import map into the HTML.
    // In prod: always injects with basePath-prefixed _importmap/ URLs.
    // In dev: only injects if devBridges are provided (otherwise, the consumer
    //   handles dev-mode resolution via other mechanisms like transformRequest).
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const imports = {}

        if (isBuild) {
          for (const ext of externals) {
            imports[ext] = `${basePath}_importmap/${ext.replace(/\//g, '-')}.js`
          }
        } else if (devBridges) {
          Object.assign(imports, devBridges)
        } else {
          // No dev injection — consumer handles dev mode separately
          return html
        }

        const importMap = JSON.stringify({ imports }, null, 2)
        const script = `    <script type="importmap">\n${importMap}\n    </script>\n`
        // Import map must appear before any module scripts
        return html.replace('<head>', '<head>\n' + script)
      },
    },
  }
}

export { DEFAULT_EXTERNALS }
