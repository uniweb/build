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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { detectFoundationType } from '../src/site/config.js'

/**
 * Source with comments stripped, for the recurrence guard below.
 *
 * Stripped because the assertions are about CODE: the comment in `config.js`
 * explaining what was removed necessarily quotes the old route and host, and a
 * guard its own rationale can break is not a guard.
 */
const configCode = readFileSync(
  fileURLToPath(new URL('../src/site/config.js', import.meta.url)),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

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

    /**
     * A serve location is READ, never constructed — where a foundation is served
     * is the host's business, and a build is offline and backend-optional, so it
     * has nothing to ask.
     *
     * This test used to pin the opposite: `/foundations/uniweb/foo/0.1.2/foundation.js`
     * against a hardcoded internal host. That is the same shape as the
     * `gatewayUrl()` removal of 2026-07-29 — a rebuilt backend route with a test
     * pinning it verbatim — which is why the assertion is now inverted rather
     * than merely updated. It was also wrong three ways over: the env var that
     * claimed to override it was not the one the documented backend selection
     * writes, and the artifact names predated `entry.js`/`assets/style.css`.
     */
    test('@org/name@version does NOT invent a serve URL — it throws with guidance', () => {
      const fn = () => detectFoundationType('@uniweb/foo@0.1.2', siteDir)
      expect(fn).toThrow(/catalog ref/i)
      // The message has to leave the user somewhere to go, or a loud failure is
      // just a different way to be stuck.
      expect(fn).toThrow(/uniweb publish/)
      expect(fn).toThrow(/site\.yml/)
    })

    /**
     * There are many hosting targets and the Uniweb platform is one of them, so
     * the guidance has to name all three verbs and must not lead with the paid
     * one. The verbs are not interchangeable:
     *
     *   publish              → the Uniweb platform (paid, most integrated)
     *   deploy --host=<a>    → third-party host adapters
     *   export               → a standalone artifact, take it anywhere
     *
     * A foundation is a URL-addressable module and the runtime accepts any URL,
     * so presenting the platform as *the* answer would teach a constraint that
     * does not exist — "foundations must be in our registry" is on the model
     * doc's list of fake constraints.
     *
     * Ordering is asserted rather than described because framing is what quietly
     * rots: `framework/CLAUDE.md` records the same call for the deploy wizard —
     * the platform is listed among the hosts and deliberately not first, since
     * leading a generic path with the paid product reads as an upsell and the
     * framework is standalone-first.
     */
    test('the guidance names every lane and does not lead with the paid one', () => {
      let message = ''
      try {
        detectFoundationType('@uniweb/foo@0.1.2', siteDir)
      } catch (err) {
        message = err.message
      }

      expect(message).toMatch(/any URL/i)
      // The escape hatch and the third-party lane are the standalone-first
      // answers; losing either would leave only the paid one.
      expect(message).toMatch(/uniweb export/)
      expect(message).toMatch(/uniweb deploy --host/)
      expect(message.indexOf('uniweb export')).toBeLessThan(message.indexOf('uniweb publish'))
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

/**
 * Recurrence guard.
 *
 * This package embedded an internal host and rebuilt a backend's foundation
 * route, with a test pinning the route verbatim. That is the second instance of
 * the shape: `gatewayUrl()` in the CLI was removed on 2026-07-29 for the same
 * reason, along with its own route-pinning test. A pattern that comes back once
 * gets a guard rather than a third removal.
 *
 * The rule these enforce is the one the CLI's DISCOVERY_DEFAULTS already states:
 * serve locations are read — from discovery, or an upload plan's `serve_base` —
 * never reconstructed here.
 */
describe('no backend routes or hosts are reconstructed here', () => {
  test('no hardcoded host literal', () => {
    // Any real host here would be a serve location we invented. This matches
    // only a URL literal beginning with an actual hostname character, so the
    // scheme checks (`name.startsWith('https://')`) and the error message's
    // `https://<host>/…` placeholders are untouched.
    //
    // Deliberately shaped as "no host at all" rather than naming the one that
    // used to be here: writing that host into the guard would reproduce, in a
    // public repo, the exact string the guard exists to keep out.
    expect(configCode).not.toMatch(/https?:\/\/[a-z0-9]/i)
  })

  test('no foundation serve route is built from parts', () => {
    // The exact regression: `${base}/foundations/${ns}/${fn}/${ver}/...` — a
    // path segment interpolated between a BASE and an identifier, which is what
    // makes it a reconstructed serve location.
    //
    // Deliberately anchored on `}/foundations/${` rather than `/foundations/`:
    // this file legitimately names `../../foundations/<name>` when telling a
    // developer where a workspace sibling lives. A local directory convention is
    // ours; a serve route is the host's. The first pattern here caught that hint
    // as a false positive, which is the distinction worth encoding.
    expect(configCode).not.toMatch(/\}\/foundations\/\$\{/)
  })

  test('backend selection is not read through an undocumented env var', () => {
    // UNIWEB_REGISTRY_URL was read here while the documented ladder (--backend,
    // uniweb login --backend, UNIWEB_REGISTER_URL) writes UNIWEB_REGISTER_URL —
    // so the override silently did nothing. If this file ever needs a backend
    // origin again, it must come through the documented path.
    expect(configCode).not.toMatch(/UNIWEB_REGISTRY_URL/)
  })
})
