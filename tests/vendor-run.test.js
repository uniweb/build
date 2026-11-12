/**
 * A local run of a vendor function enforces the rules the public contract states for where it runs
 * (`docs/development/vendor-functions.md` § What it can't do): the web's globals and not Node's, no
 * network, frozen built-in prototypes, a JSON object in and out within their sizes, and a stop for a
 * call that never ends. Each case is one a test that imports the file in Node lets pass.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVendorFunction, LIMITS } from '../src/foundation/vendor-run.js'

const dir = mkdtempSync(join(tmpdir(), 'uw-vendor-run-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
async function call(source, exportName, input = {}) {
  const file = join(dir, `v${n++}.js`)
  writeFileSync(file, source)
  return runVendorFunction({ file, exportName, inputText: typeof input === 'string' ? input : JSON.stringify(input) })
}

const fn = (body, params = 'input') => `export function f(${params}) {\n${body}\n}\n`

describe('a local run of a vendor function', () => {
  it('⭐ answers with what the function returns, and how long it took', async () => {
    const r = await call(fn('return { points: input.answers.length }'), 'f', { answers: [1, 2] })
    expect(r).toMatchObject({ ok: true, answer: { points: 2 }, warnings: [] })
    expect(r.wallMs).toBeTypeOf('number')
  })

  it('awaits a promise', async () => {
    expect(await call('export async function f() { return { a: 1 } }\n', 'f')).toMatchObject({ ok: true, answer: { a: 1 } })
  })

  it('has the web\'s globals and not Node\'s', async () => {
    const r = await call(
      fn('return { p: typeof process, b: typeof Buffer, s: typeof setImmediate, c: typeof crypto.subtle, t: typeof TextEncoder, u: typeof URL }'),
      'f'
    )
    expect(r.answer).toEqual({ p: 'undefined', b: 'undefined', s: 'undefined', c: 'object', t: 'function', u: 'function' })
  })

  it('⭐ has no network: fetch throws', async () => {
    const r = await call(fn('return fetch("http://example.test")'), 'f')
    expect(r.ok).toBe(false)
    expect(r.failure).toMatch(/fetch is not available: a vendor function has no network/)
  })

  it('⭐ freezes the built-in prototypes: an assignment one of them shadows throws, and says what to write', async () => {
    const r = await call(fn("const e = new Error('bad key')\ne.name = 'GradingError'\nthrow e"), 'f')
    expect(r.failure).toMatch(/Cannot assign to read only property 'name'.*class field/s)

    const defined = await call("class GradingError extends Error { name = 'GradingError' }\n" + fn("throw new GradingError('bad key')"), 'f')
    expect(defined.failure).toBe('It threw GradingError: bad key')
  })

  it('so an input cannot reach Object.prototype', async () => {
    const r = await call(fn('const out = {}\nout[input.a] ??= {}\nout[input.a][input.b] = 1\nreturn {}'), 'f', { a: '__proto__', b: 'polluted' })
    expect(r.ok).toBe(false)
    expect(({}).polluted).toBeUndefined()
  })

  it('a throw is a failure with its message; a throw of a non-Error asks for one', async () => {
    expect((await call(fn("throw new Error('no key for quiz q1')"), 'f')).failure).toBe('It threw Error: no key for quiz q1')
    expect((await call(fn("throw 'nope'"), 'f')).failure).toMatch(/not an Error.*Throw an Error/)
  })

  it('an answer is a JSON object within its size', async () => {
    expect((await call(fn('return [1]'), 'f')).failure).toMatch(/returned an array, not an object/)
    expect((await call(fn('return 3'), 'f')).failure).toMatch(/returned number, not an object/)
    expect((await call(fn('return { n: 1n }'), 'f')).failure).toMatch(/can't be written as JSON/)
    expect((await call(fn(`return { s: 'x'.repeat(${LIMITS.answerBytes}) }`), 'f')).failure).toMatch(/over the 256 KiB an answer may be/)
  })

  it('an input is a JSON object within its size', async () => {
    expect((await call(fn('return {}'), 'f', 'nope')).failure).toMatch(/isn't JSON/)
    expect((await call(fn('return {}'), 'f', '[1]')).failure).toMatch(/not an object/)
    expect((await call(fn('return {}'), 'f', JSON.stringify({ s: 'x'.repeat(LIMITS.inputBytes) }))).failure).toMatch(/over the 1\.0 MiB an input may be/)
  })

  it('names a promise that never settles', async () => {
    expect((await call(fn('return new Promise(() => {})'), 'f')).failure).toBe('It returned a promise that never settles.')
  })

  it(
    'stops a call still running at the wall limit',
    async () => {
      const r = await call(fn('for (;;) {}'), 'f')
      expect(r.failure).toMatch(/still running after 5 s/)
    },
    LIMITS.wallMs + 5000
  )

  it('warns of a call longer than the budget, without stopping it', async () => {
    const r = await call(fn('const end = Date.now() + 80\nwhile (Date.now() < end) {}\nreturn { done: true }'), 'f')
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([expect.stringMatching(/more than the 50 ms one call may take/)])
  })

  it('runs nothing from a file that can\'t be registered, and names a function it doesn\'t export', async () => {
    const bad = await call("import x from 'y'\n" + fn('return {}'), 'f')
    expect(bad).toMatchObject({ ok: false, problems: [expect.stringMatching(/^imports `y`/)] })
    expect((await call(fn('return {}'), 'g')).failure).toBe("The file doesn't export `g`. It exports `f`.")
  })
})
