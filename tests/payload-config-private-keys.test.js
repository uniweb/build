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

  it('⛔ drops `services:` — a request to the host is never the host\'s answer', async () => {
    // At `config.services` it would be the HOST tier, where a present block declines
    // every service it does not name: `search: true` asked of a host would switch this
    // static site's own search off. Until 2026-10-06 it shipped, and doubled as an
    // undocumented way to simulate a host's offer.
    const dir = await makeSite('name: Test\nservices:\n  search: true\n  submit: false\n')

    const { config } = await collectSiteContent(dir)

    expect(config.services).toBeUndefined()
    expect(config.name).toBe('Test')
  })

  it('leaves ordinary keys alone — the site\'s own service keys included', async () => {
    const dir = await makeSite('name: Test\nsubmit:\n  endpoint: /forms\nsearch: false\n')

    const { config } = await collectSiteContent(dir)

    expect(config.submit).toEqual({ endpoint: '/forms' })
    expect(config.search).toBe(false)
    expect(config.name).toBe('Test')
  })

  it('strips the same keys when the site has no pages directory', async () => {
    // The early return for a site with no `pages/` handed `site.yml` over unstripped
    // until 2026-10-06 — `$` keys, `publishLanguages` and the request with it.
    siteDir = await mkdtemp(join(tmpdir(), 'uniweb-private-keys-'))
    await writeFile(
      join(siteDir, 'site.yml'),
      "name: Test\nservices:\n  search: true\npublishLanguages: [en]\n$org: acme\n"
    )

    const { config } = await collectSiteContent(siteDir)

    expect(config.services).toBeUndefined()
    expect(config.publishLanguages).toBeUndefined()
    expect(config.$org).toBeUndefined()
    expect(config.name).toBe('Test')
  })
})
