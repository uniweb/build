/**
 * `uniweb dev` serves what a library outside the workspace names in its stylesheet:
 * `server.fs.allow` holds each library the bundled foundation imports (`librariesOf`).
 *
 * Vite serves what an import reaches, wherever it is; a file only a stylesheet names, an image or
 * a font, it serves only from the folders the allow list holds. Measured 2026-11-09 under npm, a
 * library outside the workspace linked with `file:`: the page rendered the library's component,
 * and the image its stylesheet named was refused, 403 "outside of Vite serving allow list".
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const roots = []
let cwd
afterEach(() => {
  if (cwd) process.chdir(cwd)
  cwd = undefined
  delete process.env.VITE_FOUNDATION_MODE
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

/** A workspace `ws/` with `site/` on the foundation `src/`, which depends on `ui` at `uiPath`. */
function workspace(uiPath) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-dev-libs-')))
  roots.push(top)
  const ws = join(top, 'ws')
  write(ws, {
    'site/site.yml': 'name: Test\nfoundation: src\n',
    'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
    'site/pages/home/page.yml': 'title: Home\n',
    'src/package.json': JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js', dependencies: { ui: `file:${uiPath}` } }),
    'src/main.js': 'export default {}\n'
  })
  cwd = process.cwd()
  process.chdir(join(ws, 'site'))
  return { top, ws }
}

const allowOf = async () => {
  const { defineSiteConfig } = await import('../src/site/config.js')
  return (await defineSiteConfig()).server.fs.allow
}

describe("the dev server's allow list", () => {
  it('⭐ holds a library outside the workspace', async () => {
    const { top } = workspace('../../acme-ui')
    write(top, { 'acme-ui/package.json': JSON.stringify({ name: 'ui' }) })
    expect(await allowOf()).toEqual(['..', join(top, 'acme-ui')])
  })

  it('CONTROL: a library beside the site is in the folder already allowed', async () => {
    const { ws } = workspace('../ui')
    write(ws, { 'ui/package.json': JSON.stringify({ name: 'ui' }) })
    expect(await allowOf()).toEqual(['..'])
  })

  it('CONTROL: a foundation loaded by URL is built and served on its own, libraries included', async () => {
    const { top } = workspace('../../acme-ui')
    write(top, { 'acme-ui/package.json': JSON.stringify({ name: 'ui' }) })
    process.env.VITE_FOUNDATION_MODE = 'runtime'
    expect(await allowOf()).toEqual(['..'])
  })
})
