/**
 * A foundation's built code has no whitespace or comments in it: a browser or a host loads it as it
 * is, with no next bundler to read them. Vite's library mode keeps both, and its own last pass
 * prints the whitespace back after any ordinary `enforce: 'post'` plugin (`compact-output.js`).
 *
 * Real builds, through `defineFoundationConfig()`, of the browser entry and its SSR twin. A dev
 * rebuild is the control: same source, left readable.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { defineFoundationConfig } from '../src/foundation/config.js'
import { compactOutput } from '../src/foundation/compact-output.js'
import { DEV_REBUILD_MARKER } from '../src/foundation/dev-rebuild.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const CWD = process.cwd()
const dirs = []
afterEach(() => {
  vi.unstubAllEnvs()
  process.chdir(CWD)
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const HERO = `import { useState } from 'react'

/** A doc comment no browser reads. */
const shout = (text) => {
  // A line comment, likewise.
  return \`\${text}
    !\`
}

export default function Hero({ content }) {
  const [title] = useState(content.title)
  return <h1 className="  two  spaces  ">{shout(title)}</h1>
}
`

function foundation() {
  const dir = mkdtempSync(join(HERE, '.tmp-compact-'))
  dirs.push(dir)
  const files = {
    'package.json': JSON.stringify({ name: 'compact-fixture', type: 'module', main: './src/_entry.generated.js' }),
    'src/main.js': "export default { name: 'compact-fixture' }\n",
    'src/sections/Hero/index.jsx': HERO,
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

async function buildIt({ options = {}, dev = false } = {}) {
  const dir = foundation()
  process.chdir(dir)
  vi.stubEnv('NODE_ENV', 'production')
  const config = await defineFoundationConfig({ tailwind: false, ...options })
  await build({
    ...config,
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins: [...config.plugins, ...(dev ? [{ name: DEV_REBUILD_MARKER }] : [])],
  })
  const read = (file) => {
    const path = join(dir, 'dist', file)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return { read }
}

const lines = (code) => code.split('\n').length

describe('a build that ships', () => {
  it('⭐ has no whitespace or comments in the entry or its SSR twin', async () => {
    const { read } = await buildIt()
    for (const file of ['entry.js', 'entry-ssr.js']) {
      const code = read(file)
      expect(code, file).toContain('Hero')
      expect(code, file).not.toContain('@__PURE__')
      expect(code, file).not.toContain('A doc comment')
      expect(code, file).not.toContain('A line comment')
      expect(lines(code), file).toBeLessThan(8)
    }
  })

  it('leaves what the code means alone: a string, a template literal', async () => {
    const { read } = await buildIt()
    const code = read('entry.js')
    expect(code).toContain('"  two  spaces  "')
    expect(code).toMatch(/\n {4}!`/)
  })

  it('keeps a legal comment that reaches it', async () => {
    const plugin = compactOutput()
    plugin.configResolved({ build: { minify: 'esbuild' }, plugins: [] })
    const source = '/*! a licence */\n/** a doc comment */\nexport const a = 1\n'
    const { code } = await plugin.renderChunk.handler(source, { fileName: 'entry.js' }, {})
    expect(code).toContain('/*! a licence */')
    expect(code).not.toContain('a doc comment')
  })

  it('keeps its map beside the code, with its mappings, and does not refer to it', async () => {
    const { read } = await buildIt()
    expect(read('entry.js')).not.toContain('sourceMappingURL')
    const map = JSON.parse(read('entry.js.map'))
    expect(map.sources.some((s) => s.endsWith('sections/Hero/index.jsx'))).toBe(true)
    expect(map.mappings.length).toBeGreaterThan(0)
  })

  it('stays readable where an author turned minifying off', async () => {
    const { read } = await buildIt({ options: { build: { minify: false } } })
    expect(lines(read('entry.js'))).toBeGreaterThan(8)
  })
})

describe('a dev rebuild, the control', () => {
  it('is left readable, annotated, and refers to its map', async () => {
    const { read } = await buildIt({ dev: true })
    const code = read('entry.js')
    expect(code).toContain('@__PURE__')
    expect(lines(code)).toBeGreaterThan(8)
    expect(code).toContain('sourceMappingURL=entry.js.map')
    expect(read('entry-ssr.js')).toBeNull()
  })

  it('makes no map an author asked not to have', async () => {
    const { read } = await buildIt({ dev: true, options: { sourcemap: false } })
    expect(read('entry.js.map')).toBeNull()
    expect(read('entry.js')).not.toContain('sourceMappingURL')
  })
})
