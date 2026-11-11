/**
 * `main.js` `placeholders:` — the site values a foundation reads (a shop's currency), declared as
 * one field map in the shape an inline `data:` map takes, so an editor can show a site's
 * placeholders as typed fields (agreed with frontend, 2026-11-11). A site holds the values in
 * `site.yml` `placeholders:`; a page reads them at `website.config.placeholders`.
 *
 * The build checks the declaration as `register` will normalize it, stops on one it cannot read
 * (a site reading its foundation warns instead), carries it in `_self` as written, and never puts
 * it in a page: the runtime fills no default.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../src/schema.js'
import { extractFoundationRuntime } from '../src/runtime-schema.js'

let dir
const write = (rel, text) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-placeholders-'))
  write('package.json', JSON.stringify({ name: 'src', version: '1.0.0', type: 'module' }))
  write('sections/Hero/Hero.jsx', 'export default function Hero() { return null }\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const currency = {
  type: 'string',
  label: 'Currency',
  enum: [{ value: 'USD', label: 'US dollar ($)' }, { value: 'GBP', label: 'Pound sterling (£)' }],
  default: 'USD',
}

describe('a foundation’s placeholders: declaration', () => {
  it('is carried in _self as written', async () => {
    write('main.js', `export default { name: '@acme/shop', placeholders: ${JSON.stringify({ currency })} }\n`)
    const schema = await buildSchema(dir)
    expect(schema._self.placeholders).toEqual({ currency })
  })

  it('stops the foundation build when it is not a valid field map, naming why', async () => {
    write('main.js', "export default { name: '@acme/shop', placeholders: { currency: { type: 'money' } } }\n")
    await expect(buildSchema(dir)).rejects.toThrow(/placeholders is not a valid field map: field 'currency' has unknown type 'money'/)
  })

  it('a site reading its foundation (strict: false) warns and reads on', async () => {
    write('main.js', "export default { name: '@acme/shop', placeholders: { currency: { type: 'money' } } }\n")
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))
    const schema = await buildSchema(dir, undefined, null, { strict: false })
    expect(schema._self.placeholders).toEqual({ currency: { type: 'money' } })
    expect(warnings.join('\n')).toMatch(/placeholders is not a valid field map/)
  })

  it('never reaches a page: the lean main.js leaves it out', () => {
    const lean = extractFoundationRuntime({ name: '@acme/shop', placeholders: { currency }, defaultLayout: 'Default' })
    expect(JSON.stringify(lean)).not.toMatch(/placeholders|Currency/)
  })
})
