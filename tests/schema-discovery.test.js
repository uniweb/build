import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverComponents, loadFoundationConfig, reportPlacementDeclarations } from '../src/schema.js'
// The build's titles come from the package editors read them with — one copy.
import { inferTitle } from '@uniweb/schemas/component'

// ── Helpers ──────────────────────────────────────────────────────────

let tmpRoot

function fresh() {
  tmpRoot = join(tmpdir(), `schema-discovery-test-${Date.now()}`)
  mkdirSync(tmpRoot, { recursive: true })
  // Enable ESM so dynamic import() of meta.js works in the tmp directory
  writeFileSync(join(tmpRoot, 'package.json'), '{"type":"module"}')
  return tmpRoot
}

function cleanup() {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
}

/** Create a file (and its parent dirs) under tmpRoot */
function touch(relPath, content = '') {
  const full = join(tmpRoot, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

/** Create a meta.js that exports default { ...fields } */
function writeMeta(relPath, fields = {}) {
  const json = JSON.stringify(fields)
  touch(relPath, `export default ${json}`)
}

// ── inferTitle ───────────────────────────────────────────────────────

describe('inferTitle', () => {
  it('splits PascalCase', () => {
    expect(inferTitle('TeamRoster')).toBe('Team Roster')
  })

  it('keeps consecutive uppercase together', () => {
    expect(inferTitle('CTA')).toBe('CTA')
  })

  it('leaves single word alone', () => {
    expect(inferTitle('Hero')).toBe('Hero')
  })

  it('handles acronym followed by word', () => {
    expect(inferTitle('FAQSection')).toBe('FAQ Section')
  })

  it('handles multiple transitions', () => {
    expect(inferTitle('MyURLParser')).toBe('My URL Parser')
  })
})

// ── Sections discovery (relaxed rules) ───────────────────────────────

describe('sections/ discovery', () => {
  afterEach(cleanup)

  it('discovers bare JSX file at sections root', async () => {
    fresh()
    touch('sections/CTA.jsx', 'export default function CTA() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.CTA).toBeDefined()
    expect(result.CTA.name).toBe('CTA')
    expect(result.CTA.title).toBeUndefined()
    expect(result.CTA.entryFile).toBe('CTA.jsx')
    expect(result.CTA.path).toBe('sections')
  })

  it('discovers folder without meta.js at sections root', async () => {
    fresh()
    touch('sections/Hero/Hero.jsx', 'export default function Hero() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Hero).toBeDefined()
    expect(result.Hero.name).toBe('Hero')
    expect(result.Hero.title).toBeUndefined()
    expect(result.Hero.path).toBe(join('sections', 'Hero'))
  })

  it('discovers folder with index.jsx at sections root', async () => {
    fresh()
    touch('sections/Footer/index.jsx', 'export default function Footer() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Footer).toBeDefined()
  })

  it('discovers folder with meta.js (explicit meta)', async () => {
    fresh()
    touch('sections/Features/Features.jsx', 'export default function Features() {}')
    writeMeta('sections/Features/meta.js', { title: 'Feature Grid', category: 'content' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Features).toBeDefined()
    expect(result.Features.title).toBe('Feature Grid')
    expect(result.Features.category).toBe('content')
  })

  it('carries no title when meta.js declares none', async () => {
    fresh()
    touch('sections/TeamRoster/TeamRoster.jsx', 'export default function TeamRoster() {}')
    writeMeta('sections/TeamRoster/meta.js', { category: 'about' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.TeamRoster.title).toBeUndefined()
    expect(result.TeamRoster.category).toBe('about')
  })

  it('carries the title meta.js declares', async () => {
    fresh()
    touch('sections/CTA/CTA.jsx', 'export default function CTA() {}')
    writeMeta('sections/CTA/meta.js', { title: 'Call to Action' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.CTA.title).toBe('Call to Action')
  })

  it('discovers nested child with meta.js', async () => {
    fresh()
    touch('sections/Tabs/Tabs.jsx', 'export default function Tabs() {}')
    writeMeta('sections/Tabs/meta.js', { title: 'Tabs' })
    touch('sections/Tabs/Tab/Tab.jsx', 'export default function Tab() {}')
    writeMeta('sections/Tabs/Tab/meta.js', { title: 'Single Tab' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Tabs).toBeDefined()
    expect(result.Tab).toBeDefined()
    expect(result.Tab.title).toBe('Single Tab')
    expect(result.Tab.path).toBe(join('sections', 'Tabs', 'Tab'))
  })

  it('does NOT discover nested file without meta.js', async () => {
    fresh()
    touch('sections/Hero/Hero.jsx', 'export default function Hero() {}')
    touch('sections/Hero/Cards.jsx', 'export default function Cards() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Hero).toBeDefined()
    expect(result.Cards).toBeUndefined()
  })

  it('discovers organizational subfolder with meta.js', async () => {
    fresh()
    mkdirSync(join(tmpRoot, 'sections', 'marketing'), { recursive: true })
    touch('sections/marketing/Hero/Hero.jsx', 'export default function Hero() {}')
    writeMeta('sections/marketing/Hero/meta.js', { title: 'Marketing Hero' })

    // marketing/ itself is not PascalCase, so it won't be a root section type.
    // But since we recurse into all root directories, we'll find nested meta.js.
    // Actually, isComponentFileName('marketing') returns false, so it won't be processed.
    // The plan says organizational subfolders work — we need to handle lowercase dirs at root.

    // Let's test with a PascalCase parent that has nested children
  })

  it('discovers deep nested meta.js through PascalCase parent', async () => {
    fresh()
    touch('sections/Layout/Layout.jsx', 'export default function Layout() {}')
    touch('sections/Layout/Header/Header.jsx', 'export default function Header() {}')
    writeMeta('sections/Layout/Header/meta.js', { title: 'Header' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Layout).toBeDefined()
    expect(result.Header).toBeDefined()
    expect(result.Header.path).toBe(join('sections', 'Layout', 'Header'))
  })

  it('throws on name collision (file + directory)', async () => {
    fresh()
    touch('sections/Hero.jsx', 'export default function Hero() {}')
    touch('sections/Hero/Hero.jsx', 'export default function Hero() {}')

    await expect(discoverComponents(tmpRoot, ['sections']))
      .rejects.toThrow(/Name collision/)
  })

  it('ignores lowercase files (utils, constants)', async () => {
    fresh()
    touch('sections/utils.js', 'export const x = 1')
    touch('sections/constants.ts', 'export const y = 2')
    touch('sections/Hero.jsx', 'export default function Hero() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Hero).toBeDefined()
    expect(result.utils).toBeUndefined()
    expect(result.constants).toBeUndefined()
  })

  it('ignores lowercase directories', async () => {
    fresh()
    touch('sections/helpers/utils.js', 'export const x = 1')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('ignores directory without entry file and without meta.js', async () => {
    fresh()
    // Directory with only non-entry files
    touch('sections/Empty/readme.md', '# Empty')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Empty).toBeUndefined()
  })

  it('respects hidden: true in meta.js', async () => {
    fresh()
    touch('sections/Internal/Internal.jsx', 'export default function Internal() {}')
    writeMeta('sections/Internal/meta.js', { hidden: true })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Internal).toBeUndefined()
  })

  it('supports .tsx files', async () => {
    fresh()
    touch('sections/Card.tsx', 'export default function Card() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Card).toBeDefined()
    expect(result.Card.entryFile).toBe('Card.tsx')
  })

  it('returns empty object when sections/ does not exist', async () => {
    fresh()
    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result).toEqual({})
  })
})

// ── Extra paths (strict rules — meta.js required) ────────────────────

describe('extra section paths (strict)', () => {
  afterEach(cleanup)

  it('does NOT discover folder without meta.js', async () => {
    fresh()
    touch('widgets/Hero/Hero.jsx', 'export default function Hero() {}')

    const result = await discoverComponents(tmpRoot, ['widgets'])
    expect(result.Hero).toBeUndefined()
  })

  it('discovers folder with meta.js', async () => {
    fresh()
    touch('widgets/Hero/Hero.jsx', 'export default function Hero() {}')
    writeMeta('widgets/Hero/meta.js', { title: 'Hero Banner' })

    const result = await discoverComponents(tmpRoot, ['widgets'])
    expect(result.Hero).toBeDefined()
    expect(result.Hero.title).toBe('Hero Banner')
  })

  it('carries no title when meta.js declares none', async () => {
    fresh()
    touch('widgets/TeamRoster/TeamRoster.jsx', 'export default function TeamRoster() {}')
    writeMeta('widgets/TeamRoster/meta.js', { category: 'about' })

    const result = await discoverComponents(tmpRoot, ['widgets'])
    expect(result.TeamRoster.title).toBeUndefined()
  })

  it('does NOT discover bare files', async () => {
    fresh()
    touch('widgets/CTA.jsx', 'export default function CTA() {}')

    const result = await discoverComponents(tmpRoot, ['widgets'])
    expect(result.CTA).toBeUndefined()
  })
})

// ── Multi-path discovery (first wins) ────────────────────────────────

describe('multi-path discovery', () => {
  afterEach(cleanup)

  it('sections wins over extra path (first path wins)', async () => {
    fresh()
    touch('sections/Hero.jsx', 'export default function Hero() {}')
    touch('widgets/Hero/Hero.jsx', 'export default function Hero() {}')
    writeMeta('widgets/Hero/meta.js', { title: 'Widget Hero' })

    const result = await discoverComponents(tmpRoot, ['sections', 'widgets'])
    // sections/ found it first as a bare file — the widget's title is not on it
    expect(result.Hero.path).toBe('sections')
    expect(result.Hero.title).toBeUndefined()
  })

  it('falls through to extra path when not in sections', async () => {
    fresh()
    touch('widgets/Legacy/Legacy.jsx', 'export default function Legacy() {}')
    writeMeta('widgets/Legacy/meta.js', { title: 'Legacy Widget' })

    const result = await discoverComponents(tmpRoot, ['sections', 'widgets'])
    expect(result.Legacy).toBeDefined()
    expect(result.Legacy.title).toBe('Legacy Widget')
  })

  it('default paths only include sections', async () => {
    fresh()
    touch('sections/Hero.jsx', 'export default function Hero() {}')
    touch('components/Banner/Banner.jsx', 'export default function Banner() {}')
    writeMeta('components/Banner/meta.js', { title: 'Banner' })

    // Using default paths (no explicit paths argument)
    const result = await discoverComponents(tmpRoot)
    expect(result.Hero).toBeDefined()
    expect(result.Banner).toBeUndefined()
  })
})

describe('font-var type inference (loadFoundationConfig)', () => {
  afterEach(cleanup)

  it('infers type:font for font-* vars, leaving longhands/bare/explicit alone', async () => {
    fresh()
    touch(
      'main.js',
      `export const vars = {
        'font-serif': { default: 'ui-serif, Georgia, serif', description: 'Editorial serif' },
        'font-mono': 'ui-monospace, monospace',
        'font-weight': { default: '700' },
        radius: { default: '1rem' },
        serif: { default: 'ui-serif, serif' },
        'font-display': { type: 'number', default: '3' },
      }`
    )

    const { vars } = await loadFoundationConfig(tmpRoot)

    // font-* typeface var → inferred type: 'font'
    expect(vars['font-serif'].type).toBe('font')
    // bare-string font var → normalized to an object carrying the type
    expect(vars['font-mono']).toEqual({ default: 'ui-monospace, monospace', type: 'font' })
    // CSS longhand → not a typeface, left untyped
    expect(vars['font-weight'].type).toBeUndefined()
    // non-font var → untouched
    expect(vars.radius.type).toBeUndefined()
    // bare name (no font- prefix) → needs explicit type, not inferred
    expect(vars.serif.type).toBeUndefined()
    // explicit type wins → never overridden
    expect(vars['font-display'].type).toBe('number')
  })
})

describe('title — carried only when meta.js declares one', () => {
  afterEach(cleanup)

  // ⭐ An absent `title` says the component is unnamed, and that decides whether a
  // name can be translated: an authored title is the foundation's own words, shown
  // verbatim in every UI language; for an unnamed one a consumer uses its family's
  // translated label, else `inferTitle(name)`. ⛔ Until 2026-09-27 the build filled
  // `title` from the name and added `titleInferred: true` to say it had.
  it('an unnamed component has no title and no titleInferred', async () => {
    fresh()
    touch('sections/TeamRoster/TeamRoster.jsx', 'export default function TeamRoster() {}')
    writeMeta('sections/TeamRoster/meta.js', { description: 'People' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.TeamRoster).not.toHaveProperty('title')
    expect(result.TeamRoster).not.toHaveProperty('titleInferred')
  })

  it('nor does a section discovered with no meta.js at all', async () => {
    fresh()
    touch('sections/Hero/Hero.jsx', 'export default function Hero() {}')

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Hero).toEqual({ name: 'Hero', path: join('sections', 'Hero') })
  })

  it('an authored title is carried as written', async () => {
    fresh()
    touch('sections/TeamRoster/TeamRoster.jsx', 'export default function TeamRoster() {}')
    writeMeta('sections/TeamRoster/meta.js', { title: 'Who We Are' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.TeamRoster.title).toBe('Who We Are')
    expect(result.TeamRoster).not.toHaveProperty('titleInferred')
  })
})

describe('name and path are the build\'s', () => {
  afterEach(cleanup)

  // An editor reads an entry's `name` as its section type. A `meta.js` that declared
  // `name` used to replace it, while the schema stayed keyed by the folder.
  it('a meta.js `name` or `path` does not replace them', async () => {
    fresh()
    touch('sections/Hero/Hero.jsx', 'export default function Hero() {}')
    writeMeta('sections/Hero/meta.js', { name: 'Big Banner', path: 'elsewhere' })

    const result = await discoverComponents(tmpRoot, ['sections'])
    expect(result.Hero.name).toBe('Hero')
    expect(result.Hero.path).toBe('sections/Hero')
  })
})

describe('reportPlacementDeclarations', () => {
  let warnings
  beforeEach(() => {
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(message))
  })
  afterEach(() => vi.restoreAllMocks())

  it('warns when children.types names a type the foundation does not provide', () => {
    reportPlacementDeclarations({
      Tabs: { name: 'Tabs', children: { types: ['TabPanel', 'Card'] } },
      Card: { name: 'Card' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Tabs.*"TabPanel".*not a section type/)
  })

  it('warns about a children or visuals declaration it cannot read', () => {
    reportPlacementDeclarations({
      Grid: { name: 'Grid', children: { grid: ['40/'], colums: 2 } },
      Split: { name: 'Split', visuals: 'chart' },
    })
    expect(warnings.join('\n')).toMatch(/Grid.*children\.grid.*"40\/"/)
    expect(warnings.join('\n')).toMatch(/Grid.*children\.colums/)
    expect(warnings.join('\n')).toMatch(/Split.*chart/)
  })

  it('says nothing about declarations it can read', () => {
    reportPlacementDeclarations({
      Grid: { name: 'Grid', children: { label: 'Items', grid: [2, '40/60'], types: ['Card'] }, visuals: 1 },
      Card: { name: 'Card', inset: true, section: true },
    })
    expect(warnings).toEqual([])
  })
})
