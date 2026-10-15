/**
 * A foundation bundle carries no `process.env.NODE_ENV` read.
 *
 * Vite's library mode leaves `process.env.*` unreplaced, so a bundled CJS
 * dependency that branches on `process.env.NODE_ENV` shipped the read, and a
 * browser threw `ReferenceError: process is not defined` at foundation load —
 * the published site rendered only a runtime error. Measured 2026-10-15 on a
 * foundation with tiptap and dnd-kit, stock `defineFoundationConfig()`.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { defineFoundationConfig, nodeEnvDefine } from '../src/foundation/config.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')

/** Build `src` in library mode with the given plugins and define; return the bundle. */
async function buildLib(src, { plugins, define, mode = 'production' } = {}) {
  const dir = mkdtempSync(join(HERE, '.tmp-node-env-'))
  try {
    writeFileSync(join(dir, 'entry.js'), src)
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      mode,
      plugins,
      define,
      build: {
        lib: { entry: join(dir, 'entry.js'), formats: ['es'], fileName: 'entry' },
        outDir: join(dir, 'dist'),
        minify: false,
      },
    })
    return readFileSync(join(dir, 'dist', 'entry.js'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SRC = `export const env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev'\n`

describe('foundation bundle — process.env.NODE_ENV', () => {
  it('control: library mode alone leaves the read in the bundle', async () => {
    const out = await buildLib(SRC, { plugins: [] })
    expect(out).toContain('process.env.NODE_ENV')
  })

  it('replaces the read with the build mode', async () => {
    const out = await buildLib(SRC, { plugins: [nodeEnvDefine()] })
    expect(out).not.toContain('process.env')
    expect(out).toContain('"prod"')
  })

  it('a development build gets "development"', async () => {
    const out = await buildLib(SRC, { plugins: [nodeEnvDefine()], mode: 'development' })
    expect(out).not.toContain('process.env')
    expect(out).toContain('"dev"')
  })

  it("leaves an author's own define for the key alone", async () => {
    const out = await buildLib(SRC, {
      plugins: [nodeEnvDefine()],
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    })
    expect(out).not.toContain('process.env')
    expect(out).toContain('"dev"')
  })

  it('defineFoundationConfig() includes it by default', async () => {
    const cfg = await defineFoundationConfig({ tailwind: false })
    expect(cfg.plugins.map((p) => p.name)).toContain('uniweb:foundation-node-env')
  })
})
