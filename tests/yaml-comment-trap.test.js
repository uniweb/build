// A value YAML cut short at a `#` its author meant as part of it — a gradient's colors, a hex
// color — is said, naming the file and the key, with the quoted value to write instead
// (`src/utils/yaml-comment-trap.js`).
//
// ⭐ Measured 2026-10-26: a book page's `background.gradient` read `linear-gradient(165deg,`
// from the day the page was written, so the page showed no gradient in either renderer, and
// nothing said so. ⛔ What must stay quiet is a comment meant as one: those are the controls.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import collectSiteContent from '../src/site/content-collector.js'
import { valuesCutByComment } from '../src/utils/yaml-comment-trap.js'

const found = (text) => valuesCutByComment(text, yaml.load(text))

describe('valuesCutByComment', () => {
  it('⭐ a gradient cut at its first color', () => {
    const text = 'background:\n  gradient: linear-gradient(165deg, #0c1226 0%, #070a16 55%, #05060f 100%)\n'
    expect(found(text)).toEqual([
      {
        path: 'background.gradient',
        kind: 'cut',
        message:
          '`background.gradient` is cut short at `linear-gradient(165deg,` — YAML reads a `#` after a space as a comment. ' +
          'Quote the value: gradient: "linear-gradient(165deg, #0c1226 0%, #070a16 55%, #05060f 100%)"',
      },
    ])
  })

  it('a color left with no value', () => {
    expect(found('colors:\n  primary: #3b82f6\n  neutral: stone\n')).toEqual([
      {
        path: 'colors.primary',
        kind: 'empty',
        message: '`colors.primary` is empty — YAML reads `#3b82f6` as a comment. Quote the value: primary: "#3b82f6"',
      },
    ])
  })

  it('a value in a list, and a function other than a gradient', () => {
    expect(found('items:\n  - color: #fff\n  - filter: drop-shadow(0 0 4px #000)\n').map((f) => `${f.kind} ${f.path}`)).toEqual([
      'empty items[0].color',
      'cut items[1].filter',
    ])
  })

  // CONTROLS: the value holds what its author meant, or a comment is meant as one.
  it.each([
    ['a quoted gradient', 'gradient: "linear-gradient(165deg, #0c1226 0%, #05060f 100%)"\n'],
    ['a quoted color', 'primary: "#3b82f6"\n'],
    ['a comment after a whole value', 'title: Home  # the landing page\n'],
    ['a key left empty, with nothing after it', 'image:\n'],
    ['a key left empty, with a comment that is not a color', 'image: # set it later\n'],
    ['a parenthesis left open, with no comment', 'subtitle: Smileys :-(\n'],
    ['a # with no space before it', 'title: C# for the web\n'],
    ['a # right after a parenthesis, which YAML keeps', 'fill: url(#glow)\n'],
  ])('says nothing for %s', (_, text) => {
    expect(found(text)).toEqual([])
  })
})

describe('the collector', () => {
  let dir
  let warnings
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yaml-comment-trap-'))
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
  }

  it("says it for a site file and a section's frontmatter, each named as its author sees it", async () => {
    write({
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'theme.yml': 'colors:\n  primary: #3b82f6\n',
      'pages/home/page.yml': 'title: Home\n',
      // The body's YAML example is not frontmatter: an empty `color:` above it stays quiet.
      'pages/home/1-hero.md':
        '---\ntype: Hero\ncolor:\nbackground:\n  gradient: linear-gradient(165deg, #0c1226 0%, #05060f 100%)\n---\n\n' +
        '# Hi\n\n```yaml\ncolor: #fff\n```\n',
    })
    await collectSiteContent(dir)
    const said = warnings.filter((w) => w.includes('YAML reads')).sort()
    expect(said).toEqual([
      '[content-collector] pages/home/1-hero.md: `background.gradient` is cut short at `linear-gradient(165deg,` — YAML reads a `#` after a space as a comment. ' +
        'Quote the value: gradient: "linear-gradient(165deg, #0c1226 0%, #05060f 100%)"',
      '[content-collector] theme.yml: `colors.primary` is empty — YAML reads `#3b82f6` as a comment. Quote the value: primary: "#3b82f6"',
    ])
  })

  it('control: a site written with its values quoted says nothing', async () => {
    write({
      'site.yml': "name: S\nindex: home\nfoundation: '@a/base@1.0.0'\n",
      'theme.yml': 'colors:\n  primary: "#3b82f6"  # brand\n',
      'pages/home/page.yml': 'title: Home\n',
      'pages/home/1-hero.md': '---\ntype: Hero\nbackground:\n  gradient: "linear-gradient(165deg, #0c1226 0%, #05060f 100%)"\n---\n\n# Hi\n',
    })
    await collectSiteContent(dir)
    expect(warnings.filter((w) => w.includes('YAML reads'))).toEqual([])
  })
})
