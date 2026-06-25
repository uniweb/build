/**
 * Tests for `detectFoundationType` — the function that maps a `site.yml`
 * `foundation:` declaration to a resolved type/URL/path.
 *
 * Foundations are runtime federated modules, never npm packages. The
 * function recognizes two types: 'local' (workspace source) and 'url'
 * (loaded from somewhere at runtime). Versionless or unrecognized
 * declarations throw with specific guidance.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectFoundationType } from '../src/site/config.js'

describe('detectFoundationType', () => {
  let workspaceDir
  let siteDir

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'uniweb-detect-'))
    siteDir = join(workspaceDir, 'site')
    await mkdir(siteDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  describe('URL refs', () => {
    test('https URL resolves to type: url', () => {
      const result = detectFoundationType('https://cdn.example/foundation.js', siteDir)
      expect(result.type).toBe('url')
      expect(result.url).toBe('https://cdn.example/foundation.js')
    })

    test('@org/name@version resolves to type: url with catalog URL shape', () => {
      const result = detectFoundationType('@uniweb/foo@0.1.2', siteDir)
      expect(result.type).toBe('url')
      expect(result.url).toContain('/foundations/uniweb/foo/0.1.2/foundation.js')
    })

    test('object form with explicit url resolves to type: url', () => {
      const result = detectFoundationType({ url: 'https://x.example/f.js' }, siteDir)
      expect(result.type).toBe('url')
      expect(result.url).toBe('https://x.example/f.js')
    })
  })

  describe('local refs', () => {
    test('bare name matching a workspace sibling resolves to type: local', async () => {
      await mkdir(join(workspaceDir, 'foundation'))
      const result = detectFoundationType('foundation', siteDir)
      expect(result.type).toBe('local')
      expect(result.path).toBe(join(workspaceDir, 'foundation'))
    })

    test('file: dep in the site package.json resolves to type: local', async () => {
      const fnDir = join(workspaceDir, 'fn')
      await mkdir(fnDir)
      await writeFile(join(siteDir, 'package.json'), JSON.stringify({
        dependencies: { 'my-foundation': 'file:../fn' },
      }))
      const result = detectFoundationType('my-foundation', siteDir)
      expect(result.type).toBe('local')
      expect(result.path).toBe(fnDir)
    })

    test('@org/name (no version) resolves via file: dep — the canonical local-dev shape', async () => {
      // Tianyu's uniweb.io workflow: site.yml says '@uniweb/io', package.json
      // maps that name to a workspace foundation directory via file: dep.
      const fnDir = join(workspaceDir, 'foundations', 'io')
      await mkdir(fnDir, { recursive: true })
      await writeFile(join(siteDir, 'package.json'), JSON.stringify({
        dependencies: { '@uniweb/io': 'file:../foundations/io' },
      }))
      const result = detectFoundationType('@uniweb/io', siteDir)
      expect(result.type).toBe('local')
      expect(result.path).toBe(fnDir)
    })
  })

  describe('versionless scoped refs that do NOT resolve locally', () => {
    test('@org/name with no file: dep and no sibling directory throws with two-cause hint', () => {
      const fn = () => detectFoundationType('@uniweb/foo', siteDir)
      expect(fn).toThrow(/did not resolve to a local source/)
      expect(fn).toThrow(/file:\.\.\/path\/to\/foundation/)
      expect(fn).toThrow(/@uniweb\/foo@0\.1\.2/)
    })

    // Site-bound `~`-prefixed refs are retired — uniwebd is cataloged-only
    // (shipping-model.md §6.3). A `~` ref is no longer a recognized shape, so
    // it falls through to the generic "did not resolve" rejection, whether
    // versioned or not.
    test('~siteId/name@version is rejected (site-bound retired)', () => {
      expect(() => detectFoundationType('~abc123def456/foo@0.1.2', siteDir))
        .toThrow(/did not resolve/)
    })

    test('~siteId/name (no version) is rejected (site-bound retired)', () => {
      expect(() => detectFoundationType('~abc123/foo', siteDir))
        .toThrow(/did not resolve/)
    })
  })

  describe('unresolved names are rejected (no npm fall-through)', () => {
    test('unknown bare name with no workspace match throws', () => {
      expect(() => detectFoundationType('mystery-foundation', siteDir))
        .toThrow(/did not resolve/)
    })

    test('error explains what shapes ARE supported', () => {
      const fn = () => detectFoundationType('mystery', siteDir)
      expect(fn).toThrow(/workspace-local sibling/)
      expect(fn).toThrow(/file:' dep/)
      expect(fn).toThrow(/versioned registry ref/)
      expect(fn).toThrow(/full URL/)
    })

    test('error states foundations are not npm packages', () => {
      expect(() => detectFoundationType('mystery', siteDir))
        .toThrow(/not npm packages/)
    })
  })
})
