/**
 * `retireDeployYmlKeys` — a deploy.yml moved off the keys retired on 2026-09-20.
 *
 * Nothing reads `lastDeploy:` or `autoSave:` any more, and a renamed key returns empty: a
 * deploy recorded under `lastDeploy:` is one nothing can see, and `autoSave: off` is ignored.
 * Measured 2026-10-26 on real projects: a site's only record of its S3 deploy sat under
 * `lastDeploy:`, and three files kept `autoSave:`. This is `uniweb doctor`'s fix for both.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadDeployYml } from '../src/site/deploy-config.js'
import { retireDeployYmlKeys } from '../src/site/deploy-config-writer.js'

async function siteWith(text) {
  const dir = await mkdtemp(join(tmpdir(), 'uniweb-retired-keys-'))
  await writeFile(join(dir, 'deploy.yml'), text)
  return dir
}

const BOTH = `# the person's own words
default: production
targets:
  production:
    host: s3-cloudfront # the bucket
  cloud:
    host: uniweb
lastDeploy:
  production:
    at: 2026-05-26T18:38:41.635Z
    host: s3-cloudfront
deploys:
  cloud:
    at: 2026-10-24T19:09:51.318Z
    host: uniweb
`

describe('retireDeployYmlKeys', () => {
  test("⭐ a target's record moves from lastDeploy: to deploys:, and the comments stay", async () => {
    const dir = await siteWith(BOTH)
    expect(await retireDeployYmlKeys(dir)).toEqual({ moved: ['production'], dropped: [], saveDeploys: null, renamed: null })
    const text = await readFile(join(dir, 'deploy.yml'), 'utf8')
    expect(text).toContain("# the person's own words")
    expect(text).toContain('# the bucket')
    expect(text).not.toMatch(/^lastDeploy:/m)
    const loaded = await loadDeployYml(dir)
    expect(Object.keys(loaded.deploys).sort()).toEqual(['cloud', 'production'])
    expect(loaded.deploys.production.host).toBe('s3-cloudfront')
  })

  test('a target deploys: already records keeps that record; the old one is dropped', async () => {
    const dir = await siteWith(BOTH.replace('lastDeploy:\n  production:', 'lastDeploy:\n  cloud:'))
    expect(await retireDeployYmlKeys(dir)).toEqual({ moved: [], dropped: ['cloud'], saveDeploys: null, renamed: null })
    const loaded = await loadDeployYml(dir)
    expect(String(loaded.deploys.cloud.at)).toContain('2026-10-24')
    expect(loaded.lastDeploy).toBeUndefined()
  })

  test('autoSave: off becomes saveDeploys: false; any other value is the default, and goes', async () => {
    const off = await siteWith('default: p\ntargets:\n  p:\n    host: uniweb\nautoSave: off\n')
    expect(await retireDeployYmlKeys(off)).toEqual({ moved: [], dropped: [], saveDeploys: false, renamed: null })
    const loadedOff = await loadDeployYml(off)
    expect(loadedOff.saveDeploys).toBe(false)
    expect(loadedOff.autoSave).toBeUndefined()

    const on = await siteWith('default: p\ntargets:\n  p:\n    host: uniweb\nautoSave: lastDeploy\n')
    expect(await retireDeployYmlKeys(on)).toEqual({ moved: [], dropped: [], saveDeploys: null, renamed: null })
    const loadedOn = await loadDeployYml(on)
    expect(loadedOn.saveDeploys).toBeUndefined()
    expect(loadedOn.autoSave).toBeUndefined()
  })

  test('nothing to move is nothing written; no file is null', async () => {
    const text = 'default: p\ntargets:\n  p:\n    host: uniweb\n'
    const dir = await siteWith(text)
    expect(await retireDeployYmlKeys(dir)).toBe(null)
    expect(await readFile(join(dir, 'deploy.yml'), 'utf8')).toBe(text)
    expect(await retireDeployYmlKeys(await mkdtemp(join(tmpdir(), 'uniweb-no-deploy-yml-')))).toBe(null)
  })

  // ⛔ `saveDeploys:` holding one of `autoSave:`'s values — the key renamed by hand, its value
  // kept (measured 2026-10-26 on a copied project, `saveDeploys: lastDeploy`). The loader refuses
  // it, naming this fix; the fix writes what the value meant.
  test('saveDeploys: lastDeploy is the default, and goes; saveDeploys: off is false', async () => {
    const kept = await siteWith('# mine\ndefault: p\ntargets:\n  p:\n    host: uniweb\nsaveDeploys: lastDeploy\n')
    await expect(loadDeployYml(kept)).rejects.toThrow(/`lastDeploy` is a value of the retired `autoSave:`.*--fix deploy-yml-retired-key/)
    expect(await retireDeployYmlKeys(kept)).toEqual({ moved: [], dropped: [], saveDeploys: null, renamed: 'lastDeploy' })
    expect((await loadDeployYml(kept)).saveDeploys).toBeUndefined()
    expect(await readFile(join(kept, 'deploy.yml'), 'utf8')).toContain('# mine')

    const off = await siteWith('default: p\ntargets:\n  p:\n    host: uniweb\nsaveDeploys: off\n')
    expect(await retireDeployYmlKeys(off)).toEqual({ moved: [], dropped: [], saveDeploys: false, renamed: 'off' })
    expect((await loadDeployYml(off)).saveDeploys).toBe(false)
  })

  test('control: another value is still refused as it was, and left alone', async () => {
    const odd = await siteWith('default: p\ntargets:\n  p:\n    host: uniweb\nsaveDeploys: sometimes\n')
    await expect(loadDeployYml(odd)).rejects.toThrow(/`saveDeploys` must be true or false\.$/)
    expect(await retireDeployYmlKeys(odd)).toBe(null)
  })
})
