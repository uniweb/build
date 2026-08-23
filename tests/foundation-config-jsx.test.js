/**
 * Regression: a foundation config that imports JSX must still load.
 *
 * `defaultInsets` and `xref` take REACT COMPONENTS — that is their purpose —
 * so a real `main.js` imports `.jsx`, and a bare Node `import()` throws
 * `Unknown file extension ".jsx"`. That failure used to be swallowed into a
 * `console.warn` and a `{}` return, which silently stripped EVERY foundation
 * declaration: vars, xref, defaultInsets, name.
 *
 * The visible symptom was a themeless site — `px-[var(--section-padding-x)]`
 * computing to 0 and `max-w-[var(--width-content)]` to `none`, so content ran
 * edge to edge — with nothing in the build output naming a cause. Measured
 * 2026-08-23 on a site that had shipped that way for three weeks.
 *
 * Fixtures live inside this package rather than os.tmpdir() because esbuild
 * leaves `react/jsx-runtime` external, so the emitted module has to resolve it
 * from a real node_modules — exactly as a foundation inside a project does.
 *
 * ⛔ THE JSX CASES MUST RUN IN A REAL NODE PROCESS. Vitest transforms dynamic
 * imports through its own esbuild pipeline, so under the test runner a bare
 * `import('./Ref.jsx')` SUCCEEDS and the bug is invisible — these tests passed
 * against the unfixed loader until they were moved out-of-process. What is
 * being tested is Node's ESM loader, so Node has to be the one loading.
 */

const SCHEMA = resolve(fileURLToPath(import.meta.url), '../../src/schema.js')

/** Load a fixture through the real Node ESM loader, not vitest's. */
function loadInRealNode(dir) {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { loadFoundationConfig } = await import(${JSON.stringify(SCHEMA)});
       try { process.stdout.write(JSON.stringify({ ok: true, cfg: await loadFoundationConfig(${JSON.stringify(dir)}) },
         (k, v) => (typeof v === 'function' ? '[fn]' : v))) }
       catch (e) { process.stdout.write(JSON.stringify({ ok: false, message: e.message })) }`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out)
}

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { loadFoundationConfig } from '../src/schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dirs = []

function fixture(files) {
  const dir = mkdtempSync(join(HERE, 'tmp-fnd-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fnd', type: 'module' }))
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const VARS = `export const vars = {
  'width-content': { default: '1000px' },
  'section-padding-x': { default: '1.5rem' },
}`

describe('loadFoundationConfig with a JSX import', () => {
  it('loads a config whose graph contains real JSX', async () => {
    const dir = fixture({
      'Ref.jsx': `export const Ref = ({ label }) => <span className="ref">{label}</span>`,
      'main.js': `import { Ref } from './Ref.jsx'\n${VARS}\nexport default { name: 'JsxFoundation', defaultInsets: { Ref } }`,
    })

    const { ok, cfg, message } = loadInRealNode(dir)

    // The whole point: the declarations survive.
    expect(ok, message).toBe(true)
    expect(cfg.name).toBe('JsxFoundation')
    expect(Object.keys(cfg.vars)).toEqual(['width-content', 'section-padding-x'])
    expect(cfg.vars['width-content']).toEqual({ default: '1000px' })
    expect(Object.keys(cfg.defaultInsets)).toEqual(['Ref'])
  })

  it('leaves no temp artifact behind after the bundled fallback', async () => {
    const dir = fixture({
      'Ref.jsx': `export const Ref = () => <i />`,
      'main.js': `import { Ref } from './Ref.jsx'\n${VARS}\nexport default { defaultInsets: { Ref } }`,
    })

    expect(loadInRealNode(dir).ok).toBe(true)

    expect(readdirSync(dir).filter((f) => f.includes('uniweb-config'))).toEqual([])
  })

  it('takes the fast path for a plain config — no bundle, no artifact', async () => {
    const dir = fixture({ 'main.js': `${VARS}\nexport default { name: 'Plain' }` })

    const { ok, cfg } = loadInRealNode(dir)

    expect(ok).toBe(true)
    expect(cfg.name).toBe('Plain')
    expect(Object.keys(cfg.vars)).toHaveLength(2)
    expect(readdirSync(dir).filter((f) => f.includes('uniweb-config'))).toEqual([])
  })
})

describe('loadFoundationConfig failure modes', () => {
  // The distinction that matters: an ABSENT config is a legitimate state (a
  // site with no local foundation). A config that EXISTS and cannot load is a
  // build error — degrading it to `{}` is what produced a themeless site.
  it('returns {} when there is no config file at all', async () => {
    const dir = fixture({})
    await expect(loadFoundationConfig(dir)).resolves.toEqual({})
  })

  it('throws when a config exists but throws on evaluation', async () => {
    const dir = fixture({ 'main.js': `throw new Error('author bug')\nexport default {}` })

    await expect(loadFoundationConfig(dir)).rejects.toThrow(/author bug/)
  })

  it('names the file and says why the build cannot continue', async () => {
    const dir = fixture({ 'main.js': `import './missing-module.js'\nexport default {}` })

    await expect(loadFoundationConfig(dir)).rejects.toThrow(/no theme variables/)
  })

  it('does not retry a throwing config through the bundler', async () => {
    // A config that throws is not a syntax problem, so the esbuild path must
    // not run — otherwise a slow bundle is paid for on every author error.
    const dir = fixture({ 'main.js': `throw new Error('boom')\nexport default {}` })

    await expect(loadFoundationConfig(dir)).rejects.toThrow()
    expect(readdirSync(dir).filter((f) => f.includes('uniweb-config'))).toEqual([])
  })
})
