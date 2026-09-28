import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { resolveExtensionPath } from '../src/prerender.js'

/**
 * Prerender loads extensions (secondary foundations referenced by URL) so the
 * Website's FetcherDispatcher sees their routes. The standard multi-foundation
 * workspace puts an extension at `extensions/<name>/`, so a `/effects/entry.js`
 * URL must resolve to `extensions/effects/dist/entry.js`. The bare-root
 * candidate alone missed it, so prerender logged "Cannot find module" and the
 * extension never loaded. This guards the layout resolution.
 *
 * ⛔ And WHICH file it picks decides whether it loads at all. Since the site
 * build emits a copy of the extension into the site's `dist/` (for the browser),
 * that copy was the first candidate, and prerender imported it — from under the
 * site package, where the extension's `@uniweb/core` does not resolve. Every
 * workspace extension failed with "Cannot find package '@uniweb/core'", and the
 * static HTML carried `Component not found` where its sections belonged.
 * Measured on a project made from the `extensions` template. The picking tests
 * passed throughout: their fixtures import nothing, so no test ever imported
 * what was picked.
 */
describe('resolveExtensionPath', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uniweb-ext-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const writeFixture = (rel) => {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, 'export default {}\n')
    return full
  }

  it('resolves the extensions/<name>/ workspace layout', () => {
    const built = writeFixture('extensions/effects/dist/entry.js')
    const distDir = join(root, 'site', 'dist')
    const projectRoot = root
    expect(resolveExtensionPath('/effects/entry.js', distDir, projectRoot)).toBe(built)
  })

  it('resolves the bare project-root layout (<name>/dist/)', () => {
    const built = writeFixture('effects/dist/entry.js')
    expect(resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)).toBe(built)
  })

  it("picks the extension's own build over the copy the site build emits into dist", () => {
    const built = writeFixture('extensions/effects/dist/entry.js')
    writeFixture('site/dist/effects/entry.js')
    expect(resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)).toBe(built)
  })

  it('falls back to a file in the site dist when no workspace package builds the extension', () => {
    // A pre-built extension placed in the site's `public/` reaches `dist/` and nowhere else.
    const inDist = writeFixture('site/dist/effects/entry.js')
    expect(resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)).toBe(inDist)
  })

  /** Import a file through the real Node ESM loader — the one prerender runs under. */
  const importInRealNode = (file) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `try { const m = await import(${JSON.stringify(pathToFileURL(file).href)});
                 process.stdout.write(JSON.stringify({ ok: true, value: m.Probe })) }
           catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.code })) }`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    )

  /**
   * The composition the picking tests cannot see. A foundation build leaves its
   * externals as bare imports (`@uniweb/core`, `react`), and Node resolves them
   * from where the file sits — so the extension's own package resolves them and
   * the site's copy of the same bytes does not. Out of process, because under
   * the test runner the import is resolved by the runner and would pass anyway.
   */
  it('picks a file whose bare imports resolve, which the dist copy of the same bytes does not', () => {
    const dep = join(root, 'extensions', 'effects', 'node_modules', 'uniweb-extension-probe-dep')
    mkdirSync(dep, { recursive: true })
    writeFileSync(join(dep, 'package.json'), '{"name":"uniweb-extension-probe-dep","type":"module","exports":"./index.js"}')
    writeFileSync(join(dep, 'index.js'), "export const dep = 'resolved'\n")

    const entry = "import { dep } from 'uniweb-extension-probe-dep'\nexport const Probe = dep\n"
    const built = join(root, 'extensions', 'effects', 'dist', 'entry.js')
    const copy = join(root, 'site', 'dist', 'effects', 'entry.js')
    for (const file of [built, copy]) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, entry)
    }

    // CONTROL: the copy under the site cannot resolve the extension's dependency.
    expect(importInRealNode(copy)).toEqual({ ok: false, code: 'ERR_MODULE_NOT_FOUND' })

    const picked = resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)
    expect(importInRealNode(picked)).toEqual({ ok: true, value: 'resolved' })
  })

  it('returns the URL as-is when nothing resolves (remote / genuinely missing)', () => {
    expect(resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)).toBe('/effects/entry.js')
    expect(resolveExtensionPath('https://cdn.example.com/x/entry.js', join(root, 'd'), root)).toBe('https://cdn.example.com/x/entry.js')
  })

  /**
   * Since 2026-08-04 the payload carries FINAL, base-resolved extension URLs
   * (the producer applies the deployment base — see site/extension-urls.js), but
   * `dist/` has no base segment: a site deployed at `/docs/` still writes
   * `dist/effects/entry.js`. Without stripping, prerender would look for
   * `dist/docs/effects/entry.js`, find nothing, and silently render every page
   * of a subdirectory-deployed site without its extension sections.
   */
  it('strips the deployment base before mapping onto the build tree', () => {
    const built = writeFixture('extensions/effects/dist/entry.js')
    const distDir = join(root, 'site', 'dist')
    expect(resolveExtensionPath('/docs/effects/entry.js', distDir, root, '/docs/')).toBe(built)
  })

  it('still resolves a URL that does NOT carry the base (payload built before the change)', () => {
    const built = writeFixture('extensions/effects/dist/entry.js')
    const distDir = join(root, 'site', 'dist')
    expect(resolveExtensionPath('/effects/entry.js', distDir, root, '/docs/')).toBe(built)
  })
})
