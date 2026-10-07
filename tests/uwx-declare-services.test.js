/**
 * The `services` Section — what a push STATES, from `site.yml::services` and the
 * services this copy holds.
 *
 * ⭐ Every service the file lists goes as the file says it, whole. Every service this
 * copy holds — `sync.json`, `{ name: $uuid }`, written by pull and push — that the file
 * no longer lists goes OFF, with no settings. A service this copy never saw is not sent,
 * and the backend keeps it. The backend decides per service from the versions the push
 * sends (spec: kb/framework/reference/site-services-request.md; the exchange:
 * kb/framework/plans/services-exchange.md).
 *
 * ⛔ Until 2026-10-07 the Section was a FULL LIST — the site's rows with the file's asks
 * applied — because the backend replaced it with what it was sent.
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

const ORIGIN = 'http://backend.test'

/** A project with `services` in site.yml (or none), and this backend's entry (or none). */
function project({ request = null, record = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uw-declare-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'pages', 'home.md'), '# Home\n')
  writeFileSync(
    join(dir, 'site.yml'),
    'name: demo\nfoundation: "@acme/marketing@1.0.0"\n' + (request ? request : '')
  )
  if (record) {
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ version: 1, backends: { [ORIGIN]: record } }))
  }
  return dir
}

const HELD = {
  site: { uuid: 'SITE-1' },
  services: { backend: 'U-api', search: 'U-search' },
  secrets: [{ name: 'token', service: 'backend', value: '#ref' }]
}

describe('the services a push states', () => {
  it("⭐ each service the file lists, whole — with the held one's $uuid", async () => {
    const doc = await siteProjectToDocument(
      project({ request: 'services:\n  backend:\n    grade: pro\n  submit: true\n  search: false\n', record: HELD }),
      { backend: ORIGIN }
    )
    expect(doc.services).toEqual([
      { $id: 'backend', name: 'backend', config: { grade: 'pro' }, $uuid: 'U-api' },
      { $id: 'submit', name: 'submit' },
      { $id: 'search', name: 'search', enabled: false, $uuid: 'U-search' }
    ])
  })

  it('⭐ a held service the file no longer lists is stated OFF, with no settings', async () => {
    const doc = await siteProjectToDocument(project({ request: 'services:\n  search: true\n', record: HELD }), {
      backend: ORIGIN
    })
    expect(doc.services).toEqual([
      { $id: 'search', name: 'search', $uuid: 'U-search' },
      { $id: 'backend', name: 'backend', enabled: false, $uuid: 'U-api' }
    ])
  })

  it('a file that lists nothing still states the held services off', async () => {
    const doc = await siteProjectToDocument(project({ record: HELD }), { backend: ORIGIN })
    expect(doc.services.map((r) => [r.name, r.enabled])).toEqual([
      ['backend', false],
      ['search', false]
    ])
  })

  it('nothing listed and nothing held sends no Section', async () => {
    const doc = await siteProjectToDocument(project({ record: { site: { uuid: 'SITE-1' } } }), { backend: ORIGIN })
    expect('services' in doc).toBe(false)
    const fresh = await siteProjectToDocument(project({ request: 'services: {}\n' }), { backend: ORIGIN })
    expect('services' in fresh).toBe(false)
  })

  it('a site not created yet holds nothing — the file is the list', async () => {
    const doc = await siteProjectToDocument(project({ request: 'services:\n  search: true\n' }), {
      backend: ORIGIN
    })
    expect(doc.services).toEqual([{ $id: 'search', name: 'search' }])
  })

  it('⛔ the rows a copy kept before 2026-10-07 — a list — are not a hold: nothing is stated off', async () => {
    const doc = await siteProjectToDocument(
      project({
        request: 'services:\n  search: true\n',
        record: { site: { uuid: 'SITE-1' }, services: [{ name: 'backend' }, { name: 'search' }] }
      }),
      { backend: ORIGIN }
    )
    expect(doc.services).toEqual([{ $id: 'search', name: 'search' }])
  })

  it('secrets ride from the entry, as before', async () => {
    const doc = await siteProjectToDocument(project({ record: HELD }), { backend: ORIGIN })
    expect(doc.secrets).toEqual([{ $id: 'backend:token', name: 'token', service: 'backend', value: '#ref' }])
  })

  it('no backend, nothing held: the file alone', async () => {
    const doc = await siteProjectToDocument(project({ request: 'services:\n  search: true\n', record: HELD }))
    expect(doc.services).toEqual([{ $id: 'search', name: 'search' }])
  })
})
