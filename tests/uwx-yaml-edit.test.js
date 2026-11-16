/**
 * The YAML editor — `editYamlText`, and the two text edits a command decides on before it
 * writes anything: `setYamlKey` and `replaceInYamlList` (`uniweb rename`).
 *
 * What is pinned: the rest of the file is byte-for-byte what it was — comments, blank lines,
 * quoting, a list on one line — and a text the edit cannot keep is refused (null) rather than
 * guessed at. Most cases came with the CLI's `utils/yaml-edit.js`, folded in here on
 * 2026-10-07; two changed answer on purpose, and say so.
 */

import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { editYamlText, setYamlKey, replaceInYamlList } from '../src/uwx/index.js'
import { setYamlKeyFirst } from '../src/uwx/yaml-edit.js'
import { YAML_OPTIONS } from '../src/utils/yaml-schema.js'

// What a text says, as the build reads it.
const read = (text) => yaml.load(text, YAML_OPTIONS)

const SITE = `# The sample site
name: Research Profile
description: A researcher's site with a profile, research projects, a full publication list and the team.
tags: [academic, personal]

# Foundation to use for this site
foundation: src

# Homepage
index: home
`

describe('setYamlKey', () => {
  it('changes one line and nothing else', () => {
    expect(setYamlKey(SITE, 'foundation', 'research-profile')).toBe(
      SITE.replace('foundation: src', 'foundation: research-profile')
    )
  })

  it('keeps the inline comment on the line it edits', () => {
    expect(setYamlKey('name: x\nfoundation: src   # the local one\n', 'foundation', 'product-launch')).toBe(
      'name: x\nfoundation: product-launch   # the local one\n'
    )
  })

  it('quotes a value YAML cannot leave plain', () => {
    expect(setYamlKey(SITE, 'foundation', '@acme/site')).toMatch(/^foundation: '@acme\/site'$/m)
  })

  it('keeps the quotes a value was written in', () => {
    expect(setYamlKey('foundation: "src"\n', 'foundation', 'web')).toBe('foundation: "web"\n')
    expect(setYamlKey("foundation: 'src'\n", 'foundation', "it's")).toBe("foundation: 'it''s'\n")
  })

  it('⭐ a block scalar is edited whole — the line editor refused one, since replacing its key line left `src` behind', () => {
    expect(setYamlKey('name: x\nfoundation: >-\n  src\n', 'foundation', 'web')).toBe('name: x\nfoundation: web\n')
  })

  it('⭐ an absent key is added after the last one — the line editor refused, and the scalar upsert put it above the header comments', () => {
    expect(setYamlKey('# Site\nname: x\n', 'foundation', 'web')).toBe('# Site\nname: x\nfoundation: web\n')
  })

  it('refuses a text it cannot read, or keep, as it is', () => {
    expect(setYamlKey('not: [valid', 'foundation', 'y')).toBeNull()
    expect(setYamlKey('- a\n- b\n', 'foundation', 'y')).toBeNull() // not a map
    expect(setYamlKey('<<: { a: 1 }\nfoundation: x\n', 'foundation', 'y')).toBeNull() // the file's own map merges
  })

  it('⭐ an alias set to another value is written as its own value, and its anchor stays (refused until 2026-11-16)', () => {
    expect(setYamlKey('base: &b x\nfoundation: *b\n', 'foundation', 'web')).toBe('base: &b x\nfoundation: web\n')
  })
})

const EXT = '/extensions/effects/dist/entry.js'
const NEW = '/extensions/visual-effects/dist/entry.js'

describe('replaceInYamlList', () => {
  it('edits block entries where they stand, and leaves comments alone', () => {
    const text = `name: x
# ${EXT} is the effects extension
extensions:
  # the hero's particles
  - ${EXT}   # particle hero
  - https://cdn.example.com/other.js
`
    expect(replaceInYamlList(text, 'extensions', new Map([[EXT, NEW]]))).toBe(text.replace(`  - ${EXT}`, `  - ${NEW}`))
  })

  it('edits a one-line flow list and quoted entries, in their quotes', () => {
    expect(replaceInYamlList(`extensions: [${EXT}, '/x.js']\n`, 'extensions', new Map([[EXT, NEW]]))).toBe(
      `extensions: [${NEW}, '/x.js']\n`
    )
    expect(replaceInYamlList(`extensions:\n  - "${EXT}"\n`, 'extensions', new Map([[EXT, NEW]]))).toBe(
      `extensions:\n  - "${NEW}"\n`
    )
  })

  it('a new flow entry that YAML cannot leave plain there is quoted, and does not run into the next', () => {
    expect(replaceInYamlList('tags: [a, b]\n', 'tags', new Map([['a', 'x, y']]))).toBe("tags: ['x, y', b]\n")
  })

  it('does not touch a value that only contains the old one', () => {
    const other = `/nested${EXT}`
    expect(replaceInYamlList(`extensions:\n  - ${EXT}\n  - ${other}\n`, 'extensions', new Map([[EXT, NEW]]))).toBe(
      `extensions:\n  - ${NEW}\n  - ${other}\n`
    )
  })

  it('refuses when the key is not a list', () => {
    expect(replaceInYamlList('extensions: nope\n', 'extensions', new Map([[EXT, NEW]]))).toBeNull()
    expect(replaceInYamlList('name: x\n', 'extensions', new Map([[EXT, NEW]]))).toBeNull()
  })
})

describe('editYamlText — lists', () => {
  it('a list that grew is written whole, in the style it had', () => {
    const before = { tags: ['a', 'b'], name: 'S' }
    expect(editYamlText('tags: [a, b]   # card\nname: S\n', before, { ...before, tags: ['a', 'b', 'c'] })).toBe(
      'tags: [a, b, c]\nname: S\n'
    )
    expect(editYamlText('tags:\n  - a\n  - b\nname: S\n', before, { ...before, tags: ['a'] })).toBe(
      'tags:\n  - a\nname: S\n'
    )
  })

  it('a list entry that is a map is written with its list, whole', () => {
    const before = { items: [{ a: 1 }, { a: 2 }] }
    expect(editYamlText('items:\n  - a: 1\n  - a: 2\n', before, { items: [{ a: 1 }, { a: 3 }] })).toBe(
      'items:\n  - a: 1\n  - a: 3\n'
    )
  })
})

// ⛔ Measured 2026-11-16 on a docs site: its `site.yml` gave an assistant's settings once, under an
// anchor, and named them again with an alias. The engine declined any alias, so the writer dumped the
// file whole, and a pull that changed only its favicon took every comment, made the anchor two copies
// and the folded `>` block a `|`: 28 lines added, 91 removed.
describe('editYamlText — an anchor and its aliases', () => {
  const PERSONA = `name: docs
# the mark, the same upload the other sites use
favicon: https://example.com/a.svg
services:
  # site search on the host
  search: true
  assistant: &persona
    tone: plain
    maxTokens: 1024
    system: >
        You are the help
        assistant.
    capabilities:
        - answer

# ⛔ the host that serves the site today reads this key, so it names the same settings
intelligence: *persona
build:
    prerender: true
`
  const before = read(PERSONA)
  const assistant = before.services.assistant
  const withAssistant = (a) => ({ ...before, services: { ...before.services, assistant: a } })

  it('⭐ a change elsewhere is that line alone: the anchor, the alias, the comments and the folded block stay', () => {
    expect(editYamlText(PERSONA, before, { ...before, favicon: '/favicon.svg' })).toBe(
      PERSONA.replace('favicon: https://example.com/a.svg', 'favicon: /favicon.svg')
    )
  })

  it('both places changed alike: edited where the anchor is, and the alias stays', () => {
    const changed = { ...assistant, maxTokens: 2048 }
    const out = editYamlText(PERSONA, before, { ...withAssistant(changed), intelligence: changed })
    expect(out).toBe(PERSONA.replace('maxTokens: 1024', 'maxTokens: 2048'))
  })

  it('⭐ one place changed: the anchor is edited where it stands, and the alias is written as its own value', () => {
    const out = editYamlText(PERSONA, before, withAssistant({ ...assistant, maxTokens: 2048 }))
    expect(read(out)).toEqual(withAssistant({ ...assistant, maxTokens: 2048 }))
    expect(out).toContain('  assistant: &persona\n    tone: plain\n    maxTokens: 2048\n')
    expect(out).not.toContain('*persona')
    // …and everything the edit had no reason to touch is as it was
    expect(out).toContain('# the mark, the same upload the other sites use\n')
    expect(out).toContain("# ⛔ the host that serves the site today reads this key, so it names the same settings\nintelligence:\n")
    expect(out.endsWith('build:\n    prerender: true\n')).toBe(true)
  })

  it('the other place changed: the alias is written as its own value, and the anchor is left as it was', () => {
    const out = editYamlText(PERSONA, before, { ...before, intelligence: { ...assistant, maxTokens: 9 } })
    expect(read(out)).toEqual({ ...before, intelligence: { ...assistant, maxTokens: 9 } })
    expect(out.slice(0, out.indexOf('# ⛔'))).toBe(PERSONA.slice(0, PERSONA.indexOf('# ⛔')))
  })

  it('an anchored value written whole keeps its anchor', () => {
    const out = editYamlText('a: &x [1, 2]\nb: *x\n', { a: [1, 2], b: [1, 2] }, { a: [1, 2, 3], b: [1, 2, 3] })
    expect(out).toBe('a: &x [1, 2, 3]\nb: *x\n')
  })

  it('an alias in a list stays while it says its entry', () => {
    const text = 'base: &b x\nlist:\n  - *b\n  - y\n'
    expect(editYamlText(text, read(text), { base: 'x', list: ['x', 'z'] })).toBe('base: &b x\nlist:\n  - *b\n  - z\n')
  })

  it('a map that merges another in is written whole when it changes, and the rest of the file stays', () => {
    const text = '# defaults\nbase: &b\n  a: 1\nsite:\n  <<: *b\n  c: 3\n# after\nname: x\n'
    const out = editYamlText(text, read(text), { base: { a: 1 }, site: { a: 1, c: 4 }, name: 'x' })
    expect(read(out)).toEqual({ base: { a: 1 }, site: { a: 1, c: 4 }, name: 'x' })
    expect(out.startsWith('# defaults\nbase: &b\n  a: 1\n')).toBe(true)
    expect(out.endsWith('# after\nname: x\n')).toBe(true)
    // unchanged, it is left as it is
    expect(editYamlText(text, read(text), { ...read(text), name: 'web' })).toBe(text.replace('name: x', 'name: web'))
  })

  it('CONTROL — a merge key in the file’s own map is still declined, so the writer writes it whole', () => {
    const text = 'base: &b { a: 1 }\n<<: *b\nname: x\n'
    expect(editYamlText(text, read(text), { ...read(text), name: 'web' })).toBeNull()
  })
})

// ⛔ Measured 2026-10-08: a pull that gave a bare `team:` its schema deleted the blank line and the
// `# Build options` heading under it. The parser hangs every comment that follows an empty value
// on that value, up to the next key; they belong to what follows.
describe('editYamlText — a bare key', () => {
  const SITE_QUERIES =
    "queries:\n  articles:\n    schema: '@std/article'\n\n  # the team\n  team:\n\n# Build options\nbuild:\n  prerender: true\n"
  const before = { queries: { articles: { schema: '@std/article' }, team: null }, build: { prerender: true } }
  const withTeam = (team) => ({ ...before, queries: { ...before.queries, team } })

  it('⭐ given a value, keeps the blank line and the comments under it', () => {
    expect(editYamlText(SITE_QUERIES, before, withTeam({ schema: '@/team' }))).toBe(
      SITE_QUERIES.replace('  team:\n', "  team:\n    schema: '@/team'\n")
    )
  })

  it('keeps the comment on its own line, and the value goes under it', () => {
    const text = 'queries:\n  team:   # the people\n  # next one\n  events:\n'
    const was = { queries: { team: null, events: null } }
    expect(editYamlText(text, was, { queries: { team: { schema: '@/team' }, events: null } })).toBe(
      "queries:\n  team:   # the people\n    schema: '@/team'\n  # next one\n  events:\n"
    )
  })

  it('removed, takes its own line and leaves the comments under it', () => {
    expect(editYamlText(SITE_QUERIES, before, { ...before, queries: { articles: before.queries.articles } })).toBe(
      SITE_QUERIES.replace('  team:\n', '')
    )
  })

  it('a key added after it lands under it, above the comments that follow', () => {
    const after = { ...before, queries: { ...before.queries, events: { limit: 3 } } }
    expect(editYamlText(SITE_QUERIES, before, after)).toBe(
      SITE_QUERIES.replace('  team:\n', '  team:\n  events:\n    limit: 3\n')
    )
  })

  it('CONTROL — a value written out (`~`) is replaced on its line, as any scalar', () => {
    const text = 'team: ~\n# next\nevents: 1\n'
    expect(editYamlText(text, { team: null, events: 1 }, { team: 'x', events: 1 })).toBe('team: x\n# next\nevents: 1\n')
  })
})

describe('setYamlKeyFirst — an identity written into a file an author wrote', () => {
  it('⭐ the key leads the map, after the comments that head the file, and nothing else moves', () => {
    const text = '# Header\n\ntitle: "A: b"\ntags: [a, b]\n'
    expect(setYamlKeyFirst(text, '$uuid', 'u-1')).toBe('# Header\n\n$uuid: u-1\ntitle: "A: b"\ntags: [a, b]\n')
  })

  it('a key already there is set where it stands, its comment kept', () => {
    expect(setYamlKeyFirst('title: T\n$uuid: old  # kept\n', '$uuid', 'new')).toBe('title: T\n$uuid: new  # kept\n')
  })

  it('an empty file, or one of comments alone, gains the line after them', () => {
    expect(setYamlKeyFirst('', '$uuid', 'u')).toBe('$uuid: u\n')
    expect(setYamlKeyFirst('# only a comment\n', '$uuid', 'u')).toBe('# only a comment\n$uuid: u\n')
  })

  it('null for what it cannot edit in place: a flow map, a list', () => {
    expect(setYamlKeyFirst('{ title: T }\n', '$uuid', 'u')).toBeNull()
    expect(setYamlKeyFirst('- a\n- b\n', '$uuid', 'u')).toBeNull()
  })

  it('⭐ an anchor and its alias are no reason to decline — the line before them changes neither (refused until 2026-11-16)', () => {
    expect(setYamlKeyFirst('a: &x 1\nb: *x\n', '$uuid', 'u')).toBe('$uuid: u\na: &x 1\nb: *x\n')
  })
})
