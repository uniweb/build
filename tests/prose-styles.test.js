/**
 * Prose without its stylesheet — `src/foundation/prose-styles.js`.
 *
 * The module half reads kit's REAL files, as `derive-supports.test.js` does: if kit moves or
 * renames `<Prose>`, the first test goes red at the commit that does it, instead of the warning
 * going quiet. The CSS half needs no real compile — the rule is a `.prose` selector's presence —
 * and the end-to-end measurement (a real foundation build with and without
 * `@uniweb/kit/prose-tokens.css`) is recorded in the framework kb, 2026-09-29.
 */

import { describe, test, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProseModule, proseWithoutStyles } from '../src/foundation/prose-styles.js'

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROSE = join(FRAMEWORK, 'kit/src/styled/Prose/index.jsx')
const RENDER = join(FRAMEWORK, 'kit/src/styled/Render/index.jsx')

/** A bundle as `writeBundle` receives it: one chunk, and CSS assets. */
function bundleOf({ modules = {}, css = [] }) {
  const bundle = { 'entry.js': { type: 'chunk', fileName: 'entry.js', modules } }
  css.forEach((source, i) => {
    bundle[`assets/style${i}.css`] = { type: 'asset', fileName: `assets/style${i}.css`, source }
  })
  return bundle
}

describe('which module is kit’s <Prose>', () => {
  test('the real Prose file is recognized, wherever kit resolves from', () => {
    expect(existsSync(PROSE)).toBe(true)
    expect(isProseModule(PROSE)).toBe(true)
    expect(isProseModule('/app/node_modules/@uniweb/kit/src/styled/Prose/index.jsx')).toBe(true)
  })

  test('CONTROL — kit’s Render, which Prose wraps, is not Prose', () => {
    expect(existsSync(RENDER)).toBe(true)
    expect(isProseModule(RENDER)).toBe(false)
  })
})

describe('when a foundation build warns', () => {
  const rendered = { [PROSE]: { renderedLength: 1200 }, [RENDER]: { renderedLength: 9000 } }

  test('Prose rendered, and no .prose rule in the CSS — warn', () => {
    expect(proseWithoutStyles(bundleOf({ modules: rendered, css: ['.flex{display:flex}'] }))).toBe(true)
  })

  test('Prose rendered, and no CSS emitted at all — warn', () => {
    expect(proseWithoutStyles(bundleOf({ modules: rendered }))).toBe(true)
  })

  test('Prose rendered, and the typography plugin’s rules in the CSS — silent', () => {
    const css = '.prose{color:var(--tw-prose-body)}.prose :where(ul):not(:where([class~="not-prose"] *)){list-style-type:disc}'
    expect(proseWithoutStyles(bundleOf({ modules: rendered, css: ['.flex{display:flex}', css] }))).toBe(false)
  })

  test('Prose imported but tree-shaken away — silent: importing kit is not rendering Prose', () => {
    const modules = { [PROSE]: { renderedLength: 0 }, [RENDER]: { renderedLength: 9000 } }
    expect(proseWithoutStyles(bundleOf({ modules, css: ['.flex{display:flex}'] }))).toBe(false)
  })

  test('a CSS asset delivered as bytes is read too', () => {
    const bytes = new TextEncoder().encode('.prose{max-width:65ch}')
    expect(proseWithoutStyles(bundleOf({ modules: rendered, css: [bytes] }))).toBe(false)
  })
})
