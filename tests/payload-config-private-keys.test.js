/**
 * `$`-prefixed site.yml keys must not reach the published payload.
 *
 * `config` on the bundle lane is site.yml spread whole. That spread carried the
 * project's BACKEND-SCOPED state — `$uuid`, `$org`, `$backend`, `$services` /
 * `$secrets` — into an artifact any visitor can fetch; and since 2026-10-06 it must
 * not carry `services:` either, the owner's request to their host.
 *
 * For four of those it is noise with no reader (nothing in core, runtime or kit
 * reads a `config.$*` key). For `$secrets` it is a disclosure: the entries carry
 * no values, only the marker `#ref`, but they NAME every secret the site has, and
 * an inventory of credential names has no business in an exported bundle.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSiteContent } from '../src/site/content-collector.js'

describe('collectSiteContent — $-prefixed keys stay out of the payload', () => {
  let siteDir

  async function makeSite(siteYml) {
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-private-keys-'))
    await mkdir(join(siteDir, 'pages', 'home'), { recursive: true })
    await writeFile(join(siteDir, 'site.yml'), siteYml)
    await writeFile(join(siteDir, 'pages', 'home', 'index.md'), '---\ntype: Hero\n---\n\n# Hi\n')
    return siteDir
  }

  afterEach(async () => {
    if (siteDir) await rm(siteDir, { recursive: true, force: true })
    siteDir = undefined
  })

  it('drops every $-prefixed key, including the secret inventory', async () => {
    const dir = await makeSite(
      'name: Test\n' +
        "$uuid: '019e3c01-0000-7c0d-8a03-000000000002'\n" +
        '$org: acme\n' +
        "$backend: 'https://uniweb.app'\n" +
        '$services:\n  - name: api\n' +
        "$secrets:\n  - service: api\n    name: stripe_key\n    value: '#ref'\n"
    )

    const { config } = await collectSiteContent(dir)

    for (const key of ['$uuid', '$org', '$backend', '$services', '$secrets']) {
      expect(config[key]).toBeUndefined()
    }
    // The strongest form of the disclosure check: the secret's NAME must not
    // appear anywhere in the serialized payload, however it got there.
    expect(JSON.stringify(config)).not.toContain('stripe_key')
  })

  it('⭐ ships each service as its site tier — never the block whole', async () => {
    // At `config.services` the block would be the HOST tier, where a present block
    // declines every service it does not name. Each entry lands at `config.<name>`
    // instead: `false`, an address, or its options. `true` is the default and says
    // nothing.
    const dir = await makeSite(
      'name: Test\nservices:\n  search:\n    exclude: { routes: [/legal] }\n  submit: /forms\n  tracking: false\n  assistant: true\n'
    )

    const { config } = await collectSiteContent(dir)

    expect(config.services).toBeUndefined()
    expect(config.search).toEqual({ exclude: { routes: ['/legal'] } })
    expect(config.submit).toBe('/forms')
    expect(config.tracking).toBe(false)
    expect(config).not.toHaveProperty('assistant')
    expect(config.name).toBe('Test')
  })

  it("⛔ api's settings and every credential stay out of the payload", async () => {
    const dir = await makeSite(
      'name: Test\nservices:\n  api:\n    endpoint: https://backend.example.com/_api\n    grade: pro\n' +
        '  assistant:\n    system: Be helpful.\n    apiKey: sk-live-must-not-ship\n'
    )

    const { config } = await collectSiteContent(dir)

    expect(config.api).toEqual({ endpoint: 'https://backend.example.com/_api' })
    expect(config.assistant).toEqual({ system: 'Be helpful.' })
    expect(JSON.stringify(config)).not.toContain('pro')
    expect(JSON.stringify(config)).not.toContain('sk-live')
  })

  it('⛔ refuses the retired top-level service keys, naming the move', async () => {
    const dir = await makeSite('name: Test\nsubmit: /forms\nsearch: false\n')
    await expect(collectSiteContent(dir)).rejects.toThrow(/`search:`, `submit:` are retired — a service lives under `services:`/)
  })

  it('leaves ordinary keys alone', async () => {
    const dir = await makeSite('name: Test\nbase: /docs/\nservices:\n  search: false\n')

    const { config } = await collectSiteContent(dir)

    expect(config.search).toBe(false)
    expect(config.name).toBe('Test')
  })

  it('strips the same keys when the site has no pages directory', async () => {
    // The early return for a site with no `pages/` handed `site.yml` over unstripped
    // until 2026-10-06 — `$` keys, `publishLanguages` and the request with it.
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-private-keys-'))
    await writeFile(
      join(siteDir, 'site.yml'),
      "name: Test\nservices:\n  search: false\npublishLanguages: [en]\n$org: acme\n"
    )

    const { config } = await collectSiteContent(siteDir)

    expect(config.services).toBeUndefined()
    expect(config.search).toBe(false)
    expect(config.publishLanguages).toBeUndefined()
    expect(config.$org).toBeUndefined()
    expect(config.name).toBe('Test')
  })
})
