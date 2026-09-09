import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteContentDocumentToProject, collectSiteUnits } from '../src/uwx/index.js'

// Producer-side lists that must track something which changes independently, and
// go QUIET rather than loud when they drift.
//
// Three defects of this exact shape shipped before these existed: site `info` was
// missing from the unit walk (so it was ungated and undiffed), `page.yml::sections:`
// was written strict (so it silently excluded new sections), and per-item identity
// was absent from the wire (so every push recreated every row). None crashed; each
// produced a plausible wrong answer.
//
// The lists below are currently correct. These tests exist so that stops being
// something a human has to remember — the comment "keep in sync with X" is a
// standing invitation to drift, and an invariant nobody checks is a wish.

const read = (rel) => readFileSync(new URL(`../src/uwx/${rel}`, import.meta.url), 'utf8')

describe('producer-side lists cannot drift silently', () => {
  it('PAGE_YML_MANAGED_KEYS covers every key pageRecordToYml can emit', () => {
    // Drift consequence: a managed key missing from the set is never DROPPED on a
    // merge write, so a value removed upstream lingers in page.yml forever — and
    // the file looks hand-authored, so nobody suspects the projector.
    const src = read('site-project.js')
    const declared = new Set(
      src.match(/const PAGE_YML_MANAGED_KEYS = new Set\(\[([\s\S]*?)\]\)/)[1]
        .match(/'([^']+)'/g).map((s) => s.slice(1, -1))
    )
    const body = src.match(/function pageRecordToYml\([\s\S]*?\n}/)[0]
    const emitted = new Set([...body.matchAll(/\by\.([A-Za-z_]+)\s*=/g)].map((m) => m[1]))

    expect(emitted.size).toBeGreaterThan(5) // the regex actually found something
    const unmanaged = [...emitted].filter((k) => !declared.has(k))
    expect(unmanaged).toEqual([])
  })

  it('every info field the producer emits is either mapped or deliberately special-cased', () => {
    // Drift consequence: a new `info` field that pull does not project back is
    // invisible locally, so the next push sends the stale local value and REVERTS
    // an author's change — a silent round-trip loss, not an error.
    const projectSrc = read('site-project.js')
    const siteSrc = read('site.js')

    const emitted = new Set([...siteSrc.matchAll(/setIf\(info, '([a-z_]+)'/g)].map((m) => m[1]))
    const mapped = new Set(
      projectSrc.match(/const INFO_TO_SITE_YML = \{([\s\S]*?)\n\}/)[1]
        .match(/^\s*([a-z_]+):/gm).map((s) => s.trim().replace(':', ''))
    )
    // Handled explicitly rather than verbatim — a localized unwrap, a non-YAML
    // target, or a different key on the way out. Each is named so adding a field
    // cannot quietly land here by default.
    //
    // ⭐ `data` is the third kind: it projects to `site.yml::fetch`, not `::data`,
    // because `data:` is the authoring shorthand and the wire carries the desugared
    // form. This guard is what caught it when the verbatim row was removed.
    const specialCased = new Set(['description', 'keywords', 'head_html', 'name', 'theme', 'data'])

    // ⚠️ `info` is a BRIEF since 2026-09-09 — 18 keys moved to `settings` — so this
    // floor is deliberately low. It exists to prove the regex matched something, not
    // to assert a size.
    expect(emitted.size).toBeGreaterThan(2)
    const unaccounted = [...emitted].filter((k) => !mapped.has(k) && !specialCased.has(k))
    expect(unaccounted).toEqual([])
  })

  it('every settings-Section key the producer emits is mapped back on pull', () => {
    // The `info` guard above, for the Section that now carries authored config
    // which does not belong on `info`. Same drift, same silence: a key
    // `settingsNested` emits but `SETTINGS_TO_SITE_YML` does not map is invisible
    // locally, so the next push sends the stale local value and reverts an
    // author's change.
    //
    // ⭐ THIS GUARD EXISTS BECAUSE MOVING A KEY OFF `info` LEAVES ITS GUARD BEHIND.
    // `placeholders` was briefly an `info` field and was covered by the test above;
    // relocating it to the `settings` Section silently took it out of that test's
    // scope, and everything still passed. A Section without its own guard is the
    // same wish the header calls out.
    const projectSrc = read('site-project.js')
    const siteSrc = read('site.js')

    const body = siteSrc.match(/function settingsNested\([\s\S]*?\n}/)[0]
    const emitted = new Set([...body.matchAll(/setIf\(settings, '([a-z_]+)'/g)].map((m) => m[1]))
    const mapped = new Set(
      projectSrc.match(/const SETTINGS_TO_SITE_YML = \{([\s\S]*?)\n\}/)[1]
        .match(/^\s*([a-z_]+):/gm).map((s) => s.trim().replace(':', ''))
    )
    // Handled by an explicit branch rather than the verbatim map — a non-YAML
    // target, or a localized unwrap. Named so a new key cannot land here by default.
    const specialCased = new Set([
      'theme',      // → theme.yml
      'head_html',  // → head.html
      'keywords',   // localized list + the translation collector
      'fetch',      // → site.yml::fetch, via the shorthand-normalizing branch
    ])

    expect(emitted.size).toBeGreaterThan(0) // the regex actually found something
    const unaccounted = [...emitted].filter((k) => !mapped.has(k) && !specialCased.has(k))
    expect(unaccounted).toEqual([])
  })

  it('collectSiteUnits covers every file the projector writes', () => {
    // Drift consequence: a file kind the walk misses is ungated by the push
    // precondition and invisible in a conflict report. This ALREADY happened once —
    // site `info` was absent, leaving the site's theme and foundation ref
    // unprotected — and it was found by counting, not by a test.
    const dir = mkdtempSync(join(tmpdir(), 'uwx-drift-'))
    try {
      const doc = {
        $id: 'site-content', $model: '@uniweb/site-content',
        info: { name: { en: 'S' }, foundation: '@a/b' },
        pages: [
          {
            $id: 'home', slug: 'home', mode: 'page', stable_id: 'home',
            page_sections: [{ $id: 'hero', stable_id: 'hero', type: 'Hero', content: { type: 'doc', content: [] } }],
            $children: [{ $id: 'kid', slug: 'kid', mode: 'page', stable_id: 'kid', page_sections: [] }],
          },
          { $id: 'blog', slug: 'blog', mode: 'folder', stable_id: 'blog' },
        ],
        layout_sections: [{ $id: 'header', stable_id: 'header', type: 'Header', content: { type: 'doc', content: [] } }],
      }
      const report = siteContentDocumentToProject({ document: doc, siteRoot: dir })
      const units = new Set(collectSiteUnits(doc).keys())

      // Config files the walk represents as the single `site.yml` unit, plus the
      // locale sidecars, which are derived rather than authored units.
      const represented = (p) => {
        const rel = p.replace(`${dir}/`, '')
        return rel.startsWith('locales/') || ['site.yml', 'theme.yml', 'head.html', 'collections.yml'].includes(rel)
      }
      const written = [...report.pages, ...report.sections, ...report.layout]
      const missed = written.map((p) => p.replace(`${dir}/`, '')).filter((rel) => !units.has(rel) && !represented(rel))
      expect(missed).toEqual([])
      expect(units.has('site.yml')).toBe(true) // the one that already drifted
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ⭐ Moved with the 18 on 2026-09-09: `agents` is configuration (a projections
// opt-out plus route exclusions), so it rides `settings`, not the brief. The test
// still exists for the same reason — it round-trips, and both halves must be there.
describe('the agents block round-trips', () => {
  // `agents:` carries the projections opt-out and route exclusions. The app is a
  // second PUBLISHER of projections and derives them from stored content, so a
  // block that does not round-trip means an author's `agents: false` is silently
  // reversed on an app publish, and an excluded branch becomes both discoverable
  // AND summarized by the index. Push and pull halves are asserted together
  // because one without the other is the silent case.
  const src = (rel) => readFileSync(new URL(`../src/uwx/${rel}`, import.meta.url), 'utf8')

  it('is emitted onto the settings Section by the producer', () => {
    expect(src('site.js')).toMatch(/setIf\(settings, 'agents', siteYml\.agents\)/)
  })

  it('is mapped back onto site.yml by the projector', () => {
    const map = src('site-project.js').match(/const SETTINGS_TO_SITE_YML = \{([\s\S]*?)\n\}/)[1]
    expect(map).toMatch(/\bagents:\s*'agents'/)
  })
})
