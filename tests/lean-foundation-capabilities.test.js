// ⭐ ONLY WHAT THE RUNTIME READS OF main.js REACHES IT — ruled 2026-10-01 [Diego]: "Only what runtime
// really reads for rendering should reach it." The entry references the code the runtime calls and
// writes the data it reads as a lean literal (`extractFoundationRuntime`). ⛔ Until then it spread
// main.js's whole default export into `capabilities`, and a foundation's name and its vars'
// descriptions shipped in every published bundle.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateEntryPoint } from '../src/generate-entry.js'
import { extractFoundationRuntime, RUNTIME_CODE_CAPABILITIES } from '../src/runtime-schema.js'

describe('extractFoundationRuntime — what the runtime reads of main.js', () => {
  const config = {
    name: '@acme/site-kit',
    description: 'A kit',
    extension: false,
    somethingCustom: { a: 1 },
    vars: {
      'header-height': { default: '4rem', type: 'length', label: 'Header height', description: 'How tall' },
      'font-body': { default: 'Inter', type: 'font', applyTo: 'body', description: 'Body face' },
      accent: '#09f',
    },
    data: { team: '@/member', posts: '@std/article/*', 'md:faq': 'Questions', raw: {}, inline: { title: 'string' } },
    handlers: { content() {} },
    props: {},
    defaultLayout: 'main',
    defaultSection: 'Prose',
    viewTransitions: true,
    scroll: 'main',
  }

  it('references the code the runtime calls', () => {
    expect(extractFoundationRuntime(config).code).toEqual(['handlers', 'props'])
    expect(RUNTIME_CODE_CAPABILITIES).toEqual(['handlers', 'defaultInsets', 'xref', 'transports', 'outputs', 'props'])
  })

  it('writes its data lean — a var\'s default, type and applyTo; a data key\'s ref', () => {
    expect(extractFoundationRuntime(config).data).toEqual({
      defaultLayout: 'main',
      defaultSection: 'Prose',
      viewTransitions: true,
      scroll: 'main',
      vars: {
        'header-height': { default: '4rem', type: 'length' },
        'font-body': { default: 'Inter', type: 'font', applyTo: 'body' },
        accent: '#09f',
      },
      data: { team: '@/member', posts: '@std/article/*', faq: null, raw: null, inline: null },
    })
  })

  it('never the identity, nor a key the framework does not read', () => {
    const json = JSON.stringify(extractFoundationRuntime(config))
    for (const absent of ['@acme/site-kit', 'A kit', 'extension', 'somethingCustom', 'Header height', 'How tall', 'Body face']) {
      expect(json).not.toContain(absent)
    }
  })

  it('a data key that is not plain data is referenced like code, so nothing is lost', () => {
    const scroll = () => 'main'
    expect(extractFoundationRuntime({ scroll })).toEqual({ code: ['scroll'], data: {} })
  })

  it('CONTROL — an empty main.js gives nothing', () => {
    expect(extractFoundationRuntime({})).toEqual({ code: [], data: {} })
  })
})

describe('the generated entry', () => {
  let dir
  const write = (rel, text) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const section = (name) => {
    write(`sections/${name}/meta.js`, 'export default { title: "X" }\n')
    write(`sections/${name}/${name}.jsx`, `export default function ${name}() { return null }\n`)
  }
  const entry = async () => {
    await generateEntryPoint(dir, join(dir, '_entry.generated.js'))
    return readFileSync(join(dir, '_entry.generated.js'), 'utf8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uw-lean-caps-'))
    write('package.json', JSON.stringify({ name: 'src', version: '1.0.0', type: 'module' }))
    section('Hero')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('references the code and inlines the lean data — no name, no description, no spread', async () => {
    write(
      'main.js',
      `export const vars = { 'header-height': { default: '4rem', description: 'DESCRIPTION-OF-A-VAR' } }
export default {
  name: '@acme/NAME-OF-THE-FOUNDATION',
  description: 'DESCRIPTION-OF-THE-FOUNDATION',
  handlers: { content(block) { return block } },
  defaultLayout: 'main',
  data: { team: '@/member' },
}
`
    )
    const source = await entry()
    expect(source).toContain(`import * as _foundationModule from './main.js'`)
    expect(source).toContain('handlers: _foundationModule.default?.handlers')
    expect(source).toContain('defaultLayout: "main"')
    expect(source).toContain('vars: {"header-height":{"default":"4rem"}}')
    expect(source).toContain('data: {"team":"@/member"}')
    expect(source).not.toContain('..._foundationModule')
    expect(source).not.toMatch(/NAME-OF-THE-FOUNDATION|DESCRIPTION-OF-THE-FOUNDATION|DESCRIPTION-OF-A-VAR/)
  })

  it('with no code to call, main.js is imported for its side effects alone', async () => {
    write('main.js', `export default { name: '@acme/kit', vars: { gap: { default: '1rem' } } }\n`)
    const source = await entry()
    expect(source).toContain(`import './main.js'`)
    expect(source).not.toContain('_foundationModule')
    expect(source).toContain('vars: {"gap":{"default":"1rem"}}')
  })

  it('a lone main.jsx is refused — main.js is the only name, and may hold JSX', async () => {
    write('main.jsx', `export default { defaultLayout: 'main' }\n`)
    await expect(entry()).rejects.toThrow(/main\.jsx is not read — rename it to main\.js/)
  })
})
