/**
 * `blueprint.yml` — how a backend started from a site begins (`src/uwx/blueprint.js`).
 *
 * ⭐ What is pinned here:
 *
 *   - its shape is checked early and offline, each refusal naming the key, and nothing past the
 *     shape is refused: a public query's `where`, `sort` and `limit` are the backend's to judge,
 *     and a type none of the site's foundations declares is a warning;
 *   - a push sends it as the `backend` row's `config.blueprint`, each `@/x` in full, on or off;
 *   - a pull writes it back with `@/x`, never into `site.yml`, and a pull of what was pushed
 *     changes no file; a row with no blueprint leaves the file alone, and says so;
 *   - a static build checks it and writes it nowhere.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import {
  readBlueprint,
  blueprintProblems,
  refuseUnreadableBlueprint,
  blueprintForWire,
  blueprintFromWire,
  blueprintWarnings,
  siteDeclaredTypes,
  writePulledBlueprint
} from '../src/uwx/blueprint.js'
import { siteProjectToDocument } from '../src/uwx/site.js'
import { emitSyncPackages, siteContentDocumentToProject, siteSelfScope } from '../src/uwx/index.js'
import { collectSiteContent } from '../src/site/content-collector.js'

let ROOT, SITE
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'uw-blueprint-'))
  SITE = join(ROOT, 'site')
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

const BACKEND = 'http://backend.test'

const w = (rel, body) => {
  const p = join(ROOT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// The doc's example, with comments, as an author writes it.
const BLUEPRINT = `# How a backend started from this site begins
signup: invite_only

teams:
  sales: { label: Sales }   # each one starts empty
  service: { label: Service }

access:
  '@/vehicle':
    add: [sales]
    all: { sales: edit }
  '@/store':
    add: []
    all: { members: read }

publicQueries:
  '@/vehicle': { whole: true, where: { status: { in: [available, pending] } } }
  '@/store': { whole: true }
`

const SITE_YML = 'name: T\nfoundation: fnd\nservices:\n  backend:\n    grade: small\n'

/** A site on a local foundation named `@acme/fnd`, whose own data schemas are `vehicle` and `store`. */
function makeSite({ siteYml = SITE_YML, blueprint = BLUEPRINT, ownSchemas = ['vehicle', 'store'], foundationName = '@acme/fnd' } = {}) {
  w('site/site.yml', siteYml)
  if (blueprint !== null) w('site/blueprint.yml', blueprint)
  w('site/package.json', { name: 'site', dependencies: { fnd: 'file:../fdn' } })
  w('site/pages/home/index.md', '---\ntype: Hero\n---\n\n# Home\n')
  w('fdn/package.json', { name: 'fnd', type: 'module', main: './_entry.generated.js' })
  w('fdn/main.js', `export default { name: '${foundationName}' }\n`)
  for (const name of ownSchemas) w(`fdn/schemas/${name}.yml`, `name: ${name}\nfields:\n  title: { type: string }\n`)
  return SITE
}

const backendRow = (doc) => doc.services?.find((r) => r.name === 'backend')

const WIRE = {
  signup: 'invite_only',
  teams: { sales: { label: 'Sales' }, service: { label: 'Service' } },
  access: {
    '@acme/vehicle': { add: ['sales'], all: { sales: 'edit' } },
    '@acme/store': { add: [], all: { members: 'read' } }
  },
  publicQueries: {
    '@acme/vehicle': { whole: true, where: { status: { in: ['available', 'pending'] } } },
    '@acme/store': { whole: true }
  }
}

describe('blueprint.yml — its shape', () => {
  it("the doc's example is a blueprint", () => {
    expect(blueprintProblems(yaml.load(BLUEPRINT))).toEqual([])
  })

  it('an empty file says nothing yet, and is one', () => {
    makeSite({ blueprint: '# to fill in\n' })
    expect(readBlueprint(SITE)).toEqual({})
    expect(blueprintProblems({})).toEqual([])
  })

  // Each line of the file's shape, refused by its key path — the path the backend's refusal names.
  const refused = [
    ['a key that is not one', { team: {} }, /`team` is not one of its keys/],
    ['a sign-up that is neither', { signup: 'closed' }, /`signup` is `open` or `invite_only`/],
    ['teams that are not a map', { teams: ['sales'] }, /`teams` is a map of teams by id/],
    ['a team id with capitals', { teams: { Sales: {} } }, /`teams\.Sales`: a team's id is lowercase/],
    ['`members` as a team', { teams: { members: {} } }, /`teams\.members`: `members` means every member/],
    ['a team that is not a map', { teams: { sales: null } }, /`teams\.sales` is a map — `sales: \{\}`/],
    ['a team key that is not `label`', { teams: { sales: { size: 3 } } }, /`teams\.sales\.size` is not a team's key/],
    ['a label that is no name', { teams: { sales: { label: 7 } } }, /`teams\.sales\.label` is the team's name/],
    ['two teams of one name', { teams: { sales: {}, crew: { label: 'sales' } } }, /`teams\.sales` and `teams\.crew` are both named `sales`/],
    ['a type with no `@`', { access: { vehicle: {} } }, /`access\.vehicle` names no type: .*`'@\/vehicle'`/],
    ['a line that is not a map', { access: { '@/x': null } }, /`access\.@\/x` is a map of `add` and `all`/],
    ['a key of a line that is not one', { access: { '@/x': { delete: [] } } }, /`access\.@\/x\.delete` is not one of a type's keys/],
    ['`add` as a word', { access: { '@/x': { add: 'sales' } } }, /`access\.@\/x\.add` is `open`, a list of teams, or `\[\]`/],
    ['`add` naming members', { access: { '@/x': { add: ['members'] } } }, /write `add: open`/],
    ['`add` naming a team the file does not found', { teams: {}, access: { '@/x': { add: ['sales'] } } }, /`access\.@\/x\.add` names `sales`, which is not one of `teams`/],
    ['`all` naming no team', { teams: {}, access: { '@/x': { all: { sales: 'read' } } } }, /`access\.@\/x\.all\.sales` is neither one of `teams` nor `members`/],
    ['the old `view`', { access: { '@/x': { all: { members: 'view' } } } }, /`access\.@\/x\.all\.members` is `view`: the level that reads every entry is `read`/],
    ['`admin`, which deletes', { access: { '@/x': { all: { members: 'admin' } } } }, /is `admin`, which deletes/],
    ['a public query that says nothing of `whole`', { publicQueries: { '@/x': { where: { a: 1 } } } }, /`publicQueries\.@\/x` says nothing of `whole`/],
    ['`whole` as a word', { publicQueries: { '@/x': { whole: 'yes' } } }, /`publicQueries\.@\/x\.whole` is the text `yes`.*Write `whole: true`/],
    ['a public query key that is not one', { publicQueries: { '@/x': { whole: false, page: 2 } } }, /`publicQueries\.@\/x\.page` is not one of a public query's keys/],
    ['a public query that is not a map', { publicQueries: { '@/x': true } }, /`publicQueries\.@\/x` is a map that says at least `whole`/]
  ]
  for (const [what, blueprint, message] of refused) {
    it(`refuses ${what}, by its key`, () => {
      expect(() => refuseUnreadableBlueprint(blueprint)).toThrow(message)
    })
  }

  it("⭐ leaves a public query's set to the backend: a sort with no limit, any where, any limit", () => {
    expect(
      blueprintProblems({
        publicQueries: {
          '@/x': { whole: false, sort: 'title' },
          '@/y': { whole: true, where: { 'a.b': { near: 3 } }, limit: 0 }
        }
      })
    ).toEqual([])
  })

  it('says one mistake once: a team it refuses is not refused again at each line naming it', () => {
    const found = blueprintProblems({ teams: { Sales: {} }, access: { '@/x': { add: ['Sales'], all: { Sales: 'edit' } } } })
    expect(found).toHaveLength(1)
  })
})

describe('reading the file', () => {
  it('none is null', () => {
    makeSite({ blueprint: null })
    expect(readBlueprint(SITE)).toBe(null)
  })

  it('a file that is not a map is refused', () => {
    makeSite({ blueprint: '- signup\n' })
    expect(() => readBlueprint(SITE)).toThrow(/blueprint\.yml is a map of `signup`, `teams`, `access` and `publicQueries`/)
  })

  it('⭐ an unquoted `@` key says to quote it — YAML names only the line', () => {
    makeSite({ blueprint: 'access:\n  @/vehicle:\n    add: open\n' })
    expect(() => readBlueprint(SITE)).toThrow(/A key that starts with `@` is quoted: `'@\/vehicle':`/)
  })
})

describe('blueprint.yml beside site.yml', () => {
  it('a `blueprint:` in site.yml is refused: the file is its one home', () => {
    expect(() =>
      refuseUnreadableBlueprint(null, { siteYml: { services: { backend: { blueprint: { signup: 'open' } } } } })
    ).toThrow(/`services\.backend\.blueprint` is not read from site\.yml.*`blueprint\.yml`/)
  })

  it('a blueprint beside a site.yml that asks for no backend is refused', () => {
    expect(() => refuseUnreadableBlueprint({ signup: 'open' }, { siteYml: { services: { search: true } } })).toThrow(
      /site\.yml asks for none\. Add `backend: true` under `services:`/
    )
    expect(() => refuseUnreadableBlueprint({ signup: 'open' }, { siteYml: {} })).toThrow(/asks for none/)
  })

  it('⭐ a backend that is off still carries it — a pull writes an off row back so', () => {
    for (const backend of [false, { enabled: false, grade: 'small' }, true, { grade: 'small' }]) {
      expect(() => refuseUnreadableBlueprint({ signup: 'open' }, { siteYml: { services: { backend } } })).not.toThrow()
    }
  })
})

describe('a push', () => {
  it('⭐ sends it as the backend row\'s `config.blueprint`, each type in full, beside the rest of the request', async () => {
    const doc = await siteProjectToDocument(makeSite())
    expect(backendRow(doc)).toEqual({ $id: 'backend', name: 'backend', config: { grade: 'small', blueprint: WIRE } })
  })

  it('CONTROL — with no blueprint the row is what it was', async () => {
    const doc = await siteProjectToDocument(makeSite({ blueprint: null }))
    expect(backendRow(doc)).toEqual({ $id: 'backend', name: 'backend', config: { grade: 'small' } })
  })

  it('an off backend carries it too', async () => {
    const doc = await siteProjectToDocument(makeSite({ siteYml: 'name: T\nfoundation: fnd\nservices:\n  backend: false\n' }))
    expect(backendRow(doc)).toEqual({ $id: 'backend', name: 'backend', enabled: false, config: { blueprint: WIRE } })
  })

  it('a type of another scope goes as written', async () => {
    const doc = await siteProjectToDocument(makeSite({ blueprint: "access:\n  '@std/person': { add: open }\n" }))
    expect(backendRow(doc).config.blueprint).toEqual({ access: { '@std/person': { add: 'open' } } })
  })

  it('⛔ two names for one type are refused: the row is a map, and one would be lost', async () => {
    makeSite({ blueprint: "access:\n  '@/vehicle': { add: open }\n  '@acme/vehicle': { add: [] }\n" })
    await expect(siteProjectToDocument(SITE)).rejects.toThrow(/`access\.@\/vehicle` and `access\.@acme\/vehicle` name one type, `@acme\/vehicle`/)
  })

  it('⛔ a malformed blueprint refuses the whole push', async () => {
    makeSite({ blueprint: "access:\n  '@/vehicle': { add: sales }\n" })
    await expect(emitSyncPackages(SITE, { backend: BACKEND })).rejects.toThrow(/`access\.@\/vehicle\.add` is `open`/)
  })

  it('⭐ warns of a type none of the foundations declares, and never refuses it', async () => {
    makeSite({ blueprint: "access:\n  '@/vehicle': { add: open }\n  '@/vehicel': { add: open }\n" })
    const pkg = await emitSyncPackages(SITE, { backend: BACKEND })
    const said = pkg.warnings.filter((m) => m.startsWith('blueprint.yml'))
    // CONTROL: the declared one is not named.
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/`access\.@\/vehicel` names a type none of this site's foundations declares/)
    expect(pkg.siteContent).not.toBe(null)
  })
})

describe('a pull', () => {
  /** What a backend holds after a push of these files: the document the push sent. */
  const pushed = async () => siteProjectToDocument(SITE, { backend: BACKEND })
  const pull = async (document) =>
    siteContentDocumentToProject({ document, siteRoot: SITE, backend: BACKEND, scope: await siteSelfScope(SITE) })

  it('⭐ a pull of what was pushed changes no file — comments and all', async () => {
    makeSite()
    const before = { blueprint: read('site/blueprint.yml'), site: read('site/site.yml') }
    const report = await pull(await pushed())
    expect(report.config.blueprint).toEqual({ file: 'unchanged' })
    expect(read('site/blueprint.yml')).toBe(before.blueprint)
    expect(read('site/site.yml')).toBe(before.site)
  })

  it('⭐ writes it to its own file with `@/x`, and never into site.yml', async () => {
    makeSite({ blueprint: null })
    const document = await pushed()
    backendRow(document).config.blueprint = WIRE
    const report = await pull(document)
    expect(report.config.blueprint).toEqual({ file: 'updated' })
    expect(yaml.load(read('site/blueprint.yml'))).toEqual(yaml.load(BLUEPRINT))
    expect(yaml.load(read('site/site.yml')).services).toEqual({ backend: { grade: 'small' } })
  })

  it('edits only what changed, and keeps a type the file names in full', async () => {
    makeSite({ blueprint: "# ours\nsignup: invite_only\naccess:\n  '@acme/vehicle': { add: open }   # in full\n" })
    const document = await pushed()
    backendRow(document).config.blueprint.signup = 'open'
    await pull(document)
    expect(read('site/blueprint.yml')).toBe("# ours\nsignup: open\naccess:\n  '@acme/vehicle': { add: open }   # in full\n")
  })

  it('⭐ a row with no blueprint leaves the file alone, and says the next push sends it', async () => {
    makeSite()
    const before = read('site/blueprint.yml')
    const document = await pushed()
    delete backendRow(document).config.blueprint
    const report = await pull(document)
    expect(report.config.blueprint.file).toBe('kept')
    expect(report.config.blueprint.note).toMatch(/holds no blueprint, so blueprint\.yml is left as it is\. The next push sends it/)
    expect(read('site/blueprint.yml')).toBe(before)
  })

  it('a site with no backend row leaves the file alone too, and says what the push needs', async () => {
    makeSite()
    const document = await pushed()
    document.services = document.services.filter((r) => r.name !== 'backend')
    const report = await pull(document)
    expect(report.config.blueprint.file).toBe('kept')
    expect(report.config.blueprint.note).toMatch(/asks for no backend/)
  })

  it('a document with no services says nothing of it', async () => {
    makeSite()
    const document = await pushed()
    delete document.services
    const report = await pull(document)
    expect(report.config.blueprint).toBeUndefined()
  })

  it('⭐ an off row with a blueprint, pulled into a copy whose site.yml names no backend, writes its line', async () => {
    makeSite({ siteYml: 'name: T\nfoundation: fnd\n', blueprint: null })
    const document = await siteProjectToDocument(SITE)
    document.services = [{ $id: 'backend', name: 'backend', enabled: false, config: { blueprint: WIRE } }]
    await pull(document)
    expect(yaml.load(read('site/site.yml')).services).toEqual({ backend: false })
    // …so the next push has the row to send the file on, as the site holds it.
    expect(backendRow(await siteProjectToDocument(SITE))).toEqual({ $id: 'backend', name: 'backend', enabled: false, config: { blueprint: WIRE } })
  })
})

describe('the wire, both ways', () => {
  it('names each type in full, and back as the foundation names it', () => {
    const file = yaml.load(BLUEPRINT)
    expect(blueprintForWire(file, '@acme')).toEqual(WIRE)
    expect(blueprintFromWire(WIRE, { scope: '@acme' })).toEqual(file)
  })

  it('with no scope, an `@/x` goes as written', () => {
    expect(blueprintForWire({ access: { '@/x': {} } }, null)).toEqual({ access: { '@/x': {} } })
  })

  it("a pull with no file to compare writes the site's as `@/x`", () => {
    makeSite({ blueprint: null })
    const rows = [{ name: 'backend', config: { blueprint: WIRE } }]
    expect(writePulledBlueprint({ siteRoot: SITE, rows, scope: '@acme' })).toEqual({ file: 'updated' })
    expect(yaml.load(read('site/blueprint.yml'))).toEqual(yaml.load(BLUEPRINT))
  })
})

describe('a static build', () => {
  it('⭐ checks it and writes it nowhere', async () => {
    makeSite()
    const content = await collectSiteContent(SITE)
    const text = JSON.stringify(content)
    for (const word of ['invite_only', 'publicQueries', 'vehicle', 'blueprint']) expect(text).not.toContain(word)
  })

  it('stops on a malformed one, as a push does', async () => {
    makeSite({ blueprint: 'signup: closed\n' })
    await expect(collectSiteContent(SITE)).rejects.toThrow(/blueprint\.yml: `signup` is `open` or `invite_only`/)
  })
})

describe('what a backend would leave out', () => {
  it('names a type the declared ones do not hold, by its key', () => {
    const declared = { types: new Set(['@acme/vehicle']) }
    expect(blueprintWarnings({ publicQueries: { '@/vehicle': { whole: true }, '@/stor': { whole: true } } }, { scope: '@acme', declared })).toEqual([
      expect.stringMatching(/^blueprint\.yml: `publicQueries\.@\/stor` names a type none of this site's foundations declares/)
    ])
  })

  it('says nothing when the declared types could not all be read', () => {
    expect(blueprintWarnings({ access: { '@/anything': {} } }, { scope: '@acme', declared: { types: null } })).toEqual([])
  })

  it('says an `@/x` goes as written while the foundation has no scope', () => {
    expect(blueprintWarnings({ access: { '@/vehicle': {} } }, { scope: null, declared: { types: null } })).toEqual([
      expect.stringMatching(/the foundation has no scope yet/)
    ])
  })

  it("reads the types a local foundation declares from its source — its `schemas/`", async () => {
    makeSite()
    const declared = await siteDeclaredTypes(SITE, yaml.load(read('site/site.yml')), { scope: '@acme' })
    expect([...declared.types].sort()).toEqual(['@acme/store', '@acme/vehicle'])
  })

  it('cannot read a cataloged foundation\'s, and says so', async () => {
    const declared = await siteDeclaredTypes(ROOT, { foundation: '@acme/fnd@1.0.0' }, { scope: '@acme' })
    expect(declared.types).toBe(null)
    expect(declared.unread[0]).toMatch(/`@acme\/fnd@1\.0\.0`, is not in this project/)
  })

  it("an extension it cannot read leaves the types unchecked", async () => {
    makeSite()
    const siteYml = { ...yaml.load(read('site/site.yml')), extensions: ['https://cdn.example.com/fx/entry.js'] }
    const declared = await siteDeclaredTypes(SITE, siteYml, { scope: '@acme' })
    expect(declared.types).toBe(null)
    expect(declared.unread).toEqual(['the extension `https://cdn.example.com/fx/entry.js` is not in this project'])
  })

  it('CONTROL — the file exists in the fixture', () => {
    makeSite()
    expect(existsSync(join(SITE, 'blueprint.yml'))).toBe(true)
  })
})
