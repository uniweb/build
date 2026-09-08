import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import yaml from 'js-yaml'
import { siteProjectToDocument, siteInfoToConfig } from '../src/uwx/index.js'

// `placeholders:` on the sync wire, both directions.
//
// A site declares site-wide values once (`vendor: { email: … }`) and any page
// references them as ordinary Loom variables (`{vendor.email}`). The values are
// authored config: they ride out on push and must come back on pull.
//
// ⭐ WHY BOTH DIRECTIONS ARE TESTED HERE. The two lanes are separate maps —
// `uwx/site.js::configNested` builds the Section on the way out,
// `site-project.js::CONFIG_TO_SITE_YML` maps it back on the way in — so the push
// half tests green on its own while a pull silently drops the block from
// site.yml. That asymmetry is the bug this file exists to prevent, not a
// hypothetical: it is the same shape that let an authored assistant persona
// reach the wire and never reach a hosted site.
//
// ⭐ AND IT RIDES `config`, NOT `info`. `info` carries the site's identity, whose
// keys we name; an unbounded, author-named map does not belong on it.
//
// ⚠️ And the failure mode is quieter than a dropped service endpoint. A missing
// endpoint eventually breaks something visible; a missing placeholder renders
// the literal `{vendor.email}` into the page, which reads as an author's typo.

const ROOTS = []

function siteRoot(siteYmlLines) {
  const root = mkdtempSync(join(tmpdir(), 'uwx-placeholders-'))
  ROOTS.push(root)
  mkdirSync(join(root, 'pages'), { recursive: true })
  writeFileSync(
    join(root, 'site.yml'),
    ['name: Acme Site', 'foundation: "@acme/marketing@1.2.3"', ...siteYmlLines].join('\n')
  )
  return root
}

afterEach(() => {
  while (ROOTS.length) rmSync(ROOTS.pop(), { recursive: true, force: true })
})

describe('uwx/site — placeholders ride the config Section, not info', () => {
  it('carries an authored block onto the config Section, verbatim and nested', async () => {
    const root = siteRoot([
      'placeholders:',
      '  product: Uniweb',
      '  vendor:',
      '    organization: Acme Studios',
      '    email: billing@acme.example',
    ])
    const doc = await siteProjectToDocument(root)
    expect(doc.config.placeholders).toEqual({
      product: 'Uniweb',
      vendor: { organization: 'Acme Studios', email: 'billing@acme.example' },
    })
    // ⛔ And NOT on `info` — that is the whole point of the Section.
    expect(doc.info).not.toHaveProperty('placeholders')
  })

  it('emits no Section at all when the site declares none', async () => {
    // ⛔ Absent is not empty: on a replaced Section `{}` is a request to clear the
    // stored record, so a site that never heard of the key must send nothing.
    const root = siteRoot([])
    const doc = await siteProjectToDocument(root)
    expect(doc).not.toHaveProperty('config')
  })

  // Not localized, and deliberately so: a placeholder is referenced by name in
  // page content, and the localized half of that (`{lang: value}`) belongs to
  // the content lane. Carried as authored.
  it('carries non-string values without coercion', async () => {
    const root = siteRoot([
      'placeholders:',
      '  founded: 2019',
      '  beta: true',
      '  regions: [ca, us]',
    ])
    const doc = await siteProjectToDocument(root)
    expect(doc.config.placeholders).toEqual({ founded: 2019, beta: true, regions: ['ca', 'us'] })
  })
})

describe('uwx/site-project — the config Section comes back on pull', () => {
  it('projects config.placeholders back onto site.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uwx-placeholders-proj-'))
    ROOTS.push(dir)

    const document = {
      info: { name: 'Acme Site', foundation: '@acme/marketing@1.2.3' },
      config: {
        placeholders: {
          product: 'Uniweb',
          vendor: { email: 'billing@acme.example' },
        },
      },
    }

    const report = siteInfoToConfig({ document, siteRoot: dir })
    expect(report.siteConfig).toBe('updated')

    const written = yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))
    expect(written.placeholders).toEqual({
      product: 'Uniweb',
      vendor: { email: 'billing@acme.example' },
    })
  })

  it('survives a full push → pull round trip unchanged', async () => {
    const declared = [
      'placeholders:',
      '  product: Uniweb',
      '  vendor:',
      '    organization: Acme Studios',
      '    email: billing@acme.example',
    ]
    const source = siteRoot(declared)
    const document = await siteProjectToDocument(source)

    const target = mkdtempSync(join(tmpdir(), 'uwx-placeholders-rt-'))
    ROOTS.push(target)
    siteInfoToConfig({ document, siteRoot: target })

    const back = yaml.load(readFileSync(join(target, 'site.yml'), 'utf8'))
    expect(back.placeholders).toEqual(yaml.load(declared.join('\n')).placeholders)
  })
})
