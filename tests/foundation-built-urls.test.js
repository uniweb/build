/**
 * A foundation names the files its code references by where the code is, never by the page's
 * root.
 *
 * Library mode inlines every asset but a worker, which is a file of its own, and its URL came
 * out root-relative: `/assets/<worker>.js`. A host serves a foundation from an address of its
 * own, so on a published site that URL named the page's origin, where no such file is — a
 * map built on maplibre-gl 6 could not start its worker (measured 2026-10-27).
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { defineFoundationConfig } from '../src/foundation/config.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')

/** Build an entry that takes a worker's URL, in library mode; return every emitted script. */
async function buildLib({ experimental } = {}) {
  const dir = mkdtempSync(join(HERE, '.tmp-built-urls-'))
  try {
    writeFileSync(join(dir, 'worker.js'), 'self.onmessage = (e) => self.postMessage(e.data)\n')
    writeFileSync(join(dir, 'entry.js'), "import url from './worker.js?worker&url'\nexport default url\n")
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      experimental,
      build: {
        lib: { entry: join(dir, 'entry.js'), formats: ['es'], fileName: 'entry' },
        outDir: join(dir, 'dist'),
        minify: false,
      },
    })
    return {
      entry: readFileSync(join(dir, 'dist', 'entry.js'), 'utf8'),
      emitted: readdirSync(join(dir, 'dist'), { recursive: true }).map(String),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("a file a foundation's code references", () => {
  it('control: library mode alone names the worker from the page\'s root', async () => {
    const { entry, emitted } = await buildLib()
    const worker = emitted.find((f) => /^assets[/\\]worker-[\w-]+\.js$/.test(f))
    expect(worker).toBeTruthy()
    expect(entry).toMatch(/"\/assets\/worker-[\w-]+\.js"/)
  })

  it('⭐ defineFoundationConfig() names it beside the code', async () => {
    const { experimental } = await defineFoundationConfig({ tailwind: false })
    const { entry } = await buildLib({ experimental })
    expect(entry).toMatch(/new URL\("assets\/worker-[\w-]+\.js", import\.meta\.url\)/)
    expect(entry).not.toMatch(/"\/assets\//)
  })

  it("keeps an author's own experimental options beside it, and lets the author's win", async () => {
    const own = () => 'https://cdn.example.test/x.js'
    const merged = (await defineFoundationConfig({ tailwind: false, experimental: { hmrPartialAccept: true } })).experimental
    expect(merged.hmrPartialAccept).toBe(true)
    expect(merged.renderBuiltUrl('x.js', { hostType: 'js' })).toEqual({ relative: true })
    expect(merged.renderBuiltUrl('x.css', { hostType: 'css' })).toBeUndefined()
    const replaced = (await defineFoundationConfig({ tailwind: false, experimental: { renderBuiltUrl: own } })).experimental
    expect(replaced.renderBuiltUrl).toBe(own)
  })
})
