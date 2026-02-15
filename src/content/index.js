/**
 * Clean Content Entry Point
 *
 * Exposes only collectSiteContent and its clean dependency chain
 * (Node builtins, js-yaml, @uniweb/theming). No Vite, sharp, or React.
 *
 * Used by Studio's sidecar (Bun-compiled binary) where those heavy
 * peer/native dependencies aren't available.
 *
 * @module @uniweb/build/content
 */

export { collectSiteContent } from '../site/content-collector.js'
