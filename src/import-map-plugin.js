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
  'react-dom/server',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@uniweb/core',
]

const IMPORT_MAP_PREFIX = '\0importmap:'

/** Valid JS identifier — filters out non-identifier keys from CJS modules */
const isValidId = (k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)

/**
 * An external may be a bare specifier string, or an object declaring its
 * surface explicitly.
 *
 * ⛔ WHY THE OBJECT FORM EXISTS — read before "simplifying" it away.
 *
 * The string form enumerates a module's exports by `await import(pkg)` in the
 * Vite process, i.e. in NODE. That works for plain `.js`, and **throws for
 * anything reached through a `.jsx` file** — Node cannot parse JSX. The catch
 * below then falls back to `export * from pkg`, and `export *` **never
 * re-exports `default`**. So a bridged module whose public surface IS its
 * default export silently emits a bridge with that export missing.
 *
 * Measured 2026-08-08 on `@uniweb/runtime/provider` (whose only export is
 * `export default function RuntimeProvider`): the fallback produced ZERO
 * exports, so Rollup reused the emitted filename as a shared chunk and the
 * "bridge" shipped containing `ErrorBoundary` instead. The file existed, the
 * manifest listed it, the channel published it and its digests verified — and
 * `import RuntimeProvider from '<bridge>'` throws "does not provide an export
 * named 'default'". Nothing upstream of the browser could see it.
 *
 * `hasDefault` is what `export *` cannot express, so it is the one thing worth
 * declaring. Named exports stay self-maintaining through `export *`.
 *
 * @typedef {string | { spec: string, hasDefault?: boolean, named?: string[] }} External
 */
const specOf = (e) => (typeof e === 'string' ? e : e.spec)

/**
 * The bridge filename for a specifier: `@uniweb/runtime/provider` →
 * `@uniweb-runtime-provider.js`.
 *
 * Exported because THREE producers must agree on it — the emitted chunk, the
 * `<script type="importmap">`, and the runtime shell's `manifest.json`. A
 * consumer resolves a bridge by the manifest's URL, so a manifest that names a
 * file the build did not emit is a 404 at import time, not a build error.
 */
export const bridgeFileName = (spec) => `${spec.replace(/\//g, '-')}.js`

/**
 * Create the import map Vite plugin.
 *
 * @param {Object} [options]
 * @param {External[]} [options.externals] - Specifiers to bridge (default: react, react-dom, @uniweb/core, etc.).
 *   Each entry is a bare specifier string, or `{ spec, hasDefault?, named? }` when the module's
 *   surface cannot be enumerated by importing it in Node — see the `External` typedef.
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
      if (resolveFrom && importer?.startsWith(IMPORT_MAP_PREFIX) && externals.some((e) => specOf(e) === id)) {
        return this.resolve(id, resolveFrom, { skipSelf: true })
      }
    },

    async load(id) {
      if (!id.startsWith(IMPORT_MAP_PREFIX)) return
      const pkg = id.slice(IMPORT_MAP_PREFIX.length)
      const declared = externals.find((e) => specOf(e) === pkg)

      // A declared surface wins outright — no Node import is attempted, so a
      // JSX-reaching module is bridged correctly instead of falling into the
      // lossy catch below. See the `External` typedef for why this exists.
      if (typeof declared === 'object' && (declared.named || declared.hasDefault !== undefined)) {
        const lines = []
        if (declared.named?.length) {
          lines.push(`export { ${declared.named.join(', ')} } from '${pkg}'`)
        } else {
          // Named exports stay self-maintaining; only `default` is declared.
          lines.push(`export * from '${pkg}'`)
        }
        if (declared.hasDefault) {
          lines.push(`export { default } from '${pkg}'`)
        }
        return lines.join('\n')
      }

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
      } catch (err) {
        // Loud, because this fallback CANNOT carry a default export. Staying
        // silent here is what let a bridge ship with its only export missing
        // (see the `External` typedef). If the module has a default, declare
        // `{ spec, hasDefault: true }`; if it genuinely has none, declare
        // `{ spec, hasDefault: false }` to assert that and silence this.
        this.warn(
          `[import-map] could not enumerate "${pkg}" (${err.message.split('\n')[0]}). ` +
            `Falling back to \`export *\`, which DROPS a default export. ` +
            `Declare it as { spec: '${pkg}', hasDefault: true|false } to be explicit.`
        )
        return `export * from '${pkg}'`
      }
    },

    // Emit deterministic chunks for each external (production only).
    // preserveSignature: 'exports-only' tells Rollup to preserve the original
    // export names (useState, jsx, etc.) instead of mangling them.
    buildStart() {
      if (!isBuild) return
      for (const ext of externals) {
        const spec = specOf(ext)
        this.emitFile({
          type: 'chunk',
          id: `${IMPORT_MAP_PREFIX}${spec}`,
          fileName: `_importmap/${bridgeFileName(spec)}`,
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
            const spec = specOf(ext)
            imports[spec] = `${basePath}_importmap/${bridgeFileName(spec)}`
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
