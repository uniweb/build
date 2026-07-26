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
    // Handled explicitly rather than verbatim — localized unwrap, or a non-YAML
    // target. Each is named so adding a field cannot quietly land here by default.
    const specialCased = new Set(['description', 'keywords', 'head_html', 'name', 'theme'])

    expect(emitted.size).toBeGreaterThan(8)
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
