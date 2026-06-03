import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExtensionPath } from '../src/prerender.js'

/**
 * Prerender loads extensions (secondary foundations referenced by URL) so the
 * Website's FetcherDispatcher sees their routes. The standard multi-foundation
 * workspace puts an extension at `extensions/<name>/`, so a `/effects/entry.js`
 * URL must resolve to `extensions/effects/dist/entry.js`. The bare-root
 * candidate alone missed it, so prerender logged "Cannot find module" and the
 * extension never loaded. This guards the layout resolution.
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

  it('prefers a file already copied into the site dist (production layout)', () => {
    const distDir = join(root, 'site', 'dist')
    const inDist = join(distDir, 'effects', 'entry.js')
    mkdirSync(join(inDist, '..'), { recursive: true })
    writeFileSync(inDist, 'export default {}\n')
    // even if a workspace copy also exists, the dist copy wins
    writeFixture('extensions/effects/dist/entry.js')
    expect(resolveExtensionPath('/effects/entry.js', distDir, root)).toBe(inDist)
  })

  it('returns the URL as-is when nothing resolves (remote / genuinely missing)', () => {
    expect(resolveExtensionPath('/effects/entry.js', join(root, 'site', 'dist'), root)).toBe('/effects/entry.js')
    expect(resolveExtensionPath('https://cdn.example.com/x/entry.js', join(root, 'd'), root)).toBe('https://cdn.example.com/x/entry.js')
  })
})
