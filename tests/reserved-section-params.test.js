/**
 * A component param named after one of a section's own settings — `theme`, `background`,
 * `grid`, `vars`, `sticky` (`@uniweb/schemas/section`) — never receives what an author writes: framework
 * applies those, and a component reads them from its block [Diego, 2026-09-28]. The build stops,
 * naming every one at once [Diego, 2026-11-11]; it warned until then.
 */

import { reportPlacementDeclarations } from '../src/schema.js'
import { SECTION_KEYS } from '@uniweb/schemas/section'

let warnings
beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
})
afterEach(() => vi.restoreAllMocks())

/** What the build says when it stops, or null when it goes on. */
const stopsWith = (components) => {
  try {
    reportPlacementDeclarations(components)
    return null
  } catch (err) {
    return err.message
  }
}

describe('a component param named after a section setting', () => {
  it('stops the build, naming each of them at once', () => {
    const text = stopsWith({
      Hero: { name: 'Hero', params: { theme: { type: 'select' }, background: {}, vars: {}, grid: {}, sticky: {}, layout: {} } },
    })
    for (const name of ['theme', 'background', 'vars', 'grid', 'sticky']) expect(text).toMatch(new RegExp(`params declares "${name}", a setting of the section`))
    expect(text).not.toMatch(/params declares "layout"/)
  })

  it('and for a key a section keeps for itself — every one of SECTION_KEYS', () => {
    const names = Object.keys(SECTION_KEYS)
    const text = stopsWith({ Hero: { name: 'Hero', params: Object.fromEntries([...names, 'layout'].map((n) => [n, {}])) } })
    for (const name of names) expect(text).toMatch(new RegExp(`params declares "${name}", a key a section's frontmatter keeps for itself`))
    expect(text).not.toMatch(/params declares "layout"/)
  })

  it('says nothing about a component whose params are its own', () => {
    expect(stopsWith({ Hero: { name: 'Hero', params: { layout: {}, variant: {} } } })).toBeNull()
    expect(warnings).toEqual([])
  })
})
