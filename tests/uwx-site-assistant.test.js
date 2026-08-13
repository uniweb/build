import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { siteProjectToDocument } from '../src/uwx/index.js'

// `assistant:` on the sync wire.
//
// This lane is an explicit allowlist while the bundle lane spreads all of
// site.yml, so a key that is not listed works on a static host and vanishes
// silently on the synced lane. That is not a hypothetical: the predecessor of
// this block lived in a SEPARATE file (`intelligence.yml`), which needed a
// bespoke line in each lane and got one in only the bundle lane — so an
// authored persona never reached a hosted site at all, with no error and a
// payload that still parsed.
//
// The first two cases below are the ones that would have caught it.
//
// See kb/framework/architecture/assistant-config.md.

const ROOTS = []

function siteRoot(siteYmlLines) {
  const root = mkdtempSync(join(tmpdir(), 'uwx-assistant-'))
  ROOTS.push(root)
  mkdirSync(join(root, 'pages'), { recursive: true })
  writeFileSync(
    join(root, 'site.yml'),
    ['name: Acme Site', 'foundation: "@acme/marketing@1.2.3"', ...siteYmlLines].join('\n')
  )
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  while (ROOTS.length) rmSync(ROOTS.pop(), { recursive: true, force: true })
})

describe('uwx/site — the assistant block reaches the wire', () => {
  it('carries an authored block onto info', async () => {
    const root = siteRoot([
      'assistant:',
      '  system: You are the Acme support assistant.',
      '  model: claude-sonnet-4',
    ])
    const { info } = await siteProjectToDocument(root)
    expect(info.assistant).toEqual({
      system: 'You are the Acme support assistant.',
      model: 'claude-sonnet-4',
    })
  })

  it('carries the string shorthand untouched', async () => {
    const root = siteRoot(['assistant: /_agent/chat'])
    const { info } = await siteProjectToDocument(root)
    expect(info.assistant).toBe('/_agent/chat')
  })

  // The claim that adding this line is inert for every existing site rests on
  // this: `setIf` skips an absent value, so a site that never heard of
  // `assistant:` emits no key rather than an empty one.
  it('emits no key at all when the site declares none', async () => {
    const root = siteRoot([])
    const { info } = await siteProjectToDocument(root)
    expect(info).not.toHaveProperty('assistant')
  })
})

// An authored block crosses into backend storage here and is served from there
// in a world-readable payload, so a credential in site.yml is disclosed rather
// than merely untidy. The delivery edge strips the same key set on the reading
// side; this is the producer half of that pair.
describe('uwx/site — credentials never reach the wire', () => {
  it('drops every credential-shaped key and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = siteRoot([
      'assistant:',
      '  system: Be helpful.',
      '  apiKey: sk-live-must-not-ship',
      '  api_key: also-not',
      '  token: nor-this',
      '  secret: nor-this-either',
      '  key: nor-this-one',
    ])

    const { info } = await siteProjectToDocument(root)

    expect(info.assistant).toEqual({ system: 'Be helpful.' })
    expect(JSON.stringify(info)).not.toContain('sk-live-must-not-ship')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('apiKey'))
  })

  // Dropping to `{}` rather than to nothing is deliberate: the author looks for
  // their block in the payload, and a vanished one reads as "never written"
  // instead of "written wrongly".
  it('leaves an empty block rather than removing it entirely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = siteRoot(['assistant:', '  apiKey: sk-live-only-key-present'])
    const { info } = await siteProjectToDocument(root)
    expect(info.assistant).toEqual({})
  })

  it('does not warn when there is nothing to strip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = siteRoot(['assistant:', '  system: Be helpful.'])
    await siteProjectToDocument(root)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('dropped'))
  })
})
