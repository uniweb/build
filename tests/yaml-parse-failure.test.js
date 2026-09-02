/**
 * A site whose configuration will not parse must not build green.
 *
 * ## What this closes
 *
 * `parseYaml` in `content-collector.js` answered a parse failure with a
 * `console.warn` and `{}`. It is the reader for `site.yml`, `page.yml`,
 * `folder.yml`, `theme.yml` and every section's frontmatter — i.e. every
 * configuration surface an author writes — so one typo silently discarded that
 * file's whole contribution (page order, nesting, `sections:`, `data:`, theme)
 * and the build SUCCEEDED. The single line on stderr named no file.
 *
 * ⭐ This is the defect class that no external test suite can catch, because
 * the command exits 0 and only the OUTPUT is wrong. It has to be caught here.
 *
 * ## The asymmetry being pinned
 *
 * `strict` is this codebase's existing word for "this is a real build" — set by
 * `build-site-data.js` and by `plugin.js` as `strict: isProduction`. So:
 *
 *   strict   → throw, naming every bad file at once
 *   dev      → warn per file and continue
 *
 * Dev continuing is deliberate, not laziness: an author is mid-keystroke and a
 * half-typed `page.yml` must not blank their running site. The same asymmetry
 * `plugin.js` already draws around the collect as a whole.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uniweb-yaml-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A minimal site; `pageYml` is written verbatim so a test can make it invalid. */
function site({ siteYml = 'title: T\n', pageYml = 'title: Home\n' } = {}) {
  writeFileSync(join(root, 'site.yml'), siteYml)
  const pages = join(root, 'pages', 'home')
  mkdirSync(pages, { recursive: true })
  writeFileSync(join(pages, 'page.yml'), pageYml)
  writeFileSync(join(pages, 'index.md'), '# Home\n')
  return root
}

const BROKEN = 'title: Broken\nsections:\n  - a\n   - b\n  bad: [unclosed\n'

describe('a config file that will not parse', () => {
  it('⛔ fails a strict (production) build instead of shipping', async () => {
    await expect(
      collectSiteContent(site({ pageYml: BROKEN }), { strict: true })
    ).rejects.toThrow(/could not be parsed as YAML/)
  })

  it('names the file, because the old message named nothing', async () => {
    // The whole reason a `source` is threaded through `parseYaml`. An author
    // told only that "some YAML" failed has to bisect their own tree.
    await expect(
      collectSiteContent(site({ pageYml: BROKEN }), { strict: true })
    ).rejects.toThrow(/page\.yml/)
  })

  it('says what was lost, not just that parsing failed', async () => {
    // A parse error the author cannot act on is barely better than silence:
    // the consequence (this file contributed NOTHING) is the actionable half.
    await expect(
      collectSiteContent(site({ pageYml: BROKEN }), { strict: true })
    ).rejects.toThrow(/contributed NOTHING/)
  })

  it('⭐ counts one bad file once, though several call sites read it', async () => {
    // A directory's page.yml is read as its own config and again when its
    // parent resolves nesting. Un-deduplicated, one typo reported as "2 files"
    // — a lie about the author's tree, and the first thing they would chase.
    await expect(
      collectSiteContent(site({ pageYml: BROKEN }), { strict: true })
    ).rejects.toThrow(/^1 file could not be parsed/m)
  })

  it('⚖️ does NOT fail a dev collect — the author is mid-keystroke', async () => {
    // Blanking a running site on a half-typed file would be a worse tool than
    // the silent one this replaces. Dev gets the per-file warning instead.
    const content = await collectSiteContent(site({ pageYml: BROKEN }), {})
    expect(content).toBeTruthy()
    expect(content.config).toBeTruthy()
  })
})

describe('a site whose config is fine', () => {
  it('⛔ stays silent — no failure, strict or not', async () => {
    // The control that earns the check the right to be believed. A build that
    // warns about correct input teaches people to ignore the warning.
    const strictRun = await collectSiteContent(site(), { strict: true })
    expect(strictRun.config).toBeTruthy()
    const devRun = await collectSiteContent(site(), {})
    expect(devRun.config).toBeTruthy()
  })

  it('does not carry failures across collects', async () => {
    // `yamlFailures` is module-scoped and reset per collect. Without the reset a
    // typo fixed three dev saves ago would still fail the next build.
    await expect(
      collectSiteContent(site({ pageYml: BROKEN }), { strict: true })
    ).rejects.toThrow()
    const after = await collectSiteContent(site(), { strict: true })
    expect(after.config).toBeTruthy()
  })
})
