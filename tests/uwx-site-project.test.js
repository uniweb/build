// Site-content projection — info → config files (P2, config slice).
//
// Includes a round-trip against the REAL producer (siteProjectToDocument) so the
// inverse is exercised against the exact document shape it inverts.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { siteInfoToConfig, siteProjectToDocument } from '../src/uwx/index.js'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uwx-site-project-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('siteInfoToConfig — info → config files', () => {
  it('writes site.yml from info, unwrapping localized fields and mapping field names', () => {
    const document = {
      info: {
        name: { en: 'My Site' },
        description: { en: 'A description' },
        foundation_name: '@acme/base@1.2.3',
        locales: ['en', 'fr'],
        default_locale: 'en',
        base_path: '/docs/',
        build_options: { split: true },
      },
      extensions: [{ $id: 'https://cdn.example.com/fx/entry.js', url: 'https://cdn.example.com/fx/entry.js' }],
    }

    const report = siteInfoToConfig({ document, siteRoot: dir })
    expect(report.siteConfig).toBe('updated')

    expect(yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))).toEqual({
      name: 'My Site',
      description: 'A description',
      foundation: '@acme/base@1.2.3',
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      base: '/docs/',
      build: { split: true },
      extensions: ['https://cdn.example.com/fx/entry.js'],
    })
  })

  it('writes theme.yml (whole object) and head.html (raw file)', () => {
    const document = {
      info: {
        name: { en: 'S' },
        foundation_name: '@acme/base',
        theme: { vars: { accent: 'red' }, mode: 'dark' },
        head_html: '<meta name="x" content="y">\n',
      },
    }
    const report = siteInfoToConfig({ document, siteRoot: dir })

    expect(report.theme).toBe('updated')
    expect(yaml.load(readFileSync(join(dir, 'theme.yml'), 'utf8'))).toEqual({ vars: { accent: 'red' }, mode: 'dark' })
    expect(report.headHtml).toBe('updated')
    expect(readFileSync(join(dir, 'head.html'), 'utf8')).toBe('<meta name="x" content="y">\n')
  })

  it('preserves untouched site.yml keys and is idempotent', () => {
    writeFileSync(join(dir, 'site.yml'), "foundation: '@acme/base'\npaths:\n  pages: content\nname: Old\n")
    const document = { info: { name: { en: 'New' }, foundation_name: '@acme/base' } }

    siteInfoToConfig({ document, siteRoot: dir })
    const obj = yaml.load(readFileSync(join(dir, 'site.yml'), 'utf8'))
    expect(obj.name).toBe('New')
    expect(obj.paths).toEqual({ pages: 'content' }) // untouched key preserved

    // second projection makes no change
    expect(siteInfoToConfig({ document, siteRoot: dir }).siteConfig).toBe('unchanged')
  })

  it('does not write theme.yml / head.html when the document omits them', () => {
    siteInfoToConfig({ document: { info: { name: { en: 'S' }, foundation_name: '@acme/base' } }, siteRoot: dir })
    expect(existsSync(join(dir, 'theme.yml'))).toBe(false)
    expect(existsSync(join(dir, 'head.html'))).toBe(false)
  })
})

describe('siteInfoToConfig — round-trip against the real producer', () => {
  it('a site.yml/theme.yml/head.html projected from the produced document matches the source config', async () => {
    // Author a source site, with no pages (the producer tolerates an absent pages/).
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, 'site.yml'),
      "name: Round Trip\nfoundation: '@acme/base@2.0.0'\nlanguages:\n  - en\n  - fr\ndefaultLanguage: en\nbase: /app/\n"
    )
    writeFileSync(join(src, 'theme.yml'), 'vars:\n  accent: blue\n')
    writeFileSync(join(src, 'head.html'), '<link rel="icon" href="/f.ico">\n')

    const document = await siteProjectToDocument(src)

    // Project into a fresh, empty destination.
    const dest = join(dir, 'dest')
    mkdirSync(dest, { recursive: true })
    siteInfoToConfig({ document, siteRoot: dest })

    const siteYml = yaml.load(readFileSync(join(dest, 'site.yml'), 'utf8'))
    expect(siteYml).toMatchObject({
      name: 'Round Trip',
      foundation: '@acme/base@2.0.0',
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      base: '/app/',
    })
    expect(yaml.load(readFileSync(join(dest, 'theme.yml'), 'utf8'))).toEqual({ vars: { accent: 'blue' } })
    expect(readFileSync(join(dest, 'head.html'), 'utf8')).toBe('<link rel="icon" href="/f.ico">\n')
  })
})
