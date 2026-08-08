/**
 * Import-map bridge emission.
 *
 * ⛔ The bug this file exists to prevent is SILENT, which is why it is tested
 * rather than reviewed.
 *
 * The plugin enumerates a module's exports by `await import(pkg)` — in NODE.
 * That throws for anything reached through a `.jsx` file, and the fallback is
 * `export * from pkg`, which never re-exports `default`. So bridging a module
 * whose entire public surface IS its default export produced a bridge with
 * that export missing: the file existed, the manifest listed it, the channel
 * published it, its digests verified, and only `import X from '<bridge>'` in a
 * browser failed. Measured on `@uniweb/runtime/provider`, 2026-08-08.
 */

import { describe, it, expect, vi } from 'vitest'
import { importMapPlugin, bridgeFileName, DEFAULT_EXTERNALS } from '../src/import-map-plugin.js'

/** Drive the plugin's `load` hook the way Rollup would. */
async function loadBridge(plugin, spec, ctx = {}) {
  return plugin.load.call({ warn: vi.fn(), ...ctx }, `\0importmap:${spec}`)
}

describe('bridgeFileName', () => {
  it('flattens slashes and keeps the scope sigil', () => {
    expect(bridgeFileName('react')).toBe('react.js')
    expect(bridgeFileName('react/jsx-runtime')).toBe('react-jsx-runtime.js')
    expect(bridgeFileName('@uniweb/core')).toBe('@uniweb-core.js')
    expect(bridgeFileName('@uniweb/runtime/provider')).toBe('@uniweb-runtime-provider.js')
  })
})

describe('declared surfaces', () => {
  it('re-exports default when hasDefault is declared', async () => {
    const plugin = importMapPlugin({
      externals: [{ spec: '@uniweb/runtime/provider', hasDefault: true }],
    })
    const code = await loadBridge(plugin, '@uniweb/runtime/provider')

    // The whole point: a default-only module keeps its default.
    expect(code).toContain("export { default } from '@uniweb/runtime/provider'")
    // Named exports stay self-maintaining rather than being frozen in a list.
    expect(code).toContain("export * from '@uniweb/runtime/provider'")
  })

  it('omits the default re-export when hasDefault is false', async () => {
    const plugin = importMapPlugin({
      externals: [{ spec: '@uniweb/runtime/setup', hasDefault: false }],
    })
    const code = await loadBridge(plugin, '@uniweb/runtime/setup')

    expect(code).toContain("export * from '@uniweb/runtime/setup'")
    expect(code).not.toContain('export { default }')
  })

  it('never touches Node resolution for a declared surface', async () => {
    // A declared entry must not be enumerated by import(), or a JSX-reaching
    // module would still fail — that is the whole reason the option exists.
    const plugin = importMapPlugin({
      externals: [{ spec: 'this-package-does-not-exist', hasDefault: true }],
    })
    const warn = vi.fn()
    const code = await loadBridge(plugin, 'this-package-does-not-exist', { warn })

    expect(code).toContain("export { default } from 'this-package-does-not-exist'")
    expect(warn).not.toHaveBeenCalled()
  })

  it('emits an explicit named list when one is given', async () => {
    const plugin = importMapPlugin({
      externals: [{ spec: 'some-pkg', named: ['alpha', 'beta'] }],
    })
    const code = await loadBridge(plugin, 'some-pkg')

    expect(code).toContain("export { alpha, beta } from 'some-pkg'")
    expect(code).not.toContain('export *')
  })
})

describe('the lossy fallback is loud', () => {
  it('warns when a specifier cannot be enumerated', async () => {
    // Undeclared + unimportable is the exact shape that shipped a broken
    // bridge. It may still fall back, but it must not do so quietly.
    const plugin = importMapPlugin({ externals: ['definitely-not-installed-xyz'] })
    const warn = vi.fn()
    const code = await loadBridge(plugin, 'definitely-not-installed-xyz', { warn })

    expect(code).toBe("export * from 'definitely-not-installed-xyz'")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/DROPS a default export/)
  })
})

describe('object and string entries are interchangeable everywhere', () => {
  const externals = ['react', { spec: '@uniweb/runtime/provider', hasDefault: true }]

  it('emits a chunk per entry, at the shared filename', () => {
    const plugin = importMapPlugin({ externals })
    plugin.configResolved({ command: 'build' })

    const emitted = []
    plugin.buildStart.call({ emitFile: (f) => emitted.push(f) })

    expect(emitted.map((f) => f.fileName)).toEqual([
      '_importmap/react.js',
      '_importmap/@uniweb-runtime-provider.js',
    ])
  })

  it('injects both into the HTML import map', () => {
    const plugin = importMapPlugin({ externals })
    plugin.configResolved({ command: 'build' })

    const html = plugin.transformIndexHtml.handler('<head>\n</head>')
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1])

    expect(map.imports).toEqual({
      react: '/_importmap/react.js',
      '@uniweb/runtime/provider': '/_importmap/@uniweb-runtime-provider.js',
    })
  })
})

describe('the foundation-facing contract', () => {
  it('DEFAULT_EXTERNALS carries only what foundations import', () => {
    // Host-only bridges (the runtime library surface, the router, theming)
    // belong to the host that needs them — widening this list would change
    // what EVERY foundation links against. See HOST_BRIDGES in the runtime's
    // vite.config.app.js.
    expect(DEFAULT_EXTERNALS).toEqual([
      'react',
      'react-dom',
      'react-dom/server',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      '@uniweb/core',
    ])
  })
})
