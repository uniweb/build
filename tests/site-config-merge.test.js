/**
 * How a site's `defineSiteConfig` options combine with the framework's.
 *
 * Most keys a caller passes should win outright — that is what an override is.
 * `optimizeDeps.include` and `.exclude` are the exception: they are lists of
 * things that must hold, and the framework's entries are load-bearing. React in
 * `include` is what keeps a site from ending up with two copies of it.
 *
 * A site adding one package to `exclude` is asking for one more exclusion, not
 * volunteering to restate the framework's list. When replacement was the
 * behaviour, doing so silently dropped React from prebundling and the site
 * broke somewhere entirely unrelated — during a real debugging session it sent
 * the diagnosis off for two rounds before anyone noticed the list had changed.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSiteConfig } from '../src/site/config.js'

let root
let cwd

async function makeSite() {
  root = await mkdtemp(join(tmpdir(), 'uniweb-merge-'))
  const siteDir = join(root, 'site')
  const foundationDir = join(root, 'src')

  await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
  await writeFile(join(siteDir, 'site.yml'), 'name: Test\nfoundation: src\n')
  await writeFile(
    join(siteDir, 'package.json'),
    JSON.stringify({ name: 'site', dependencies: { src: 'file:../src' } })
  )
  await mkdir(foundationDir, { recursive: true })
  await writeFile(join(foundationDir, 'package.json'), JSON.stringify({ name: 'src' }))

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

describe('optimizeDeps merging', () => {
  it('keeps the framework list when a site adds an exclusion', async () => {
    await makeSite()

    const config = await defineSiteConfig({ optimizeDeps: { exclude: ['my-linked-pkg'] } })

    expect(config.optimizeDeps.exclude).toContain('my-linked-pkg')
    expect(config.optimizeDeps.exclude).toContain('#foundation')
    // The part that used to vanish, and whose loss showed up nowhere near here.
    expect(config.optimizeDeps.include).toContain('react')
    expect(config.optimizeDeps.include).toContain('react-dom')
  })

  it('keeps the framework list when a site adds an inclusion', async () => {
    await makeSite()

    const config = await defineSiteConfig({ optimizeDeps: { include: ['some-cjs-dep'] } })

    expect(config.optimizeDeps.include).toContain('some-cjs-dep')
    expect(config.optimizeDeps.include).toContain('react-router-dom')
    expect(config.optimizeDeps.exclude).toContain('#foundation')
  })

  it('does not duplicate an entry the framework already has', async () => {
    await makeSite()

    const config = await defineSiteConfig({ optimizeDeps: { include: ['react'] } })

    expect(config.optimizeDeps.include.filter((d) => d === 'react')).toHaveLength(1)
  })

  it('lets other optimizeDeps keys override outright', async () => {
    // `force` is a single value, not a list of requirements — an override there
    // means what it says.
    await makeSite()

    const config = await defineSiteConfig({ optimizeDeps: { force: true } })

    expect(config.optimizeDeps.force).toBe(true)
    expect(config.optimizeDeps.include).toContain('react')
  })

  it('is unchanged when a site passes nothing', async () => {
    await makeSite()

    const config = await defineSiteConfig()

    expect(config.optimizeDeps.exclude).toEqual(['#foundation'])
    expect(config.optimizeDeps.include).toEqual([
      'react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-router-dom',
    ])
  })
})
