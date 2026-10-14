/**
 * ⛔ A PULL THAT WOULD DROP CONTENT WRITES NOTHING.
 *
 * A node a markdown file cannot hold is left out of the file it is written to,
 * and the push after the pull then deletes it from the site. Measured 2026-10-14:
 * a button an editor saved as a node was omitted by `uniweb pull` with one log
 * line, and the developer's next push deleted it, with nothing reaching the
 * author. The projection now asks first and refuses, naming what and where.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteProjectToDocument, siteContentDocumentToProject } from '../src/uwx/index.js'

const made = []
afterEach(() => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const dir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}

async function documentOf(files) {
  const root = dir('uwx-drop-src-')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return siteProjectToDocument(root)
}

const FILES = {
  'site.yml': 'name: Site\nfoundation: "@acme/fnd@1.0.0"\nindex: home\n',
  'pages/home/page.yml': 'title: Home\n',
  'pages/home/1-hero.md': '---\ntype: Hero\n---\n\n# Welcome\n\nA paragraph.\n',
}

/** Every section document in the projected site, wherever it sits. */
function sectionDocs(document) {
  const docs = []
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit)
    if (!v || typeof v !== 'object') return
    if (v.type === 'doc' && Array.isArray(v.content)) docs.push(v)
    Object.values(v).forEach(visit)
  }
  visit(document.pages)
  return docs
}

describe('a pull that would drop content', () => {
  it('writes nothing, and names the section and what it holds', async () => {
    const document = await documentOf(FILES)
    const [doc] = sectionDocs(document)
    doc.content.push({ type: 'mysteryWidget', attrs: {} })

    const target = dir('uwx-drop-dest-')
    expect(() => siteContentDocumentToProject({ document, siteRoot: target })).toThrow(
      /would leave content out of your files[\s\S]*Nothing was written\.\n  home\/hero: mysteryWidget\n/,
    )
    expect(readdirSync(target)).toEqual([])
  })

  it('CONTROL — a document the files can hold is projected', async () => {
    const document = await documentOf(FILES)
    const target = dir('uwx-drop-ok-')
    siteContentDocumentToProject({ document, siteRoot: target })
    expect(readdirSync(target)).toEqual(expect.arrayContaining(['site.yml', 'pages']))
  })
})
