/**
 * A section keeps its insets as the author wrote them.
 *
 * `inset_ref` (a leaf — `![alt](@C)`, `[text](@C)`, `[@key]`, `[#id]`) and `inset_block`
 * (a ```@C fence) stay in the section's content; `@uniweb/core` lifts both when it builds
 * the Block. ⛔ Until 2026-09-27 the collector extracted each leaf into a section-level
 * `insets[]` and left a placeholder — so the same section's content differed between a
 * build and any document stored as written.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { processMarkdownFile } from '../src/site/content-collector.js'

const MD = `---
type: Hero
---

# Welcome

![Platform overview](@Diagram){variant=compact}

As shown in [@darwin1859], it holds.

\`\`\`@Alert{type=note}
Inside, ![Chart](@Chart).
\`\`\`
`

describe('a section keeps its insets as written', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-insets-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('leaves every inset in the content and emits no insets[]', async () => {
    const file = join(dir, 'hero.md')
    writeFileSync(file, MD)
    const { section } = await processMarkdownFile(file, '0', dir)

    expect(section).not.toHaveProperty('insets')
    const types = []
    const walk = (nodes) => nodes?.forEach((n) => { types.push(n.type); walk(n.content) })
    walk(section.content.content)

    expect(types).not.toContain('inset_placeholder')
    expect(types.filter((t) => t === 'inset_ref')).toHaveLength(3) // Diagram, the cite, the Chart in the fence
    expect(types).toContain('inset_block')
  })

  it('keeps an inline reference inline, with its attributes', async () => {
    const file = join(dir, 'hero.md')
    writeFileSync(file, MD)
    const { section } = await processMarkdownFile(file, '0', dir)

    const paragraph = section.content.content.find(
      (n) => n.type === 'paragraph' && n.content?.some((c) => c.type === 'inset_ref')
    )
    const cite = paragraph.content.find((c) => c.type === 'inset_ref')
    expect(cite.attrs).toMatchObject({ component: 'Cite', embedKind: 'text', key: '@darwin1859' })
  })
})
