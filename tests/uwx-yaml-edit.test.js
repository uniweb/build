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
import { editYamlText, setYamlKey, replaceInYamlList } from '../src/uwx/index.js'

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
    expect(setYamlKey('base: &b x\nfoundation: *b\n', 'foundation', 'y')).toBeNull() // an alias
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
