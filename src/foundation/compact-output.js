import { hasDevRebuildMarker } from './dev-rebuild.js'

/**
 * A foundation's built code has no whitespace or comments in it.
 *
 * Vite minifies a library's names and syntax but keeps its whitespace and comments, on purpose: a
 * library is read by the next bundler, which needs its `@__PURE__` annotations. A foundation has no
 * next bundler. A browser loads `entry.js` and a request-time host loads `entry-ssr.js` as they are,
 * and a site that bundles its foundation builds it from source. So all that text went to every
 * visitor: 130 KB of a 345 KB entry, on a real foundation (measured 2026-10-30).
 *
 * Legal comments stay, as they do in anything else Vite minifies.
 *
 * ⛔ `order: 'post'` on the hook, not `enforce: 'post'` on the plugin. Vite's own esbuild pass runs
 * after every plugin, `enforce: 'post'` included, and it prints the whitespace back.
 *
 * A dev rebuild (`dev-rebuild.js`) is left readable, and keeps the reference to its map for the
 * browser's devtools. A build that ships has no use for the reference: `register` uploads no maps,
 * so it would name a file that is not there.
 */
export function compactOutput() {
  let compact = false
  return {
    name: 'uniweb:foundation-compact-output',
    apply: 'build',
    config(config) {
      if (hasDevRebuildMarker(config) && config.build?.sourcemap === 'hidden') {
        return { build: { sourcemap: true } }
      }
    },
    configResolved(config) {
      compact = config.build.minify !== false && !hasDevRebuildMarker(config)
    },
    renderChunk: {
      order: 'post',
      async handler(code, chunk, output) {
        if (!compact) return null
        const { transformWithEsbuild } = await import('vite')
        const result = await transformWithEsbuild(code, chunk.fileName, {
          loader: 'js',
          charset: 'utf8',
          minifyWhitespace: true,
          sourcemap: Boolean(output.sourcemap),
        })
        return { code: result.code, map: result.map }
      },
    },
  }
}
