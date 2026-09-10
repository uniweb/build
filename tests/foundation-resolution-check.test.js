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

  /**
   * A src-layout foundation: package root `<root>/pkg`, entry generated into
   * `<root>/pkg/src`. `link: false` leaves node_modules empty for the caller.
   */
  function srcLayout(pkgJson, { link = true } = {}) {
    const pkg = join(root, 'pkg')
    const src = join(pkg, 'src')
    const site = join(root, 'site')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(site, 'node_modules'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pkg', ...pkgJson }))
    writeFileSync(join(src, '_entry.generated.js'), 'export default {}\n')
    if (link) symlinkSync('../../pkg', join(site, 'node_modules', 'pkg'))
    return { pkg, src, site }
  }

  it('⭐ agrees on a src layout — package root above, entry generated into src/', () => {
    // THE FALSE POSITIVE this used to raise on the most common layout: two
    // directories (`pkg/`, `pkg/src/`) and one file, because `main` points at
    // exactly what we generated. Measured on a downstream project 2026-09-10:
    // it fired for 4 of 5 foundations, all healthy.
    const { src, site } = srcLayout({ main: './src/_entry.generated.js' })
    expect(checkFoundationResolution({ name: 'pkg', generatedInto: src, siteRoot: site })).toEqual({ ok: true })
  })

  it("honours exports['.'] over main, as vite does", () => {
    const { src, site } = srcLayout({ main: './nope.js', exports: { '.': './src/_entry.generated.js' } })
    expect(checkFoundationResolution({ name: 'pkg', generatedInto: src, siteRoot: site })).toEqual({ ok: true })
  })

  it('follows a conditional export to its import/default target', () => {
    const { src, site } = srcLayout({ exports: { '.': { import: './src/_entry.generated.js' } } })
    expect(checkFoundationResolution({ name: 'pkg', generatedInto: src, siteRoot: site })).toEqual({ ok: true })
  })

  it('⛔ still reports a src layout whose main points somewhere ELSE', () => {
    // At a built dist/, say: vite then imports a file we did not generate, so
    // edits never reach the site. Same two directories as the passing case —
    // the entry is what decides.
    const { pkg, src, site } = srcLayout({ main: './dist/entry.js' })
    mkdirSync(join(pkg, 'dist'))
    writeFileSync(join(pkg, 'dist', 'entry.js'), 'export default {}\n')
    expect(checkFoundationResolution({ name: 'pkg', generatedInto: src, siteRoot: site }).ok).toBe(false)
  })

  it('⛔ still reports a COPY carrying an entry of its own — the pnpm file: case', () => {
    // What a `file:` dependency with peers becomes under pnpm: a copy in the
    // store, holding a perfectly valid — and STALE — _entry.generated.js. Both
    // files exist and resolve; they are simply different files.
    const { src, site } = srcLayout({ main: './src/_entry.generated.js' }, { link: false })
    const copy = join(site, 'node_modules', 'pkg')
    mkdirSync(join(copy, 'src'), { recursive: true })
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'pkg', main: './src/_entry.generated.js' }))
    writeFileSync(join(copy, 'src', '_entry.generated.js'), 'export default { stale: true }\n')
    expect(checkFoundationResolution({ name: 'pkg', generatedInto: src, siteRoot: site }).ok).toBe(false)
  })

  it('uses the generated entry path it is given, not a guessed filename', () => {
    const { src, site } = srcLayout({ main: './src/custom-entry.js' })
    writeFileSync(join(src, 'custom-entry.js'), 'export default {}\n')
    expect(
      checkFoundationResolution({
        name: 'pkg', generatedInto: src, siteRoot: site, generatedEntry: join(src, 'custom-entry.js'),
      })
    ).toEqual({ ok: true })
  })
})
