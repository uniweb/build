/**
 * `$`-prefixed site.yml keys must not reach the published payload.
 *
 * `config` on the bundle lane is site.yml spread whole, which is what makes a
 * `services:` block a working local stand-in for a host's offer. The same spread
 * also carried the project's BACKEND-SCOPED state — `$uuid`, `$org`, `$backend`,
 * and now `$services` / `$secrets` — into an artifact any visitor can fetch.
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

  it('leaves ordinary keys alone — including `services:`, the host stand-in', async () => {
    // ⚖️ `services:` (no `$`) is a DIFFERENT key with a different job: it lands at
    // `config.services`, the HOST tier, so a developer can exercise a host's offer
    // with no backend. Stripping `$` keys must not touch it.
    const dir = await makeSite(
      'name: Test\nservices:\n  submit:\n    endpoint: /forms\nsearch: false\n'
    )

    const { config } = await collectSiteContent(dir)

    expect(config.services).toEqual({ submit: { endpoint: '/forms' } })
    expect(config.search).toBe(false)
    expect(config.name).toBe('Test')
  })
})
