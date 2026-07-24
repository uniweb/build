/**
 * The pre-paint appearance script and the prerender seam.
 *
 * The script itself lives in @uniweb/runtime (appearance.js) and is emitted by
 * the shared injectPageContent(), so every prerender lane gets it — the
 * framework's SSG and the cloud worker's just-in-time render alike. Its behavior
 * is tested there, including that the serialized form and the SPA boot path
 * resolve identically.
 *
 * What belongs here is the build side of that contract: injectBuildData() must
 * NOT own the script, and must not disturb one the shared seam already injected.
 * It used to own it, which is why cloud-rendered pages flashed light for every
 * dark-mode visitor.
 */

import { describe, it, expect } from 'vitest'
import { injectBuildData } from '../src/prerender.js'

describe('injectBuildData — appearance boot script', () => {
  const html = '<html><head></head><body>content</body></html>'

  it('does not inject the script itself', () => {
    // Injecting here would reach only the build lane. injectPageContent runs
    // just before this and covers every lane.
    const out = injectBuildData(html, { theme: { appearance: { allowToggle: true } } })
    expect(out).not.toContain('id="uniweb-appearance"')
  })

  it('preserves a script the shared seam already injected', () => {
    const prerendered =
      '<html><head><script id="uniweb-appearance">/* from injectPageContent */</script></head><body>c</body></html>'
    const out = injectBuildData(prerendered, { theme: { appearance: { allowToggle: true } } })
    expect(out.match(/id="uniweb-appearance"/g)).toHaveLength(1)
    expect(out.indexOf('id="uniweb-appearance"')).toBeLessThan(out.indexOf('</head>'))
  })
})
