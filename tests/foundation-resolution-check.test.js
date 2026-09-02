import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  checkFoundationResolution,
  findPackageDir,
} from '../src/utils/foundation-resolution-check.js'

// Each case builds a real tree, because the whole subject is filesystem
// resolution — a mocked `existsSync` would be asserting my model of node's
// lookup rather than node's lookup.
let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-resolution-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A project: `<root>/src` (the foundation) and `<root>/site`. */
function project() {
  const src = join(root, 'src')
  const site = join(root, 'site')
  mkdirSync(src, { recursive: true })
  mkdirSync(join(site, 'node_modules'), { recursive: true })
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({ name: 'src', main: './_entry.generated.js' })
  )
  return { src, site }
}

describe('findPackageDir', () => {
  it('finds the package in the nearest node_modules', () => {
    const { src, site } = project()
    symlinkSync('../../src', join(site, 'node_modules', 'src'))
    expect(findPackageDir('src', site)).toBe(join(site, 'node_modules', 'src'))
  })

  it('walks upward when the nearest node_modules does not have it', () => {
    const { site } = project()
    const hoisted = join(root, 'node_modules', 'src')
    mkdirSync(hoisted, { recursive: true })
    writeFileSync(join(hoisted, 'package.json'), '{"name":"src"}')
    expect(findPackageDir('src', site)).toBe(hoisted)
  })

  it('returns null rather than looping when nothing has it', () => {
    const { site } = project()
    expect(findPackageDir('src', site)).toBeNull()
  })
})

describe('checkFoundationResolution', () => {
  it('agrees when node_modules/<name> links to the foundation', () => {
    const { src, site } = project()
    symlinkSync('../../src', join(site, 'node_modules', 'src'))
    expect(
      checkFoundationResolution({ name: 'src', generatedInto: src, siteRoot: site })
    ).toEqual({ ok: true })
  })

  it('catches a COPY where the link should be', () => {
    // The loud case: vite reads a directory we never generated into, so its
    // `main` points at a file nobody wrote.
    const { src, site } = project()
    const copy = join(site, 'node_modules', 'src')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'package.json'), '{"name":"src","main":"./_entry.generated.js"}')

    const r = checkFoundationResolution({ name: 'src', generatedInto: src, siteRoot: site })
    expect(r.ok).toBe(false)
    expect(r.ours).toContain('/src')
    expect(r.theirs).toContain('node_modules/src')
  })

  it('⭐ catches an INTACT relative link that resolves into another tree', () => {
    // The case that defeats `readlink`. `node_modules` is itself a symlink, so
    // the link text `../../src` is correct and resolves against the link's
    // TARGET — landing in a seed tree rather than this project.
    //
    // This is the shape the `flows` lane hit (2026-09-01), and the reason this
    // function compares realpaths: their harness reported `../../src` and read
    // as healthy while every build used the seed's foundation.
    const { src, site } = project()
    const seed = join(root, 'seed')
    mkdirSync(join(seed, 'src'), { recursive: true })
    writeFileSync(join(seed, 'src', 'package.json'), '{"name":"src"}')
    mkdirSync(join(seed, 'site', 'node_modules'), { recursive: true })
    symlinkSync('../../src', join(seed, 'site', 'node_modules', 'src'))

    rmSync(join(site, 'node_modules'), { recursive: true })
    symlinkSync(join(seed, 'site', 'node_modules'), join(site, 'node_modules'))

    const r = checkFoundationResolution({ name: 'src', generatedInto: src, siteRoot: site })
    expect(r.ok).toBe(false)
    // realpath both sides: on macOS /var is itself a symlink to /private/var,
    // so the raw join is not what the check (correctly) returns.
    expect(r.theirs).toBe(realpathSync(resolve(seed, 'src')))
    expect(r.ours).not.toBe(r.theirs)
  })

  it('⛔ stays SILENT when the package is nowhere in node_modules', () => {
    // A `foundations/<name>/` layout need not put the foundation in the site's
    // node_modules. A warning that fires on a healthy project teaches people to
    // ignore the warning, so we report only a disagreement we can prove.
    const { src, site } = project()
    expect(
      checkFoundationResolution({ name: 'src', generatedInto: src, siteRoot: site })
    ).toEqual({ ok: true })
  })

  it('names both directories and the cause in the message', () => {
    const { src, site } = project()
    const copy = join(site, 'node_modules', 'src')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'package.json'), '{"name":"src"}')

    const { message } = checkFoundationResolution({
      name: 'src',
      generatedInto: src,
      siteRoot: site,
    })
    expect(message).toContain('we generated its entry into')
    expect(message).toContain('vite will import it from')
    expect(message).toContain('SUCCEEDS against the wrong foundation')
  })
})
