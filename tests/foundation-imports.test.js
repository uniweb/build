import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { foundationExportTarget, resolveFoundationImport, foundationImportsPlugin } from '../src/site/foundation-imports.js'

// The map `uniweb create` writes for a foundation.
const SCAFFOLD = {
  name: 'src',
  main: './_entry.generated.js',
  exports: {
    '.': './_entry.generated.js',
    './styles': './styles.css',
    './dist': './dist/entry.js',
    './dist/styles': './dist/assets/style.css',
  },
}

describe('foundationExportTarget', () => {
  it('reads the scaffold’s map', () => {
    expect(foundationExportTarget(SCAFFOLD, '.')).toBe('./_entry.generated.js')
    expect(foundationExportTarget(SCAFFOLD, './styles')).toBe('./styles.css')
    expect(foundationExportTarget(SCAFFOLD, './dist/styles')).toBe('./dist/assets/style.css')
    expect(foundationExportTarget(SCAFFOLD, './nothing')).toBeNull()
  })

  it('reads a string map, conditions, arrays and a pattern', () => {
    expect(foundationExportTarget({ exports: './main.js' }, '.')).toBe('./main.js')
    expect(foundationExportTarget({ exports: { '.': { import: './esm.js', default: './cjs.js' } } }, '.')).toBe('./esm.js')
    expect(foundationExportTarget({ exports: { '.': { node: './n.js', browser: './b.js' } } }, '.', ['node', 'default'])).toBe('./n.js')
    expect(foundationExportTarget({ exports: { '.': [{ worker: './w.js' }, './fallback.js'] } }, '.')).toBe('./fallback.js')
    expect(foundationExportTarget({ exports: { './parts/*': './src/parts/*.js' } }, './parts/card')).toBe('./src/parts/card.js')
  })

  it('falls back to main, and to the file itself, with no exports', () => {
    expect(foundationExportTarget({ main: './entry.js' }, '.')).toBe('./entry.js')
    expect(foundationExportTarget({}, '.')).toBe('./index.js')
    expect(foundationExportTarget({}, './styles.css')).toBe('./styles.css')
  })
})

describe('resolveFoundationImport', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uw-foundation-imports-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function foundation(dir, marker) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(SCAFFOLD))
    writeFileSync(join(dir, '_entry.generated.js'), `export default '${marker}'\n`)
    writeFileSync(join(dir, 'styles.css'), `/* ${marker} */\n`)
  }

  it('names files in the folder it is given', () => {
    const dir = join(root, 'src')
    foundation(dir, 'live')
    expect(resolveFoundationImport('#foundation', dir)).toBe(join(dir, '_entry.generated.js'))
    expect(resolveFoundationImport('#foundation/styles', dir)).toBe(join(dir, 'styles.css'))
    expect(resolveFoundationImport('react', dir)).toBeNull()
    expect(resolveFoundationImport('#foundationish', dir)).toBeNull()
  })

  it('reads the foundation’s folder, not the copy a package manager left in node_modules', () => {
    // The 2026-11-11 case: pnpm turned the site's `file:` link into a snapshot of the foundation.
    const dir = join(root, 'src')
    foundation(dir, 'live')
    const copy = join(root, 'site', 'node_modules', 'src')
    cpSync(dir, copy, { recursive: true })
    writeFileSync(join(copy, '_entry.generated.js'), "export default 'stale'\n")
    expect(resolveFoundationImport('#foundation', dir)).toBe(join(dir, '_entry.generated.js'))
  })

  it('says what is missing when the map names nothing', () => {
    const dir = join(root, 'src')
    foundation(dir, 'live')
    expect(() => resolveFoundationImport('#foundation/theme', dir)).toThrow(/no "\.\/theme" in its package\.json exports/)
  })

  it('is a pre plugin that resolves only the foundation’s specifiers', () => {
    const dir = join(root, 'src')
    foundation(dir, 'live')
    const plugin = foundationImportsPlugin(dir)
    expect(plugin.enforce).toBe('pre')
    expect(plugin.resolveId('#foundation/styles', undefined, {})).toBe(join(dir, 'styles.css'))
    expect(plugin.resolveId('@uniweb/kit', undefined, {})).toBeNull()
  })
})

