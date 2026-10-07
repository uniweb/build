/**
 * The layout a page renders with when it names none — resolved once by the build and written into
 * both artifacts, so the runtime (the entry's `capabilities.defaultLayout`) and an editor
 * (`_self.defaultLayout`) cannot disagree (`src/foundation/default-layout.js`).
 *
 * ⛔ What this replaced (until 2026-10-07): the build copied the declared value and derived nothing,
 * so a reader of the schema finding none had to guess what the runtime would draw.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDefaultLayout } from '../src/foundation/default-layout.js'
import { generateEntryPoint } from '../src/generate-entry.js'
import { buildSchema } from '../src/schema.js'

describe('resolveDefaultLayout — one rule', () => {
  it('a declared default is written as the layout\'s own name, by the one naming rule', () => {
    expect(resolveDefaultLayout('DocsLayout', ['DocsLayout', 'Marketing'])).toBe('DocsLayout')
    expect(resolveDefaultLayout('docs', ['DocsLayout', 'Marketing'])).toBe('DocsLayout')
    expect(resolveDefaultLayout('marketing', ['DocsLayout', 'Marketing'])).toBe('Marketing')
  })

  it('⭐ with none declared, the layout named `default` — Default, DefaultLayout, default-layout', () => {
    expect(resolveDefaultLayout(undefined, ['Docs', 'Default'])).toBe('Default')
    expect(resolveDefaultLayout(undefined, ['Docs', 'DefaultLayout'])).toBe('DefaultLayout')
    expect(resolveDefaultLayout(null, ['default-layout'])).toBe('default-layout')
    // An exact or case match wins over a suffix match, as everywhere a layout is named.
    expect(resolveDefaultLayout(undefined, ['DefaultLayout', 'Default'])).toBe('Default')
  })

  it('⛔ never "the first" or "the only" layout — none named default means the built-in one', () => {
    expect(resolveDefaultLayout(undefined, ['Docs', 'Marketing'])).toBeNull()
    expect(resolveDefaultLayout(undefined, ['DocsLayout'])).toBeNull()
    expect(resolveDefaultLayout(undefined, [])).toBeNull()
    expect(resolveDefaultLayout('', ['Docs'])).toBeNull()
  })

  it('⛔ a declared default that names no layout stops the build, naming the ones there are', () => {
    expect(() => resolveDefaultLayout('Docs', ['Marketing', 'Landing'])).toThrow(
      /`defaultLayout` names "Docs", which is not one of this foundation's layouts \(Marketing, Landing\)/
    )
    expect(() => resolveDefaultLayout('Docs', [])).toThrow(/it has none in src\/layouts\//)
    expect(() => resolveDefaultLayout(42, ['Docs'])).toThrow(/names 42/)
  })
})

describe('both artifacts carry the same answer', () => {
  let dir
  const write = (rel, text) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const layout = (name) => write(`layouts/${name}/index.jsx`, `export default function ${name}() { return null }\n`)
  const entry = async () => {
    await generateEntryPoint(dir, join(dir, '_entry.generated.js'))
    return readFileSync(join(dir, '_entry.generated.js'), 'utf8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uw-default-layout-'))
    write('package.json', JSON.stringify({ name: 'acme-foundation', version: '1.0.0', type: 'module' }))
    write('sections/Hero/meta.js', 'export default { title: "X" }\n')
    write('sections/Hero/Hero.jsx', 'export default function Hero() { return null }\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('⭐ a layout named Default is the default — with no main.js at all', async () => {
    layout('Docs')
    layout('Default')
    expect(await entry()).toContain('defaultLayout: "Default"')
    expect((await buildSchema(dir))._self.defaultLayout).toBe('Default')
  })

  it('a declared default, written as the layout\'s own name in both', async () => {
    layout('DocsLayout')
    write('main.js', `export default { defaultLayout: 'docs' }\n`)
    expect(await entry()).toContain('defaultLayout: "DocsLayout"')
    expect((await buildSchema(dir))._self.defaultLayout).toBe('DocsLayout')
  })

  it('none declared and none named default: neither carries one — the built-in layout', async () => {
    layout('Docs')
    layout('Marketing')
    write('main.js', `export default { defaultSection: 'Hero' }\n`)
    expect(await entry()).not.toContain('defaultLayout')
    expect('defaultLayout' in (await buildSchema(dir))._self).toBe(false)
  })

  it('⛔ a declared default that names no layout stops both', async () => {
    layout('Marketing')
    write('main.js', `export default { defaultLayout: 'Docs' }\n`)
    await expect(entry()).rejects.toThrow(/`defaultLayout` names "Docs"/)
    await expect(buildSchema(dir)).rejects.toThrow(/`defaultLayout` names "Docs"/)
  })
})
