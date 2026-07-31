/**
 * Capabilities written as named exports are dropped — say so.
 *
 * `generate-entry.js` builds `capabilities` as `{ ..._foundationModule.default,
 * vars: … }`. It spreads the DEFAULT export only, so `export const xref = …`
 * vanishes with no error and a build that succeeds. The feature simply does not
 * happen, which reads as "not implemented" rather than "declared in the wrong
 * place".
 *
 * That is not hypothetical: cross-references were wired onto uniweb.io exactly
 * that way on 2026-07-31. The build passed, the site ran, and every `[#id]`
 * rendered as its own literal text — identical to a foundation that had never
 * opted in. It was found by reading generate-entry.js, which is the wrong way
 * to find it.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFoundationConfig } from '../src/schema.js'

let root
let warn

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  warn.mockRestore()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A foundation src/ holding one main.js. Unique per call — ESM caches imports. */
async function foundationWith(source) {
  root = await mkdtemp(join(tmpdir(), 'uniweb-caps-'))
  const srcDir = join(root, 'src')
  await mkdir(srcDir, { recursive: true })
  await writeFile(join(srcDir, 'main.js'), source)
  return srcDir
}

const warnings = () => warn.mock.calls.map(c => c.join(' ')).join('\n')

describe('a capability on the wrong export is reported', () => {
  it('names a misplaced xref', async () => {
    const srcDir = await foundationWith(
      "export const xref = { build: () => {} }\nexport default { name: 'F' }\n",
    )
    await loadFoundationConfig(srcDir)

    expect(warnings()).toMatch(/`xref`/)
    expect(warnings()).toMatch(/default export/)
  })

  it('names every misplaced key at once', async () => {
    const srcDir = await foundationWith(
      "export const xref = {}\nexport const defaultInsets = {}\nexport default { name: 'F' }\n",
    )
    await loadFoundationConfig(srcDir)

    expect(warnings()).toMatch(/`xref`/)
    expect(warnings()).toMatch(/`defaultInsets`/)
  })

  it('stays quiet when the capability is on the default export', async () => {
    const srcDir = await foundationWith(
      "export default { name: 'F', xref: { build: () => {} }, defaultInsets: {} }\n",
    )
    await loadFoundationConfig(srcDir)

    expect(warnings()).toBe('')
  })

  it('stays quiet about a named `vars`', async () => {
    // The one capability that legitimately works named — generate-entry.js
    // reads it explicitly. Warning about it would train authors to ignore this.
    const srcDir = await foundationWith(
      "export const vars = { 'x': { default: '1px' } }\nexport default { name: 'F' }\n",
    )
    const config = await loadFoundationConfig(srcDir)

    expect(warnings()).toBe('')
    expect(config.vars).toBeTruthy()
  })

  it('stays quiet when a key is exported BOTH ways', async () => {
    // Redundant, but the default export carries it, so nothing is dropped and
    // there is nothing to report.
    const srcDir = await foundationWith(
      "export const xref = { build: () => {} }\nexport default { name: 'F', xref: { build: () => {} } }\n",
    )
    await loadFoundationConfig(srcDir)

    expect(warnings()).toBe('')
  })

  it('does not warn about an unrelated named export', async () => {
    const srcDir = await foundationWith(
      "export const helper = () => {}\nexport default { name: 'F' }\n",
    )
    await loadFoundationConfig(srcDir)

    expect(warnings()).toBe('')
  })
})
