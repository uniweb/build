/**
 * Marks a foundation build as a DEV-server rebuild — a leaf, so the foundation
 * build plugin (`vite-foundation-plugin.js`), the dev server that injects the
 * marker (`dev/plugin.js`) and the scope define (`scope-define.js`) share it.
 *
 * The dev server runs a real Vite `build()` of the foundation on every watched
 * change (`dev/plugin.js`), so `command`, `mode` and `isProduction` cannot tell
 * a dev rebuild from a shipping build — all of them say "build". An injected
 * marker plugin can, and it survives the foundation's own `vite.config.js`
 * being merged in, which a plugin *option* would not (the dev server does not
 * construct the foundation plugin — the foundation's config file does).
 *
 * Used to skip the `entry-ssr.js` sub-build in dev: it is a second full Vite
 * pass per save, and nothing in the dev loop reads it (dev never ships, and the
 * SSR lanes that run locally — SSG prerender and unipress — load `entry.js`).
 * And to build the foundation as a working copy, as `uniweb dev` serves it in
 * bundled mode: its `@/x` stays as written (`scope-define.js`).
 */
export const DEV_REBUILD_MARKER = 'uniweb:dev-foundation-rebuild'

/**
 * Whether a Vite config carries the marker — read in a `config` hook, where
 * `plugins` is still the array as written (nested, with falsy entries), or
 * once resolved.
 *
 * @param {{ plugins?: unknown[] }} config
 * @returns {boolean}
 */
export function hasDevRebuildMarker(config) {
  return (config?.plugins || []).flat(Infinity).some((p) => p?.name === DEV_REBUILD_MARKER)
}
