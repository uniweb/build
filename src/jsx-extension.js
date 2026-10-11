/**
 * JSX compiles only in `.jsx` and `.tsx` files — in a foundation's Vite build, in a
 * site build that bundles its foundation, and in the step that reads `main.js`
 * (`schema.js`, `importFoundationConfig`).
 *
 * ⭐ THE RULE, SAID WHERE IT FAILS. A `.js` file holding JSX fails each of those with a
 * parser's message that never says why — Vite's "Expression expected", esbuild's "The JSX
 * syntax extension is not currently enabled" — and section discovery accepts `.js`
 * components, which build only without JSX. Ruled 2026-10-11: JSX stays in `.jsx` files,
 * and the failure names the file and the fix.
 */

import { basename, relative } from 'node:path'

const JS_FILE = /\.m?js$/

/**
 * What to tell an author whose `.js` file holds JSX — the rule and the fix, without the
 * location, which each caller states its own way (Vite prefixes `file (line:col):`).
 *
 * @param {string} file - the file holding JSX
 * @returns {string}
 */
export function jsxInJsMessage(file) {
  const name = basename(file)
  // `main.js` is the one name a foundation's declarations are read from, so it cannot
  // become `main.jsx`: its components move out instead.
  if (name === 'main.js') {
    return 'JSX compiles only in .jsx and .tsx files, and main.js is plain JavaScript: move the component into a .jsx file and import it.'
  }
  return `JSX compiles only in .jsx and .tsx files — rename ${name} to ${name.replace(JS_FILE, '.jsx')}.`
}

/**
 * A Vite plugin that turns a parse failure on JSX in a `.js` file into
 * {@link jsxInJsMessage}. Silent otherwise: a file that parses, or fails for any other
 * reason, is left to Vite. A file under `node_modules` is skipped — the advice is for files
 * the author can rename.
 *
 * It parses only a project `.js` file that contains a `<`, and the failure it reports is the
 * one the build would hit next: the parser stopped at that `<`.
 *
 * @returns {import('vite').Plugin}
 */
export function jsxExtensionGuard() {
  let root = process.cwd()
  return {
    name: 'uniweb-jsx-extension',
    enforce: 'pre',
    configResolved(config) {
      root = config.root
    },
    transform(code, id) {
      const file = id.split('?')[0]
      if (!JS_FILE.test(file) || file.includes('/node_modules/') || !code.includes('<')) return null
      if (typeof this.parse !== 'function') return null
      try {
        this.parse(code)
      } catch (error) {
        const pos = error?.pos
        if (typeof pos === 'number' && code[pos] === '<') {
          this.error(jsxInJsMessage(relative(root, file)), pos)
        }
      }
      return null
    },
  }
}
