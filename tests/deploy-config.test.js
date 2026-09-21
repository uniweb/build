/**
 * Tests for the deploy.yml loader and writer.
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadDeployYml, resolveTarget } from '../src/site/deploy-config.js'
import {
  recordLastDeploy,
  recordTarget,
  forgetDeploys,
  forgetDeployYml,
} from '../src/site/deploy-config-writer.js'

async function makeSiteDir() {
  return mkdtemp(join(tmpdir(), 'uniweb-deploy-yml-'))
}

describe('loadDeployYml', () => {
  test('returns null when deploy.yml is absent', async () => {
    const dir = await makeSiteDir()
    try {
      expect(await loadDeployYml(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('parses a valid file', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(
        join(dir, 'deploy.yml'),
        [
          'default: production',
          'targets:',
          '  production:',
          '    host: s3-cloudfront',
          '    bucket: my-bucket',
          'saveDeploys: true',
          '',
        ].join('\n'),
        'utf8'
      )
      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('production')
      expect(doc.targets.production.host).toBe('s3-cloudfront')
      expect(doc.saveDeploys).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a non-boolean saveDeploys', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), 'saveDeploys: maybe\n', 'utf8')
      await expect(loadDeployYml(dir)).rejects.toThrow(/saveDeploys.*must be true or false/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects non-map targets', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), 'targets:\n  - production\n', 'utf8')
      await expect(loadDeployYml(dir)).rejects.toThrow(/`targets` must be a map/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A site has ONE Uniweb identity (`site.yml::$uuid`), so a second `host: uniweb`
  // target cannot describe a different site — whichever `default:` picks is the
  // site, and the other silently describes one that does not exist. The per-target
  // `backend` key makes that look expressible, which is why it is rejected rather
  // than left to be discovered.
  test('⭐ ACCEPTS two host: uniweb targets on different backends — the rejection is gone', async () => {
    // This test used to assert the OPPOSITE, with this exact fixture. A site had one
    // identity (`site.yml::$uuid`), so two Uniweb targets could not both be coherent.
    // Identity is keyed by backend origin in sync.json now: these are two sites on two
    // backends, which is precisely the shape this work exists to make possible.
    const dir = await makeSiteDir()
    try {
      await writeFile(
        join(dir, 'deploy.yml'),
        'default: production\n' +
          'targets:\n' +
          '  production:\n    host: uniweb\n    backend: https://uniweb.app\n' +
          '  staging:\n    host: uniweb\n    backend: http://localhost:8080\n',
        'utf8'
      )
      const doc = await loadDeployYml(dir)
      expect(doc.targets.production.backend).toBe('https://uniweb.app')
      expect(doc.targets.staging.backend).toBe('http://localhost:8080')
      expect(resolveTarget(doc, 'staging').config.backend).toBe('http://localhost:8080')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('one uniweb target alongside any number of third-party targets is fine', async () => {
    const dir = await makeSiteDir()
    try {
      // Only Uniweb hosting reads `$uuid`; every other host is stateless from the
      // CLI's side, so multiplicity there is legitimate and must stay allowed.
      await writeFile(
        join(dir, 'deploy.yml'),
        'default: production\n' +
          'targets:\n' +
          '  production:\n    host: uniweb\n' +
          '  preview:\n    host: cloudflare-pages\n' +
          '  archive:\n    host: github-pages\n' +
          '  mirror:\n    host: s3-cloudfront\n',
        'utf8'
      )
      const doc = await loadDeployYml(dir)
      expect(Object.keys(doc.targets)).toHaveLength(4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('zero uniweb targets is fine, and a malformed target entry does not crash the check', async () => {
    const dir = await makeSiteDir()
    try {
      // `null` and a scalar entry are rejected later by resolveTarget's missing-host
      // error; this guard must step over them rather than throw the wrong message.
      await writeFile(
        join(dir, 'deploy.yml'),
        'targets:\n  a:\n    host: netlify\n  b:\n  c: nonsense\n',
        'utf8'
      )
      const doc = await loadDeployYml(dir)
      expect(Object.keys(doc.targets)).toHaveLength(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveTarget', () => {
  test('null deployYml + no flag → implicit uniweb host', () => {
    const r = resolveTarget(null, null)
    expect(r.host).toBe('uniweb')
    expect(r.fromFile).toBe(false)
    expect(r.saveDeploys).toBe(true)
  })

  test('null deployYml + --target → error', () => {
    expect(() => resolveTarget(null, 'preview')).toThrow(/no deploy.yml exists/)
  })

  test('uses default when --target is null', () => {
    const doc = {
      default: 'production',
      targets: { production: { host: 's3-cloudfront', bucket: 'b' } },
    }
    const r = resolveTarget(doc, null)
    expect(r.targetName).toBe('production')
    expect(r.host).toBe('s3-cloudfront')
    expect(r.config).toEqual({ bucket: 'b' })
    expect(r.fromFile).toBe(true)
  })

  test('explicit --target wins over default', () => {
    const doc = {
      default: 'production',
      targets: {
        production: { host: 's3-cloudfront' },
        preview: { host: 'github-pages' },
      },
    }
    expect(resolveTarget(doc, 'preview').host).toBe('github-pages')
  })

  test('unknown target lists known names', () => {
    const doc = {
      targets: { production: { host: 'uniweb' }, preview: { host: 'github-pages' } },
    }
    expect(() => resolveTarget(doc, 'staging')).toThrow(
      /no target 'staging'.*Known: preview, production/
    )
  })

  test('target without host is rejected', () => {
    const doc = { default: 'production', targets: { production: { bucket: 'b' } } }
    expect(() => resolveTarget(doc, null)).toThrow(/missing `host`/)
  })

  test('saveDeploys defaults to true when unset', () => {
    const doc = { default: 'p', targets: { p: { host: 'uniweb' } } }
    expect(resolveTarget(doc, null).saveDeploys).toBe(true)
  })
})

describe('recordLastDeploy', () => {
  test('saveDeploys: false is a no-op', async () => {
    const dir = await makeSiteDir()
    try {
      const result = await recordLastDeploy(dir, {
        targetName: 'production',
        targetConfig: { host: 'uniweb' },
        lastDeploy: { at: '2026-05-05T00:00:00Z' },
        saveDeploys: false,
      })
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('first deploy scaffolds a fresh deploy.yml', async () => {
    const dir = await makeSiteDir()
    try {
      const result = await recordLastDeploy(dir, {
        targetName: 'production',
        targetConfig: { host: 's3-cloudfront', bucket: 'my-bucket' },
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://example.com' },
        saveDeploys: true,
      })
      expect(result.created).toBe(true)

      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      // The header says who writes the file — the point a reader needs while
      // looking at it. Pinned because the previous wording implied the opposite.
      expect(text).toMatch(/written by `uniweb deploy` \/ `uniweb publish`/)
      expect(text).toMatch(/You do not create this file/)
      expect(text).toMatch(/default: production/)
      expect(text).toMatch(/host: s3-cloudfront/)
      expect(text).toMatch(/bucket: my-bucket/)
      expect(text).toMatch(/saveDeploys: true/)
      expect(text).toMatch(/deploys:/)
      expect(text).toMatch(/url: https:\/\/example\.com/)

      // Round-trip parses cleanly.
      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('production')
      expect(doc.targets.production.host).toBe('s3-cloudfront')
      expect(doc.deploys.production.url).toBe('https://example.com')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('first deploy without targetConfig.host throws', async () => {
    const dir = await makeSiteDir()
    try {
      await expect(
        recordLastDeploy(dir, {
          targetName: 'production',
          lastDeploy: { at: 'now' },
          saveDeploys: true,
        })
      ).rejects.toThrow(/targetConfig\.host/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('preserves comments and key order on existing files', async () => {
    const dir = await makeSiteDir()
    try {
      const original = [
        '# Header comment',
        'default: production',
        'targets:',
        '  production:',
        '    host: s3-cloudfront',
        '    # bucket comment',
        '    bucket: my-bucket',
        '    region: us-east-1',
        'saveDeploys: true',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original, 'utf8')

      await recordLastDeploy(dir, {
        targetName: 'production',
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://example.com' },
        saveDeploys: true,
      })

      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).toMatch(/# Header comment/)
      expect(text).toMatch(/# bucket comment/)
      // Key order under production: host, bucket, region (unchanged).
      const productionIdx = text.indexOf('production:')
      const hostIdx = text.indexOf('host:', productionIdx)
      const bucketIdx = text.indexOf('bucket:', productionIdx)
      const regionIdx = text.indexOf('region:', productionIdx)
      expect(hostIdx).toBeGreaterThan(productionIdx)
      expect(bucketIdx).toBeGreaterThan(hostIdx)
      expect(regionIdx).toBeGreaterThan(bucketIdx)
      // deploys.production exists.
      expect(text).toMatch(/deploys:/)
      expect(text).toMatch(/url: https:\/\/example\.com/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('replaces existing deploys.<target> in place', async () => {
    const dir = await makeSiteDir()
    try {
      const original = [
        'default: production',
        'targets:',
        '  production:',
        '    host: uniweb',
        'deploys:',
        '  production:',
        '    at: 2026-01-01T00:00:00Z',
        '    url: https://old.example.com',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original, 'utf8')

      await recordLastDeploy(dir, {
        targetName: 'production',
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://new.example.com' },
        saveDeploys: true,
      })

      const doc = await loadDeployYml(dir)
      expect(doc.deploys.production.url).toBe('https://new.example.com')
      // js-yaml parses ISO timestamps as Date objects; check the on-disk
      // representation directly so we can assert against a string.
      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).toMatch(/at: 2026-05-05T00:00:00Z/)
      expect(text).not.toMatch(/2026-01-01/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('records multiple targets independently', async () => {
    const dir = await makeSiteDir()
    try {
      // Bootstrap with two targets.
      await writeFile(
        join(dir, 'deploy.yml'),
        [
          'default: production',
          'targets:',
          '  production: { host: s3-cloudfront, bucket: prod }',
          '  preview:    { host: github-pages }',
          '',
        ].join('\n'),
        'utf8'
      )

      await recordLastDeploy(dir, {
        targetName: 'production',
        lastDeploy: { at: 't1', url: 'https://prod' },
        saveDeploys: true,
      })
      await recordLastDeploy(dir, {
        targetName: 'preview',
        lastDeploy: { at: 't2', url: 'https://preview' },
        saveDeploys: true,
      })

      const doc = await loadDeployYml(dir)
      expect(doc.deploys.production.url).toBe('https://prod')
      expect(doc.deploys.preview.url).toBe('https://preview')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('recordTarget', () => {
  test('first call scaffolds deploy.yml with this target as default and no deploys block', async () => {
    const dir = await makeSiteDir()
    try {
      const result = await recordTarget(dir, {
        targetName: 'github-pages',
        targetConfig: { host: 'github-pages', domain: 'mysite.com' },
      })
      expect(result).toEqual({
        created: true,
        path: join(dir, 'deploy.yml'),
        action: 'scaffold',
      })

      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).toMatch(/default: github-pages/)
      expect(text).toMatch(/host: github-pages/)
      expect(text).toMatch(/domain: mysite\.com/)
      expect(text).toMatch(/saveDeploys: true/)
      // No deploy has happened yet — deploys block stays out.
      expect(text).not.toMatch(/^deploys:/m)

      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('github-pages')
      expect(doc.targets['github-pages']).toEqual({
        host: 'github-pages',
        domain: 'mysite.com',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects targetConfig without a host', async () => {
    const dir = await makeSiteDir()
    try {
      await expect(
        recordTarget(dir, {
          targetName: 'github-pages',
          targetConfig: { domain: 'mysite.com' },
        })
      ).rejects.toThrow(/targetConfig\.host/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('on existing file, merges into targets.<name> without changing default or other targets', async () => {
    const dir = await makeSiteDir()
    try {
      const original = [
        '# Header comment',
        'default: production',
        'targets:',
        '  production:',
        '    host: s3-cloudfront',
        '    bucket: my-bucket',
        '    region: us-east-1',
        'saveDeploys: true',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original)

      const result = await recordTarget(dir, {
        targetName: 'github-pages',
        targetConfig: { host: 'github-pages', domain: 'mysite.com' },
      })
      expect(result.action).toBe('merge')
      expect(result.created).toBe(false)

      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      // Comment + existing fields preserved
      expect(text).toMatch(/# Header comment/)
      expect(text).toMatch(/default: production/)
      expect(text).toMatch(/bucket: my-bucket/)
      expect(text).toMatch(/region: us-east-1/)
      // New target added
      expect(text).toMatch(/github-pages:/)
      expect(text).toMatch(/domain: mysite\.com/)

      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('production')
      expect(doc.targets.production.bucket).toBe('my-bucket')
      expect(doc.targets['github-pages']).toEqual({
        host: 'github-pages',
        domain: 'mysite.com',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('updating an existing target preserves hand-authored fields', async () => {
    const dir = await makeSiteDir()
    try {
      const original = [
        'default: github-pages',
        'targets:',
        '  github-pages:',
        '    host: github-pages',
        '    domain: old.com',
        '    notes: hand-edited field',
        'saveDeploys: true',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original)

      await recordTarget(dir, {
        targetName: 'github-pages',
        targetConfig: { host: 'github-pages', domain: 'new.com' },
      })

      const doc = await loadDeployYml(dir)
      expect(doc.targets['github-pages'].domain).toBe('new.com')
      // The hand-authored `notes` field survives the merge.
      expect(doc.targets['github-pages'].notes).toBe('hand-edited field')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not touch deploys when updating a target', async () => {
    const dir = await makeSiteDir()
    try {
      // Pre-existing file with a real deploys entry
      await recordLastDeploy(dir, {
        targetName: 'production',
        targetConfig: { host: 's3-cloudfront', bucket: 'b' },
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://prod' },
        saveDeploys: true,
      })

      await recordTarget(dir, {
        targetName: 'github-pages',
        targetConfig: { host: 'github-pages', domain: 'mysite.com' },
      })

      const doc = await loadDeployYml(dir)
      expect(doc.deploys.production.url).toBe('https://prod')
      expect(doc.targets['github-pages'].domain).toBe('mysite.com')
      // Default unchanged
      expect(doc.default).toBe('production')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// A project that published to two backends and deploys to one static host.
const TWO_BACKENDS = [
  '# Header comment',
  'default: production',
  'targets:',
  '  production:',
  '    host: uniweb',
  '    backend: https://uniweb.app',
  '  staging:',
  '    # the dev box',
  '    host: uniweb',
  '    backend: http://localhost:8080',
  '  pages:',
  '    host: cloudflare-pages',
  '    project: acme',
  'deploys:',
  '  production:',
  '    at: 2026-09-01T00:00:00Z',
  '    host: uniweb',
  '    backend: https://uniweb.app',
  '    siteUuid: SITE-PROD',
  '  staging:',
  '    at: 2026-09-02T00:00:00Z',
  '    host: uniweb',
  '    backend: http://localhost:8080',
  '    siteUuid: SITE-DEV',
  '  pages:',
  '    at: 2026-09-03T00:00:00Z',
  '    host: cloudflare-pages',
  '    url: https://acme.pages.dev',
  'saveDeploys: true',
  '',
].join('\n')

describe('forgetDeploys — one backend\'s records, nothing else', () => {
  async function withFile(text, fn) {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), text, 'utf8')
      await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test('⭐ removes the record that names the backend and keeps every target', async () => {
    await withFile(TWO_BACKENDS, async (dir) => {
      expect(await forgetDeploys(dir, 'http://localhost:8080')).toEqual(['staging'])

      const after = await loadDeployYml(dir)
      expect(Object.keys(after.deploys).sort()).toEqual(['pages', 'production'])
      expect(Object.keys(after.targets).sort()).toEqual(['pages', 'production', 'staging'])
      expect(after.targets.staging.backend, 'the choice of where to ship stays').toBe(
        'http://localhost:8080'
      )
      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).toMatch(/# Header comment/)
      expect(text).toMatch(/# the dev box/)
      expect(text).not.toMatch(/SITE-DEV/)
      expect(text).toMatch(/SITE-PROD/)
    })
  })

  test('matches a whole endpoint URL by its origin', async () => {
    await withFile(TWO_BACKENDS, async (dir) => {
      expect(await forgetDeploys(dir, 'https://uniweb.app/dev/site/x')).toEqual(['production'])
    })
  })

  test('a record naming no backend falls back to its uniweb target', async () => {
    const text = TWO_BACKENDS.replace('    backend: http://localhost:8080\n    siteUuid: SITE-DEV', '    siteUuid: SITE-DEV')
    expect(text).not.toBe(TWO_BACKENDS)
    await withFile(text, async (dir) => {
      expect(await forgetDeploys(dir, 'http://localhost:8080')).toEqual(['staging'])
    })
  })

  test('⛔ never touches another host\'s history', async () => {
    await withFile(TWO_BACKENDS, async (dir) => {
      await forgetDeploys(dir, 'https://uniweb.app')
      await forgetDeploys(dir, 'http://localhost:8080')
      const after = await loadDeployYml(dir)
      expect(Object.keys(after.deploys)).toEqual(['pages'])
    })
  })

  test('the last record gone takes the empty `deploys:` with it', async () => {
    const one = [
      'default: production',
      'targets:',
      '  production:',
      '    host: uniweb',
      '    backend: http://localhost:8080',
      'deploys:',
      '  production:',
      '    at: 2026-09-02T00:00:00Z',
      '    backend: http://localhost:8080',
      'saveDeploys: true',
      '',
    ].join('\n')
    await withFile(one, async (dir) => {
      expect(await forgetDeploys(dir, 'http://localhost:8080')).toEqual(['production'])
      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).not.toMatch(/deploys:/)
      expect(text).toMatch(/targets:/)
    })
  })

  test('an unknown backend, or no file, removes nothing', async () => {
    await withFile(TWO_BACKENDS, async (dir) => {
      expect(await forgetDeploys(dir, 'http://never.test')).toEqual([])
      expect(await readFile(join(dir, 'deploy.yml'), 'utf8')).toBe(TWO_BACKENDS)
    })
    const empty = await makeSiteDir()
    try {
      expect(await forgetDeploys(empty, 'http://localhost:8080')).toEqual([])
      expect(existsSync(join(empty, 'deploy.yml'))).toBe(false)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('a file that does not parse is reported, never rewritten', async () => {
    const broken = 'targets: [unclosed\n'
    await withFile(broken, async (dir) => {
      await expect(forgetDeploys(dir, 'http://localhost:8080')).rejects.toThrow(/did not parse/)
      expect(await readFile(join(dir, 'deploy.yml'), 'utf8')).toBe(broken)
    })
  })
})

describe('forgetDeployYml — a copy becoming a new project', () => {
  test('⭐ deletes the whole file, targets included, and names what it held', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), TWO_BACKENDS, 'utf8')
      expect(await forgetDeployYml(dir)).toEqual(['pages', 'production', 'staging'])
      expect(existsSync(join(dir, 'deploy.yml'))).toBe(false)
      expect(await forgetDeployYml(dir), 'no file: null, not an error').toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('removes a file that does not parse — it is still the original\'s', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), 'targets: [unclosed\n', 'utf8')
      expect(await forgetDeployYml(dir)).toEqual([])
      expect(existsSync(join(dir, 'deploy.yml'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
