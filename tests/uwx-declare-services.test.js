/**
 * The `services` Section — the owner's request, from `site.yml::services`.
 *
 * ⭐ Sent as a FULL LIST: the site's rows with the owner's asks applied by name, each
 * WHOLE, because the backend REPLACES the Section with what it is sent and a row left
 * out would be deleted. Which asks go is the caller's to decide — push and
 * publish read the site's rows and the last agreement, and pass the result as
 * `serviceRows`; without it, the file's asks apply over the record in `sync.json`
 * (spec: kb/framework/reference/site-services-request.md).
 *
 * ⛔ Absent is never empty: nothing here may turn "the file asks nothing" into `[]`,
 * which would drop every stored row.
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

/** A project with `services` in site.yml (or none), and this backend's record (or none). */
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

const STORED = {
  site: { uuid: 'SITE-1' },
  services: [
    { name: 'api', config: { grade: 'starter', auth: { providers: ['google'] } } },
    { name: 'search' }
  ],
  secrets: [{ name: 'token', service: 'api', value: '#ref' }]
}

describe('the services request', () => {
  it('⭐ applies the asks over the record — every stored row kept, each named one as the file says it', async () => {
    const doc = await siteProjectToDocument(
      project({ request: 'services:\n  api:\n    grade: pro\n  submit: true\n  search: false\n', record: STORED }),
      { backend: ORIGIN }
    )
    expect(doc.services).toEqual([
      // The file names api, so its entry is api WHOLE: `auth`, not in the file, is gone.
      { $id: 'api', name: 'api', config: { grade: 'pro' } },
      { $id: 'search', name: 'search', enabled: false },
      { $id: 'submit', name: 'submit' }
    ])
  })

  it('a file that asks nothing sends no Section — never `[]`', async () => {
    // `[]` would drop every stored row; an absent key leaves them alone.
    const doc = await siteProjectToDocument(project({ record: STORED }), { backend: ORIGIN })
    expect('services' in doc).toBe(false)
    const empty = await siteProjectToDocument(project({ request: 'services: {}\n', record: STORED }), {
      backend: ORIGIN
    })
    expect('services' in empty).toBe(false)
  })

  it('⛔ an existing site this project holds no record for is sent nothing', async () => {
    // A partial list would drop the site's other rows. The CLI reads the site's rows
    // and passes them; with neither, there is nothing to apply the asks to.
    const doc = await siteProjectToDocument(
      project({ request: 'services:\n  search: true\n', record: { site: { uuid: 'SITE-1' } } }),
      { backend: ORIGIN }
    )
    expect('services' in doc).toBe(false)
  })

  it('a site not created yet has nothing stored — the asks are the list', async () => {
    const doc = await siteProjectToDocument(project({ request: 'services:\n  search: true\n' }), {
      backend: ORIGIN
    })
    expect(doc.services).toEqual([{ $id: 'search', name: 'search' }])
  })

  it("the caller's rows are sent as given", async () => {
    const rows = [{ name: 'api', config: { grade: 'pro' } }, { name: 'search', enabled: false }]
    const doc = await siteProjectToDocument(
      project({ request: 'services:\n  search: false\n', record: STORED }),
      { backend: ORIGIN, serviceRows: rows }
    )
    expect(doc.services).toEqual([
      { $id: 'api', name: 'api', config: { grade: 'pro' } },
      { $id: 'search', name: 'search', enabled: false }
    ])
  })

  it('secrets ride from the record, as before', async () => {
    const doc = await siteProjectToDocument(project({ record: STORED }), { backend: ORIGIN })
    expect(doc.secrets).toEqual([{ $id: 'api:token', name: 'token', service: 'api', value: '#ref' }])
  })
})

describe('declareServices: false', () => {
  it('withholds both Sections', async () => {
    const doc = await siteProjectToDocument(
      project({ request: 'services:\n  search: true\n', record: STORED }),
      { backend: ORIGIN, declareServices: false, serviceRows: [{ name: 'search' }] }
    )
    // ⭐ ABSENT, not empty.
    expect('services' in doc).toBe(false)
    expect('secrets' in doc).toBe(false)
  })

  it('only `false` withholds — an absent or true option declares', async () => {
    for (const opts of [{}, { declareServices: true }, { declareServices: undefined }]) {
      const doc = await siteProjectToDocument(
        project({ request: 'services:\n  search: true\n', record: STORED }),
        { backend: ORIGIN, ...opts }
      )
      expect(doc.services, JSON.stringify(opts)).toBeDefined()
    }
  })

  it('withholding changes nothing else about the document', async () => {
    const dir = project({ request: 'services:\n  search: true\n', record: STORED })
    const declared = await siteProjectToDocument(dir, { backend: ORIGIN })
    const withheld = await siteProjectToDocument(dir, { backend: ORIGIN, declareServices: false })
    const strip = (d) => {
      const { services: _s, secrets: _x, ...rest } = d
      return rest
    }
    expect(strip(withheld)).toEqual(strip(declared))
  })
})
