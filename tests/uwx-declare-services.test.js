/**
 * `declareServices: false` — withholding the request Sections for one push.
 *
 * The `$services` / `$secrets` Sections ride inside the site-content document, so
 * every push carries them, and the backend REPLACES what it is sent (a row anchors
 * by its natural key and is updated in place). A re-send therefore overwrites the
 * stored request — including a decision an owner made in the app.
 *
 * ⭐ The producer cannot decide that on its own: "has this changed since we last
 * agreed?" needs the last agreed state, which is project memory the CLI owns. So
 * this file pins only the mechanism — the caller decides, this honours it — and the
 * decision itself is pinned in `cli/test/service-request-gate.test.js`.
 *
 * ⛔ Withholding is NOT the same as the file having no key, and nothing here may
 * blur them: the file still declares one, and the next push that IS a request must
 * carry it again.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { siteProjectToDocument } from '../src/uwx/site.js'

let dirs = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function project(siteYmlExtra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'uw-declare-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'pages', 'home.md'), '# Home\n')
  writeFileSync(
    join(dir, 'site.yml'),
    `name: demo\nfoundation: "@acme/marketing@1.0.0"\n${siteYmlExtra}`
  )
  return dir
}

const WITH_SERVICES = `$services:
  - name: api
    enabled: true
    config:
      grade: pro
$secrets:
  - name: token
    service: api
`

describe('declareServices', () => {
  it('declares both Sections by default — every existing caller is unchanged', async () => {
    const doc = await siteProjectToDocument(project(WITH_SERVICES))
    expect(doc.services).toEqual([
      expect.objectContaining({ name: 'api', enabled: true, config: { grade: 'pro' } })
    ])
    expect(doc.secrets).toHaveLength(1)
  })

  it('withholds both when the caller says the file is not asking', async () => {
    const doc = await siteProjectToDocument(project(WITH_SERVICES), {
      declareServices: false
    })
    // ⭐ ABSENT, not empty. `[]` is an explicit clear and would drop every stored
    // row — the destructive opposite of "I am not telling you about this".
    expect('services' in doc).toBe(false)
    expect('secrets' in doc).toBe(false)
  })

  it('only `false` withholds — an absent or true option declares', async () => {
    for (const opts of [{}, { declareServices: true }, { declareServices: undefined }]) {
      const doc = await siteProjectToDocument(project(WITH_SERVICES), opts)
      expect(doc.services, JSON.stringify(opts)).toBeDefined()
    }
  })

  it('withholding changes nothing else about the document', async () => {
    const dir = project(WITH_SERVICES)
    const declared = await siteProjectToDocument(dir)
    const withheld = await siteProjectToDocument(dir, { declareServices: false })
    const strip = (d) => {
      const { services: _s, secrets: _x, ...rest } = d
      return rest
    }
    expect(strip(withheld)).toEqual(strip(declared))
  })

  it('an explicit clear is withheld too — it is a request like any other', async () => {
    // `$services: []` says "drop every stored row". Once sent, re-sending it is
    // still a re-send, so the gate must be able to withhold it.
    const dir = project('$services: []\n')
    expect((await siteProjectToDocument(dir)).services).toEqual([])
    const doc = await siteProjectToDocument(dir, { declareServices: false })
    expect('services' in doc).toBe(false)
  })
})
