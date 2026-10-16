/**
 * ⭐ A PULL INTO A COPY THAT ALREADY HOLDS A SECTION WRITES THE SECTION AS THE BACKEND HOLDS IT.
 *
 * Measured 2026-10-16 with `uniweb 1.6.0`: a teammate re-pointed a section's `fetch:` from one query
 * to another and pushed (or an editor changed which records the section shows). The developer's
 * pull exited 0 and left the file's `fetch:` as it was. The pull still recorded the backend's
 * version as taken, so the developer's next edit to that section pushed the old declaration back
 * over the new one, with no refusal.
 *
 * Every test of a pulled declaration until then pulled into an EMPTY directory, where nothing in
 * a file can be kept. This one pulls into the copy that pushed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const dirs = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

const SITE = {
  'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
  'queries.yml': 'people:\n  schema: "@std/person"\nalumni:\n  schema: "@std/person"\n',
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/hero.md': '---\ntype: Hero\n---\n\n# Hi\n',
}

// A copy of the site, with the People section written as `people`.
function copy(people) {
  const root = mkdtempSync(join(tmpdir(), 'pull-takes-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({ ...SITE, 'pages/home/people.md': people })) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

const peopleOf = async (root) =>
  (await siteProjectToDocument(root)).pages[0].page_sections.find((s) => s.stable_id === 'people')

// The developer's copy, the teammate's copy with the change, and the teammate's push pulled in.
async function pullTeammate(mine, theirs) {
  const dev = copy(mine)
  const teammate = copy(theirs)
  const pushed = await siteProjectToDocument(teammate)
  siteContentDocumentToProject({ document: pushed, siteRoot: dev })
  return { dev, file: readFileSync(join(dev, 'pages/home/people.md'), 'utf8'), pushed }
}

describe('a pull into an existing copy — the section’s data declaration', () => {
  it('⭐ takes a changed `fetch:`, under the key the file uses', async () => {
    const { file } = await pullTeammate(
      '---\ntype: Team\nfetch: { query: people }\n---\n\n# People\n',
      '---\ntype: Team\nfetch: { query: alumni }\n---\n\n# People\n'
    )
    expect(file).toMatch(/^fetch:/m)
    expect(file).toMatch(/alumni/)
    expect(file).not.toMatch(/people$/m)
  })

  it('⭐ …so the developer’s next edit to the section pushes the teammate’s declaration, not the old one', async () => {
    const { dev, pushed } = await pullTeammate(
      '---\ntype: Team\nfetch: { query: people }\n---\n\n# People\n',
      '---\ntype: Team\nfetch: { query: alumni }\n---\n\n# People\n'
    )
    const path = join(dev, 'pages/home/people.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('# People', '# People\n\nAn edit.'))
    const theirs = pushed.pages[0].page_sections.find((s) => s.stable_id === 'people')
    expect((await peopleOf(dev)).params.fetch).toEqual(theirs.params.fetch)
  })

  it('takes a changed `query:` shorthand', async () => {
    const { file } = await pullTeammate(
      '---\ntype: Team\nquery: people\n---\n\n# People\n',
      '---\ntype: Team\nquery: alumni\n---\n\n# People\n'
    )
    expect(file).toMatch(/^query: alumni$/m)
  })

  it('replaces `query:` with `fetch:` when the declaration became one `query:` cannot say — never both', async () => {
    const { file } = await pullTeammate(
      '---\ntype: Team\nquery: people\n---\n\n# People\n',
      '---\ntype: Team\nfetch: { query: alumni, limit: 3 }\n---\n\n# People\n'
    )
    expect(file).not.toMatch(/^query:/m)
    expect(file).toMatch(/^fetch:/m)
    expect(file).toMatch(/limit: 3/)
  })

  it('removes the declaration the backend’s section no longer has', async () => {
    const { file } = await pullTeammate(
      '---\ntype: Team\nquery: people\n---\n\n# People\n',
      '---\ntype: Team\n---\n\n# People\n'
    )
    expect(file).not.toMatch(/^(query|fetch):/m)
  })

  it('CONTROL — a pull that changes nothing leaves the file byte for byte, its comments included', async () => {
    const authored = '---\ntype: Team\nfetch:\n  # Who we are.\n  query: people\n---\n\n# People\n'
    const { file } = await pullTeammate(authored, authored)
    expect(file).toBe(authored)
  })
})

describe('a pull into an existing copy — the rest of the section’s frontmatter', () => {
  it('takes a changed `type:`', async () => {
    const { file } = await pullTeammate('---\ntype: Team\n---\n\n# People\n', '---\ntype: Cards\n---\n\n# People\n')
    expect(file).toMatch(/^type: Cards$/m)
  })

  it('removes a param the backend’s section no longer has', async () => {
    const { file } = await pullTeammate(
      "---\ntype: Team\nbackground: '#eee'\ntheme: dark\n---\n\n# People\n",
      '---\ntype: Team\ntheme: dark\n---\n\n# People\n'
    )
    expect(file).not.toMatch(/background/)
    expect(file).toMatch(/^theme: dark$/m)
  })

  it('CONTROL — keeps what a push does not send as a param: the file’s `id:`', async () => {
    const authored = '---\ntype: Team\nid: people\nbackground: "#eee"\n---\n\n# People\n'
    const { file } = await pullTeammate(authored, '---\ntype: Team\nid: people\n---\n\n# People\n')
    expect(file).toMatch(/^id: people$/m)
    expect(file).not.toMatch(/background/)
  })
})
