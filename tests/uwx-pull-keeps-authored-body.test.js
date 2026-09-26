/**
 * ⭐ A PULL THAT CHANGES NOTHING IN A SECTION LEAVES ITS FILE AS THE AUTHOR WROTE IT.
 *
 * Measured 2026-09-26 on the `marketing` template: a pull into the copy that pushed it rewrote
 * every section it touched — a blank line after each heading, one between two headings — though
 * the next push found nothing to send. The writer's markdown is not the author's.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markdownToProseMirror } from '@uniweb/content-reader'
import { writeSectionFile } from '../src/uwx/index.js'

let DIR
afterEach(() => DIR && rmSync(DIR, { recursive: true, force: true }))

const BODY = '# Core Platform\n\n### Instant Deploys\n![](lu-rocket)\nPush to main, see it live in seconds.'
const AUTHORED = `---\ntype: Features\nid: features\n---\n\n${BODY}\n`

function write(content, params = { type: 'Features', id: 'features' }) {
  DIR = mkdtempSync(join(tmpdir(), 'uwx-keeps-body-'))
  const filePath = join(DIR, 'features.md')
  writeFileSync(filePath, AUTHORED)
  const status = writeSectionFile({ filePath, content, params })
  return { status, text: readFileSync(filePath, 'utf8') }
}

describe('pull — a section it did not change', () => {
  it('⭐ is left byte for byte as the author wrote it', () => {
    const { status, text } = write(markdownToProseMirror(BODY))
    expect(status).toBe('unchanged')
    expect(text).toBe(AUTHORED)
  })

  it('keeps the author’s body text when only its frontmatter changed', () => {
    const { status, text } = write(markdownToProseMirror(BODY), { type: 'Features', id: 'features', theme: 'dark' })
    expect(status).toBe('updated')
    expect(text).toContain('theme: dark')
    expect(text).toContain(BODY)
  })

  it('CONTROL — a body that changed is written from the pulled document', () => {
    const { status, text } = write(markdownToProseMirror('# Core Platform\n\nSomething new.'))
    expect(status).toBe('updated')
    expect(text).toContain('Something new.')
    expect(text).not.toContain('Instant Deploys')
  })
})
