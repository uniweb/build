/**
 * Tests for the deploy.yml loader and writer.
 * See kb/framework/plans/static-host-deploy-adapters.md.
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadDeployYml, resolveTarget } from '../src/site/deploy-config.js'
import { recordLastDeploy, recordTarget } from '../src/site/deploy-config-writer.js'

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
          'autoSave: lastDeploy',
          '',
        ].join('\n'),
        'utf8'
      )
      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('production')
      expect(doc.targets.production.host).toBe('s3-cloudfront')
      expect(doc.autoSave).toBe('lastDeploy')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects unknown autoSave value', async () => {
    const dir = await makeSiteDir()
    try {
      await writeFile(join(dir, 'deploy.yml'), 'autoSave: maybe\n', 'utf8')
      await expect(loadDeployYml(dir)).rejects.toThrow(/autoSave.*must be one of/)
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
})

describe('resolveTarget', () => {
  test('null deployYml + no flag → implicit uniweb host', () => {
    const r = resolveTarget(null, null)
    expect(r.host).toBe('uniweb')
    expect(r.fromFile).toBe(false)
    expect(r.autoSave).toBe('lastDeploy')
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

  test('autoSave defaults to lastDeploy when unset', () => {
    const doc = { default: 'p', targets: { p: { host: 'uniweb' } } }
    expect(resolveTarget(doc, null).autoSave).toBe('lastDeploy')
  })
})

describe('recordLastDeploy', () => {
  test('autoSave: off is a no-op', async () => {
    const dir = await makeSiteDir()
    try {
      const result = await recordLastDeploy(dir, {
        targetName: 'production',
        targetConfig: { host: 'uniweb' },
        lastDeploy: { at: '2026-05-05T00:00:00Z' },
        autoSave: 'off',
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
        autoSave: 'lastDeploy',
      })
      expect(result.created).toBe(true)

      const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
      expect(text).toMatch(/deploy\.yml — operational config/)
      expect(text).toMatch(/default: production/)
      expect(text).toMatch(/host: s3-cloudfront/)
      expect(text).toMatch(/bucket: my-bucket/)
      expect(text).toMatch(/autoSave: lastDeploy/)
      expect(text).toMatch(/lastDeploy:/)
      expect(text).toMatch(/url: https:\/\/example\.com/)

      // Round-trip parses cleanly.
      const doc = await loadDeployYml(dir)
      expect(doc.default).toBe('production')
      expect(doc.targets.production.host).toBe('s3-cloudfront')
      expect(doc.lastDeploy.production.url).toBe('https://example.com')
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
          autoSave: 'lastDeploy',
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
        'autoSave: lastDeploy',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original, 'utf8')

      await recordLastDeploy(dir, {
        targetName: 'production',
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://example.com' },
        autoSave: 'lastDeploy',
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
      // lastDeploy.production exists.
      expect(text).toMatch(/lastDeploy:/)
      expect(text).toMatch(/url: https:\/\/example\.com/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('replaces existing lastDeploy.<target> in place', async () => {
    const dir = await makeSiteDir()
    try {
      const original = [
        'default: production',
        'targets:',
        '  production:',
        '    host: uniweb',
        'lastDeploy:',
        '  production:',
        '    at: 2026-01-01T00:00:00Z',
        '    url: https://old.example.com',
        '',
      ].join('\n')
      await writeFile(join(dir, 'deploy.yml'), original, 'utf8')

      await recordLastDeploy(dir, {
        targetName: 'production',
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://new.example.com' },
        autoSave: 'lastDeploy',
      })

      const doc = await loadDeployYml(dir)
      expect(doc.lastDeploy.production.url).toBe('https://new.example.com')
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
        autoSave: 'lastDeploy',
      })
      await recordLastDeploy(dir, {
        targetName: 'preview',
        lastDeploy: { at: 't2', url: 'https://preview' },
        autoSave: 'lastDeploy',
      })

      const doc = await loadDeployYml(dir)
      expect(doc.lastDeploy.production.url).toBe('https://prod')
      expect(doc.lastDeploy.preview.url).toBe('https://preview')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('recordTarget', () => {
  test('first call scaffolds deploy.yml with this target as default and no lastDeploy block', async () => {
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
      expect(text).toMatch(/autoSave: lastDeploy/)
      // No deploy has happened yet — lastDeploy block stays out.
      expect(text).not.toMatch(/^lastDeploy:/m)

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
        'autoSave: lastDeploy',
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
        'autoSave: lastDeploy',
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

  test('does not touch lastDeploy when updating a target', async () => {
    const dir = await makeSiteDir()
    try {
      // Pre-existing file with a real lastDeploy entry
      await recordLastDeploy(dir, {
        targetName: 'production',
        targetConfig: { host: 's3-cloudfront', bucket: 'b' },
        lastDeploy: { at: '2026-05-05T00:00:00Z', url: 'https://prod' },
        autoSave: 'lastDeploy',
      })

      await recordTarget(dir, {
        targetName: 'github-pages',
        targetConfig: { host: 'github-pages', domain: 'mysite.com' },
      })

      const doc = await loadDeployYml(dir)
      expect(doc.lastDeploy.production.url).toBe('https://prod')
      expect(doc.targets['github-pages'].domain).toBe('mysite.com')
      // Default unchanged
      expect(doc.default).toBe('production')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
