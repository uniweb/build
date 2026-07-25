/**
 * What Vite is told not to prebundle.
 *
 * A workspace-linked foundation is source under active editing, reached through
 * a `file:` dependency — so Vite's scanner sees an ordinary node_modules package
 * and prebundles it. Two things go wrong when it does: the prebundle is stale
 * the moment it is written, and the prebundler is esbuild, whose `imports`-field
 * resolution does not apply `resolve.extensions` the way Vite's own resolver
 * does. A foundation using the subpath imports the scaffolder generates
 * (`#components/Container` → `./components/Container`, on disk as
 * `Container.jsx`) fails to resolve, and the site renders blank.
 *
 * It hid behind a warm dependency cache. Vite only rescans when something
 * invalidates it, so the failure surfaced on a lockfile change — an update,
 * with nothing about the site itself having changed.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSiteConfig } from '../src/site/config.js'

let root
let cwd

/**
 * A site plus the foundation it links, laid out the way `uniweb create` does:
 * sibling directories, the foundation reached by a `file:` dependency.
 */
async function makeWorkspace({ foundationName = 'src', siteYml } = {}) {
  root = await mkdtemp(join(tmpdir(), 'uniweb-optdeps-'))
  const siteDir = join(root, 'site')
  const foundationDir = join(root, foundationName)

  await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
  await writeFile(join(siteDir, 'site.yml'), siteYml ?? `name: Test\nfoundation: ${foundationName}\n`)
  await writeFile(
    join(siteDir, 'package.json'),
    JSON.stringify({ name: 'site', dependencies: { [foundationName]: `file:../${foundationName}` } })
  )

  await mkdir(join(foundationDir, 'components'), { recursive: true })
  await writeFile(
    join(foundationDir, 'package.json'),
    JSON.stringify({ name: foundationName, imports: { '#components/*': './components/*' } })
  )
  await writeFile(join(foundationDir, 'components', 'Container.jsx'), 'export default () => null\n')

  cwd = process.cwd()
  process.chdir(siteDir)
  return siteDir
}

afterEach(async () => {
  if (cwd) process.chdir(cwd)
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  cwd = undefined
})

describe('optimizeDeps.exclude', () => {
  it('excludes a linked foundation by the name the site declares', async () => {
    await makeWorkspace()

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.exclude).toContain('src')
  })

  it('still excludes the #foundation alias', async () => {
    await makeWorkspace()

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.exclude).toContain('#foundation')
  })

  it('uses whatever the foundation is actually called', async () => {
    // A co-located project names it for the project, not 'src'.
    await makeWorkspace({ foundationName: 'docs-src' })

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.exclude).toContain('docs-src')
  })

  it('adds nothing for a foundation loaded by URL', async () => {
    // Nothing local to prebundle — the foundation arrives at runtime.
    await makeWorkspace({
      siteYml: 'name: Test\nfoundation: https://cdn.example.com/f/entry.js\n',
    })

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.exclude).toEqual(['#foundation'])
  })

  it('keeps prebundling React, which is a real dependency', async () => {
    await makeWorkspace()

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.include).toContain('react')
    expect(config.optimizeDeps.exclude).not.toContain('react')
  })
})
