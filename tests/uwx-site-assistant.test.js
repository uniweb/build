import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { siteProjectToDocument } from '../src/uwx/index.js'

// `services.assistant` on the sync wire — its site tier rides `settings.assistant`.
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
// The assistant's entry is `site.yml::services.assistant` (the top-level `assistant:`
// key until 2026-10-06, refused now). It rides its row in the `services` Section, whole,
// minus credentials — the persona included — and what a hosted page gets of it is the
// host's to project. (`settings.assistant` carried it until the evening of 2026-10-06.)

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
  it('carries an authored block in its row, whole', async () => {
    const root = siteRoot([
      'services:',
      '  assistant:',
      '    system: You are the Acme support assistant.',
      '    model: claude-sonnet-4',
    ])
    const { settings, services } = await siteProjectToDocument(root)
    expect(services).toEqual([
      {
        $id: 'assistant',
        name: 'assistant',
        config: { system: 'You are the Acme support assistant.', model: 'claude-sonnet-4' },
      },
    ])
    // ⛔ One place: nothing of it beside the row.
    expect(settings?.assistant).toBeUndefined()
  })

  it('carries an address as `endpoint` — the site brings its own assistant', async () => {
    const root = siteRoot(['services:', '  assistant: https://agent.example.com/chat'])
    const { settings, services } = await siteProjectToDocument(root)
    // …and asks the host to leave its own off, or the host's would win.
    expect(services).toEqual([
      { $id: 'assistant', name: 'assistant', enabled: false, config: { endpoint: 'https://agent.example.com/chat' } },
    ])
    expect(settings?.assistant).toBeUndefined()
  })

  // The claim that adding this line is inert for every existing site rests on
  // this: `setIf` skips an absent value, so a site that never heard of
  // `assistant:` emits no key rather than an empty one.
  it('emits no key at all when the site declares none', async () => {
    const root = siteRoot([])
    const { info, settings } = await siteProjectToDocument(root)
    expect(info).not.toHaveProperty('assistant')
  })
})

// An authored block crosses into backend storage here and is served from there
// in a world-readable payload, so a credential in site.yml is disclosed rather
// than merely untidy. The delivery edge strips the same key set on the reading
// side; this is the producer half of that pair.
describe('uwx/site — credentials never reach the wire', () => {
  it('drops every credential-shaped key from the row', async () => {
    const root = siteRoot([
      'services:',
      '  assistant:',
      '    system: Be helpful.',
      '    apiKey: sk-live-must-not-ship',
      '    api_key: also-not',
      '    token: nor-this',
      '    secret: nor-this-either',
      '    key: nor-this-one',
    ])

    const doc = await siteProjectToDocument(root)

    expect(doc.services).toEqual([{ $id: 'assistant', name: 'assistant', config: { system: 'Be helpful.' } }])
    // The strongest form: nothing of any credential anywhere in the document.
    for (const leaked of ['sk-live-must-not-ship', 'also-not', 'nor-this']) {
      expect(JSON.stringify(doc)).not.toContain(leaked)
    }
  })

  it('an entry holding only a credential still asks for the service; nothing of the key travels', async () => {
    // The warning is the CLI's and the build's to give (`readServicesRequest`,
    // `runtimeServicesConfig`); the producer runs on every emit and stays quiet.
    const root = siteRoot(['services:', '  assistant:', '    apiKey: sk-live-only-key-present'])
    const doc = await siteProjectToDocument(root)
    expect(doc.settings?.assistant).toBeUndefined()
    expect(doc.services).toEqual([{ $id: 'assistant', name: 'assistant' }])
    expect(JSON.stringify(doc)).not.toContain('sk-live-only-key-present')
  })
})
