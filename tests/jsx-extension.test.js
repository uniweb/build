/**
 * JSX compiles only in .jsx and .tsx files — and a .js file holding it now fails saying so
 * (src/jsx-extension.js, ruled 2026-10-11).
 *
 * Until then the build stopped at Vite's bare "Expression expected", although section
 * discovery accepts a `.js` component: measured on a fresh project, `sections/Section/index.js`
 * with the starter's JSX was found as a section type and then failed the foundation build.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, parseAst } from 'vite'
import { jsxExtensionGuard, jsxInJsMessage } from '../src/jsx-extension.js'

const ROOT = '/proj/src'

/** Run the guard's transform as Vite would: its parser, and an error that throws. */
function guard(code, id) {
  const plugin = jsxExtensionGuard()
  plugin.configResolved({ root: ROOT })
  let parsed = 0
  const ctx = {
    parse(source) {
      parsed++
      return parseAst(source)
    },
    error(message, pos) {
      throw Object.assign(new Error(message), { pos })
    },
  }
  const run = () => plugin.transform.call(ctx, code, id)
  return { run, parsed: () => parsed }
}

const JSX_COMPONENT = `import { Link } from '@uniweb/kit'\nexport default function Hero() {\n  return <section><Link to="/">Home</Link></section>\n}\n`

describe('jsxExtensionGuard', () => {
  it('names the fix for a .js component with JSX, at the position of the JSX', () => {
    const { run } = guard(JSX_COMPONENT, `${ROOT}/sections/Hero/index.js`)
    let error
    try { run() } catch (e) { error = e }
    expect(error?.message).toBe('JSX compiles only in .jsx and .tsx files — rename index.js to index.jsx.')
    // Vite prints the file and line:col from the position: line 3 is the <section>.
    expect(JSX_COMPONENT.slice(0, error.pos).split('\n').length).toBe(3)
    expect(JSX_COMPONENT[error.pos]).toBe('<')
  })

  it('tells main.js to move its component out — it cannot be renamed', () => {
    const { run } = guard(`const Ref = () => <i />\nexport default { defaultInsets: { Ref } }\n`, `${ROOT}/main.js`)
    expect(run).toThrow(/main\.js is plain JavaScript: move the component into a \.jsx file and import it\./)
  })

  it('stays silent on a .js file whose < is a comparison', () => {
    const { run, parsed } = guard(`export const lt = (a, b) => a < b\n`, `${ROOT}/utils.js`)
    expect(run()).toBeNull()
    expect(parsed()).toBe(1)
  })

  it('leaves any other syntax error to Vite', () => {
    const { run } = guard(`export const lt = (a, b) => a < b\nconst x = 1 +\n`, `${ROOT}/utils.js`)
    expect(run()).toBeNull()
  })

  it('does not parse a .jsx file, a file with no <, or a dependency', () => {
    for (const [code, id] of [
      [JSX_COMPONENT, `${ROOT}/sections/Hero/index.jsx`],
      [`export const a = 1\n`, `${ROOT}/plain.js`],
      [JSX_COMPONENT, `/proj/node_modules/some-lib/index.js`],
    ]) {
      const { run, parsed } = guard(code, id)
      expect(run()).toBeNull()
      expect(parsed()).toBe(0)
    }
  })

  it('reads the file past a query string', () => {
    const { run } = guard(JSX_COMPONENT, `${ROOT}/sections/Hero/index.js?v=3f2a`)
    expect(run).toThrow(/rename index\.js to index\.jsx/)
  })
})

describe('jsxInJsMessage', () => {
  it('states the rule and the fix, and leaves the location to its caller', () => {
    expect(jsxInJsMessage('insets/Ref.js')).toBe('JSX compiles only in .jsx and .tsx files — rename Ref.js to Ref.jsx.')
    expect(jsxInJsMessage('main.js')).toMatch(/^JSX compiles only in \.jsx and \.tsx files, and main\.js is plain JavaScript/)
  })
})

describe('in a real Vite build', () => {
  const dirs = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  function project(files) {
    const dir = mkdtempSync(join(tmpdir(), 'uniweb-jsx-ext-'))
    dirs.push(dir)
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return dir
  }

  const viteBuild = (dir, plugins) =>
    build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins,
      build: { write: false, lib: { entry: join(dir, 'index.js'), formats: ['es'], fileName: 'out' } },
    })

  it('CONTROL — without the guard, the build stops at a parse error that never says JSX', async () => {
    const dir = project({ 'index.js': `export { Comp } from './Comp.js'\n`, 'Comp.js': `export const Comp = () => <b>hi</b>\n` })
    await expect(viteBuild(dir, [])).rejects.toThrow(/Expression expected/)
  })

  it('with the guard, the same build says which file holds JSX and what to rename it to', async () => {
    const dir = project({ 'index.js': `export { Comp } from './Comp.js'\n`, 'Comp.js': `export const Comp = () => <b>hi</b>\n` })
    await expect(viteBuild(dir, [jsxExtensionGuard()])).rejects.toThrow(/JSX compiles only in \.jsx and \.tsx files — rename Comp\.js to Comp\.jsx/)
  })

  it('with the guard, a build with comparisons and no JSX succeeds', async () => {
    const dir = project({ 'index.js': `export const lt = (a, b) => a < b\nexport const gt = (a, b) => a > b\n` })
    await expect(viteBuild(dir, [jsxExtensionGuard()])).resolves.toBeDefined()
  })
})
