import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { loadFoundationInfo } from '../src/site/content-collector.js'

// `loadFoundationInfo().hasContentHandler` — does this foundation declare the
// hook that resolves `{…}` in page content?
//
// ⭐ ITS ONLY CONSUMER IS A WARNING, and that is the point. Resolving
// placeholders is a foundation capability (`handlers.content`, normally
// @uniweb/loom), not something the framework does for every site — so a site
// that declares `placeholders:` under a foundation without the hook gets a block
// nothing reads, and the page renders the literal `{vendor.email}`. That reads
// as an authoring typo, so the build says so once.
//
// ⚠️ IT CANNOT TELL WHICH ENGINE THE HANDLER USES. A handler is a function and
// the build never calls it, so this answers "something could resolve this",
// never "Loom will". Don't grow a claim on top of it that needs the stronger one.

const ROOTS = []

function foundation(mainJs) {
  const root = mkdtempSync(join(tmpdir(), 'fnd-handler-'))
  ROOTS.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'f', type: 'module' }))
  writeFileSync(join(root, 'src', 'main.js'), mainJs)
  return root
}

afterEach(() => {
  while (ROOTS.length) rmSync(ROOTS.pop(), { recursive: true, force: true })
})

describe('loadFoundationInfo — content-handler detection', () => {
  it('is true when the foundation declares handlers.content', async () => {
    const root = foundation('export default { handlers: { content: (d, b) => null } }\n')
    expect((await loadFoundationInfo(root)).hasContentHandler).toBe(true)
  })

  it('is false for a foundation that declares no handlers', async () => {
    const root = foundation(
      "export const vars = { 'header-height': { default: '4rem' } }\nexport default {}\n"
    )
    expect((await loadFoundationInfo(root)).hasContentHandler).toBe(false)
  })

  // A `handlers` block carrying only the OTHER hooks is still no reader for a
  // placeholder — `data` reshapes the data, `props` runs after parsing, and
  // neither touches the raw ProseMirror the placeholders live in.
  it('is false when handlers exist but content is not among them', async () => {
    const root = foundation(
      'export default { handlers: { data: (d) => d, props: (c, p) => ({ content: c, params: p }) } }\n'
    )
    expect((await loadFoundationInfo(root)).hasContentHandler).toBe(false)
  })

  it('is false when there is no foundation path at all', async () => {
    expect((await loadFoundationInfo(null)).hasContentHandler).toBe(false)
  })
})
