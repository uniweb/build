// Conformance: the framework's per-element translation-unit KEYS must equal the
// whole-element vectors in structural-keying-vectors.json. The "map key" the framework
// emits is stripInlineTags(unit.source) — what the structural translation map is keyed
// by — so we assert that key set per vector.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractUnitsFromDoc } from '../../src/i18n/extract.js'
import { stripInlineTags } from '../../src/i18n/hash.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'structural-keying-vectors.json'), 'utf8'))

function emittedKeys(doc) {
  const units = extractUnitsFromDoc(doc)
  return new Set(Object.values(units).map((u) => stripInlineTags(u.source)))
}

describe('structural-keying conformance (whole-element)', () => {
  for (const c of fixture.cases) {
    it(`vector ${c.id}: ${c.rule}`, () => {
      expect(emittedKeys(c.doc)).toEqual(new Set(c.expectedKeys))
    })
  }
})
