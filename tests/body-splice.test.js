/**
 * ⭐ A PULL WRITES THE CHANGE, NOT A NEW RENDERING OF THE FILE (`src/uwx/body-splice.js`).
 *
 * ⛔ Until 2026-11-04 a changed section body was re-serialized whole. Measured that day over the 133
 * pages of three mounted docs folders: a one-word edit rewrote a median of 12 lines, every hard-wrapped
 * paragraph joined and every table rule rewritten. Through the splice, the same edit changed one line
 * at the median and seven at worst, and only the edited block's own lines in 132 of the 133.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { spliceBody } from '../src/uwx/body-splice.js'
import { writeSectionFile } from '../src/uwx/project-writer.js'

const AUTHORED = [
  '# Receiving content',
  '',
  'When you write a section type, the `content` prop arrives already parsed: the',
  "author's markdown has been read into named pieces before your component runs.",
  '',
  'The short version of the deal: the parser is defensive coding done once,',
  'upstream. You get to write render logic instead of text extraction.',
  '',
  '| field | holds |',
  '|---|---|',
  '| title | a string |',
  '',
  '- one',
  '- two',
].join('\n')

// The document with `word` appended to its `n`th paragraph, as an app edit would leave it.
function edited(n, word = 'edited') {
  const doc = markdownToProseMirror(AUTHORED)
  const paras = doc.content.filter((x) => x.type === 'paragraph')
  const text = paras[n].content.filter((c) => c.type === 'text').at(-1)
  text.text += ` ${word}`
  return doc
}
const lines = (s) => s.split('\n')
// The lines of `a` that `b` no longer holds, in order (outside their longest common run).
function removedLines(a, b) {
  const A = lines(a)
  const B = lines(b)
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  return A.length - dp[0][0]
}

describe('spliceBody', () => {
  it('⭐ an edit to one paragraph changes that paragraph\'s lines and no others', () => {
    const body = spliceBody(AUTHORED, edited(1))
    const before = lines(AUTHORED)
    const after = lines(body)
    // The other blocks are the author's text, wrapped as they were: the heading, the first paragraph,
    // the table with its own rule, the list.
    for (const kept of ['# Receiving content', "author's markdown has been read into named pieces before your component runs.", '|---|---|', '- two']) {
      expect(after).toContain(kept)
    }
    expect(after.filter((l) => !before.includes(l))).toEqual(['The short version of the deal: the parser is defensive coding done once, upstream. You get to write render logic instead of text extraction. edited'])
    expect(markdownToProseMirror(body)).toEqual(edited(1))
  })

  it('a block added in the app is written between the author\'s, which stay as they were', () => {
    const doc = markdownToProseMirror(AUTHORED)
    doc.content.splice(2, 0, { type: 'paragraph', content: [{ type: 'text', text: 'A paragraph from the app.' }] })
    const body = spliceBody(AUTHORED, doc)
    expect(body).toContain("When you write a section type, the `content` prop arrives already parsed: the\nauthor's markdown")
    expect(body).toContain('A paragraph from the app.')
    expect(markdownToProseMirror(body)).toEqual(doc)
  })

  it('a block removed in the app goes, and its neighbours stay as written', () => {
    const doc = markdownToProseMirror(AUTHORED)
    doc.content = doc.content.filter((x) => x.type !== 'table')
    const body = spliceBody(AUTHORED, doc)
    expect(body).not.toContain('| field |')
    expect(body).toContain('upstream. You get to write render logic instead of text extraction.\n\n- one')
  })

  it('CONTROL — the document unchanged gives the author\'s body back exactly', () => {
    expect(spliceBody(AUTHORED, markdownToProseMirror(AUTHORED))).toBe(AUTHORED)
  })
})

describe('writeSectionFile writes the change', () => {
  let DIR
  afterEach(() => DIR && rmSync(DIR, { recursive: true, force: true }))

  it('a section file keeps its frontmatter and every block the change left alone', () => {
    DIR = mkdtempSync(join(tmpdir(), 'body-splice-'))
    const file = join(DIR, 'guide.md')
    writeFileSync(file, `---\ntype: Section\n---\n\n${AUTHORED}\n`)
    expect(writeSectionFile({ filePath: file, content: edited(0, 'now'), params: { type: 'Section' } })).toBe('updated')
    const written = readFileSync(file, 'utf8')
    // The edited paragraph's two lines, and nothing else.
    expect(removedLines(`---\ntype: Section\n---\n\n${AUTHORED}\n`, written)).toBe(2)
    expect(written).toContain('The short version of the deal: the parser is defensive coding done once,\nupstream.')
    expect(written).toContain('runs. now')
  })
})
