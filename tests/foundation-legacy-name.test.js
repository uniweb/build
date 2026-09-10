/**
 * A leftover `foundation.js` must be REFUSED, not silently ignored.
 *
 * ⛔ THE BUG THIS PINS. The legacy entry name was removed 2026-09-05 and
 * `FOUNDATION_FILE_NAMES` became `main.js` alone — but `loadFoundationConfig`
 * still returned `{}` when it found nothing. So a project that kept the old
 * name built "successfully" with every declaration gone: no `vars`, no
 * `defaultLayout`, no `defaultSection`, no `props`. That is the outcome the
 * loader already refuses on the import-failure path (see
 * `foundation-config-jsx.test.js`), reached through a door that guard did not
 * cover.
 *
 * Found 2026-09-10 checking two downstream projects before an update: one
 * would have lost its default layout and its output-format declarations, and
 * the build log would have said nothing.
 *
 * Plain JS only, so these run in-process; each fixture carries
 * `"type": "module"` so the files are ESM under real Node too.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFoundationConfig } from '../src/schema.js'

const made = []
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'uniweb-legacy-name-'))
  made.push(dir)
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true })
})

describe('the foundation entry is main.js, and only main.js', () => {
  test('⛔ a leftover foundation.js with no main.js is refused, and names the rename', async () => {
    const dir = fixture({ 'foundation.js': "export default { defaultLayout: 'BookLayout' }\n" })
    await expect(loadFoundationConfig(dir)).rejects.toThrow(
      /foundation\.js is no longer read — rename it to main\.js/,
    )
  })

  test('control: main.js loads, and its declarations arrive', async () => {
    const dir = fixture({ 'main.js': "export default { defaultLayout: 'BookLayout' }\n" })
    expect((await loadFoundationConfig(dir)).defaultLayout).toBe('BookLayout')
  })

  test('main.js wins when both exist — the leftover is inert, not an error', async () => {
    const dir = fixture({
      'main.js': "export default { defaultLayout: 'FromMain' }\n",
      'foundation.js': "export default { defaultLayout: 'FromLegacy' }\n",
    })
    expect((await loadFoundationConfig(dir)).defaultLayout).toBe('FromMain')
  })

  test('neither file is still "no config" — a foundation may declare nothing', async () => {
    await expect(loadFoundationConfig(fixture({}))).resolves.toEqual({})
  })
})
