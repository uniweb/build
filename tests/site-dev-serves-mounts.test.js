/**
 * `uniweb dev` serves what a site's mounted directories hold: `server.fs.allow` holds each directory
 * `site.yml::paths` mounts, `pages/<segment>` and `records/<type>` as well as the whole `pages`,
 * `layout` and `records`.
 *
 * Vite serves a page's own pictures only from the folders the allow list holds. Measured
 * 2026-11-22 on a site that mounts its docs from beside its project (`pages/docs:
 * ../../external/docs`): under `uniweb dev`, a docs page's own pictures were refused, 403 "outside
 * of Vite serving allow list", while the build showed them.
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
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
}

/** A workspace `ws/` with `site/` on the foundation `src/`, whose site.yml holds `paths`. */
function workspace(paths) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'uw-dev-mounts-')))
  roots.push(top)
  const ws = join(top, 'ws')
  write(ws, {
    'site/site.yml': `name: Test\nfoundation: src\npaths:\n${Object.entries(paths).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`,
    'site/package.json': JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } }),
    'site/pages/home/page.yml': 'title: Home\n',
    'src/package.json': JSON.stringify({ name: 'src', type: 'module', main: './_entry.generated.js' }),
    'src/main.js': 'export default {}\n',
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
  it('⭐ holds a directory mounted into pages from outside the workspace', async () => {
    const { top } = workspace({ 'pages/docs': '../../docs' })
    write(top, { 'docs/intro.md': '# Intro\n' })
    expect(await allowOf()).toEqual(['..', join(top, 'docs')])
  })

  it('holds a directory mounted into records from outside the workspace', async () => {
    const { top } = workspace({ 'records/member': '../../people' })
    write(top, { 'people/ada.md': '---\nname: Ada\n---\n' })
    expect(await allowOf()).toEqual(['..', join(top, 'people')])
  })

  it('holds pages moved whole, as before', async () => {
    const { top } = workspace({ pages: '../../content' })
    write(top, { 'content/home/page.yml': 'title: Home\n' })
    expect(await allowOf()).toEqual(['..', join(top, 'content')])
  })

  it('CONTROL: a mount inside the site\'s parent is in the folder already allowed', async () => {
    const { ws } = workspace({ 'pages/docs': '../docs' })
    write(ws, { 'docs/intro.md': '# Intro\n' })
    expect(await allowOf()).toEqual(['..'])
  })

  it('CONTROL: a folder named like the parent is not inside it', async () => {
    const { top } = workspace({ 'pages/docs': '../../ws-docs' })
    write(top, { 'ws-docs/intro.md': '# Intro\n' })
    expect(await allowOf()).toEqual(['..', join(top, 'ws-docs')])
  })
})
