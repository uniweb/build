/**
 * `uniweb.supports`, derived from the module graph.
 *
 * ⛔ THE FIXTURES ARE REAL SOURCE, READ FROM DISK, AND THAT IS THE POINT.
 *
 * The check this replaces (`cli/src/commands/doctor.js`) was tested with a
 * fixture written as a source string containing the exact call its regex looked
 * for. That suite was green while the check missed `useFormSubmit()` — the
 * official submit gate — on `templates/services`, the template written to
 * demonstrate the feature. A test whose input is authored to match the matcher
 * can only ever confirm the matcher matches itself.
 *
 * So these parse the actual `@uniweb/kit` and `@uniweb/api` modules. If a gate
 * moves, is renamed, or stops routing through `resolveService`, the assertion
 * below goes red at the commit that does it — which is the only mechanism that
 * would have caught the original bug.
 */

import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'vite'
import { deriveSupports, composeSupports } from '../src/foundation/derive-supports.js'

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A real framework module, parsed as Rollup would hand it to the hook. */
function realModule(relPath) {
  const id = join(FRAMEWORK, relPath)
  const code = readFileSync(id, 'utf8')
  return { id, code, ast: parseAst(code) }
}

/** Stand in for Rollup's bundle + plugin context over a set of real modules. */
function graphOf(modules, { renderedLength = 100 } = {}) {
  const byId = new Map(modules.map((m) => [m.id, m]))
  const bundle = {
    'entry.js': {
      type: 'chunk',
      modules: Object.fromEntries(modules.map((m) => [m.id, { renderedLength }])),
    },
  }
  const ctx = { getModuleInfo: (id) => byId.get(id) ?? null }
  return { bundle, ctx }
}

describe('deriveSupports — over real framework source', () => {
  test('reads the submit gate through kit, where the literal actually lives', () => {
    const { bundle, ctx } = graphOf([
      realModule('kit/src/hooks/useFormSubmit.js'),
      realModule('kit/src/utils/submitTarget.js'),
    ])
    const { services, blind } = deriveSupports(bundle, ctx)
    expect(services).toContain('submit')
    expect(blind).toBe(false)
  })

  test('reads the search gate', () => {
    const { bundle, ctx } = graphOf([realModule('kit/src/search/client.js')])
    expect(deriveSupports(bundle, ctx).services).toContain('search')
  })

  test('resolves a service named by a module-level const, not just an inline literal', () => {
    // @uniweb/api calls resolveService(website, SERVICE_NAME). Without const
    // resolution this is BOTH a miss and a false blindness signal, which would
    // mark every foundation using the package unknowable.
    const { bundle, ctx } = graphOf([realModule('api/src/client.js')])
    const { services, blind } = deriveSupports(bundle, ctx)
    expect(services).toContain('api')
    expect(blind).toBe(false)
  })

  test('a kit predicate derives its service — the method form, name at argument 0', () => {
    // ⛔ THE OFF-BY-ONE THIS EXISTS FOR. `resolveService(website, name)` carries
    // the name at argument 1; `website.isServiceEnabled(name)` carries it at 0,
    // because the website is the receiver. Reading the wrong index does not
    // throw — it finds `undefined`, falls to the blind branch, and publishes a
    // `uniweb.supports` short by however many services the foundation uses.
    const { bundle, ctx } = graphOf([realModule('kit/src/utils/servicePredicates.js')])
    const { services, blind } = deriveSupports(bundle, ctx)

    expect(services).toEqual(['api', 'assistant', 'search', 'submit', 'tracking'])
    expect(blind).toBe(false)
  })

  test('the tracking gate is module presence — it routes through no literal', () => {
    const { bundle, ctx } = graphOf([realModule('kit/src/hooks/useTracker.js')])
    expect(deriveSupports(bundle, ctx).services).toContain('tracking')
  })

  test('core\'s own module declares resolveService without calling it, and is not blind', () => {
    // `export function resolveService(website, name)` is a declaration, and the
    // file's JSDoc contains `resolveService(website, name)` as prose. A regex
    // reads both as calls with a computed name; the AST reads neither.
    const { bundle, ctx } = graphOf([realModule('core/src/services.js')])
    const { services, blind } = deriveSupports(bundle, ctx)
    expect(blind).toBe(false)
    expect(services).toEqual([])
  })
})

describe('deriveSupports — the tree-shaking boundary', () => {
  test('⛔ a module shaken out does NOT contribute, however much it names', () => {
    // The measured failure: scanning everything Rollup parsed reports `search`
    // for a foundation that only submits, because the search client was loaded
    // and then discarded. Over-reporting is the direction that sells an
    // operator a service the site never draws.
    const submit = realModule('kit/src/utils/submitTarget.js')
    const search = realModule('kit/src/search/client.js')
    const byId = new Map([submit, search].map((m) => [m.id, m]))

    const bundle = {
      'entry.js': {
        type: 'chunk',
        modules: {
          [submit.id]: { renderedLength: 1925 },
          [search.id]: { renderedLength: 0 }, // parsed, then shaken out
        },
      },
    }
    const ctx = { getModuleInfo: (id) => byId.get(id) ?? null }

    const { services } = deriveSupports(bundle, ctx)
    expect(services).toEqual(['submit'])
    expect(services).not.toContain('search')
  })
})

describe('deriveSupports — blindness', () => {
  test('a computed service name is reported as blind, not guessed at', () => {
    const code = `
      import { resolveService } from '@uniweb/core/services'
      export function pick(website, which) {
        return resolveService(website, which)
      }
    `
    const id = '/virtual/computed.js'
    const bundle = { 'e.js': { type: 'chunk', modules: { [id]: { renderedLength: 50 } } } }
    const ctx = { getModuleInfo: () => ({ id, code, ast: parseAst(code) }) }

    const { services, blind, blindAt } = deriveSupports(bundle, ctx)
    expect(services).toEqual([])
    expect(blind).toBe(true)
    expect(blindAt).toEqual([id])
  })

  test('a nested const does not resolve — shadowing must not name a service', () => {
    const code = `
      import { resolveService } from '@uniweb/core/services'
      export function pick(website) {
        const NAME = 'booking'
        return resolveService(website, NAME)
      }
    `
    const id = '/virtual/nested.js'
    const bundle = { 'e.js': { type: 'chunk', modules: { [id]: { renderedLength: 50 } } } }
    const ctx = { getModuleInfo: () => ({ id, code, ast: parseAst(code) }) }

    const { services, blind } = deriveSupports(bundle, ctx)
    expect(services).toEqual([])
    expect(blind).toBe(true)
  })

  test('an invented service name is derived like any other — the registry is open', () => {
    const code = `
      import { resolveService } from '@uniweb/core/services'
      export const book = (w) => resolveService(w, 'booking')
    `
    const id = '/virtual/booking.js'
    const bundle = { 'e.js': { type: 'chunk', modules: { [id]: { renderedLength: 50 } } } }
    const ctx = { getModuleInfo: () => ({ id, code, ast: parseAst(code) }) }

    expect(deriveSupports(bundle, ctx).services).toEqual(['booking'])
  })
})

describe('composeSupports — the three states must not collapse', () => {
  const derived = (services, blind = false) => ({ services, blind, blindAt: [] })

  test('nothing authored, something derived → the derived set', () => {
    expect(composeSupports(undefined, derived(['submit']))).toEqual({ supports: ['submit'] })
  })

  test('nothing authored, nothing derived, nothing blind → a PROVEN empty', () => {
    expect(composeSupports(undefined, derived([]))).toEqual({ supports: [] })
  })

  test('⛔ nothing authored, nothing derived, but BLIND → absent, not empty', () => {
    // Absent is UNKNOWN and `[]` is "honours no service". Collapsing them is the
    // one thing the wire contract forbids.
    expect(composeSupports(undefined, derived([], true))).toEqual({})
  })

  test('authored and derived are unioned, sorted and de-duplicated', () => {
    expect(composeSupports(['search'], derived(['submit', 'search']))).toEqual({
      supports: ['search', 'submit'],
    })
  })

  test('the union never drops what the developer authored', () => {
    // The computed-name case: `booking` is invisible to the graph, so only the
    // author knows it. Losing it here would publish a set shorter than the truth.
    expect(composeSupports(['booking'], derived(['submit']))).toEqual({
      supports: ['booking', 'submit'],
    })
  })

  test('an explicit [] contradicted by the bundle yields the evidence', () => {
    expect(composeSupports([], derived(['submit']))).toEqual({ supports: ['submit'] })
  })

  test('an explicit [] with nothing derived stays an explicit []', () => {
    expect(composeSupports([], derived([]))).toEqual({ supports: [] })
  })

  test('no derivation (a dev rebuild) leaves the authored value exactly as it was', () => {
    expect(composeSupports(undefined, null)).toEqual({})
    expect(composeSupports([], null)).toEqual({ supports: [] })
    expect(composeSupports(['search'], null)).toEqual({ supports: ['search'] })
  })
})
