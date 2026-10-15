/**
 * The `process.env.NODE_ENV` define a foundation build needs — a leaf, so the
 * browser build (`foundation/config.js`) and the SSR twin
 * (`vite-foundation-plugin.js::buildEntrySSR`) share one definition.
 */

/**
 * Replace `process.env.NODE_ENV` in the foundation bundle.
 *
 * Library mode replaces `import.meta.env.*` and deliberately leaves
 * `process.env.*` alone, so a bundled CommonJS dependency that branches on
 * `process.env.NODE_ENV` (common in the React ecosystem) ships the read as
 * written — and a browser, which has no `process`, throws
 * `ReferenceError: process is not defined` when the foundation loads, so the
 * site renders nothing. A foundation is a browser module, never a library a
 * consumer re-bundles, so the read is resolved here, from the build's mode.
 *
 * An author's own `define` for the key wins: it is left untouched.
 */
export function nodeEnvDefine() {
  const KEY = 'process.env.NODE_ENV'
  return {
    name: 'uniweb:foundation-node-env',
    config(config, { mode }) {
      if (config.define && KEY in config.define) return
      const value = mode === 'development' ? 'development' : 'production'
      return { define: { [KEY]: JSON.stringify(value) } }
    }
  }
}
