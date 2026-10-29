/**
 * ⭐ A RECORD'S LIST ITEMS KEEP THEIR IDENTITY ACROSS SENDS.
 *
 * An item of a list without a `$uuid` is a new row, so a record re-sent with its items
 * uuid-less would replace every stored one — the backend refuses that (`identity_required`,
 * measured 2026-09-25 on an edit of a talk). Each item's `$uuid` is banked from what a push
 * sent and what came back, and the next send takes it by content, then by place.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordItemLists,
  harvestRecordItems,
  storedRecordItems,
  stampRecordItems,
  reprintRecordItems,
} from '../src/uwx/record-items.js'
import { emitSyncPackages, readZip } from '../src/uwx/index.js'

const DECL = {
  name: '@acme/talk',
  sections: {
    brief: {
      brief: true,
      fields: {
        title: { type: 'string' },
        notes: { type: 'section', multiple: true, fields: { text: { type: 'string' } } },
      },
    },
    sessions: {
      multiple: true,
      fields: {
        room: { type: 'string' },
        slots: { type: 'section', multiple: true, fields: { at: { type: 'string' } } },
      },
    },
    parts: { multiple: true, self_nesting: true, fields: { label: { type: 'string' } } },
  },
}

const A = () => ({ room: 'A', slots: [{ at: '9' }, { at: '10' }] })
const B = () => ({ room: 'B' })
const sent = (sessions = [A(), B()]) => ({
  $id: 'talk/opening',
  $schema: '@acme/talk',
  brief: { title: 'Opening', notes: [{ text: 'n1' }] },
  sessions,
  parts: [{ label: 'p1', $children: [{ label: 'p1a' }] }, { label: 'p2' }],
})

// What the backend returns for a document: every list item given a uuid named after its place.
function returnedFor(doc) {
  const out = structuredClone(doc)
  const mint = (items, at) =>
    items.forEach((item, k) => {
      const place = `${at}[${k}]`
      item.$uuid = `U:${place}`
      if (item.slots) mint(item.slots, `${place}.slots`)
      if (item.$children) mint(item.$children, `${place}.$children`)
    })
  out.$uuid = 'REC'
  out.brief.$uuid = 'U:brief' // a single section carries one too, and is not a list
  mint(out.brief.notes, 'brief.notes')
  mint(out.sessions, 'sessions')
  mint(out.parts, 'parts')
  return out
}

const bankFor = (doc) => harvestRecordItems(recordItemLists(doc, DECL), returnedFor(doc))
const uuids = (doc) => ({
  notes: doc.brief.notes.map((i) => i.$uuid),
  sessions: doc.sessions.map((i) => i.$uuid),
  slots: doc.sessions.map((i) => (i.slots || []).map((s) => s.$uuid)),
  parts: doc.parts.map((i) => i.$uuid),
  children: doc.parts.map((i) => (i.$children || []).map((c) => c.$uuid)),
})

describe('the bank — each list item, at its place, with its fingerprint as sent', () => {
  it('pairs every item of every list, nested lists and $children included, with the uuid returned', () => {
    const bank = bankFor(sent())
    expect(Object.keys(bank).sort()).toEqual([
      'brief.notes[0]',
      'parts[0]',
      'parts[0].$children[0]',
      'parts[1]',
      'sessions[0]',
      'sessions[0].slots[0]',
      'sessions[0].slots[1]',
      'sessions[1]',
    ])
    expect(bank['sessions[0]']).toMatch(/^U:sessions\[0\] [0-9a-f]{16}$/)
    // A single section with no list above it is matched by section: not banked.
    expect(Object.values(bank).some((v) => v.startsWith('U:brief '))).toBe(false)
  })

  it('a list that came back with another length is banked without fingerprints', () => {
    const doc = sent()
    const back = returnedFor(doc)
    back.sessions.push({ room: 'C', $uuid: 'U:extra' })
    const bank = harvestRecordItems(recordItemLists(doc, DECL), back)
    expect(bank['sessions[0]']).toBe('U:sessions[0]')
    expect(bank['sessions[2]']).toBe('U:extra')
  })
})

describe('the next send — each item takes a banked uuid by content, then by place', () => {
  it('an unchanged record takes every uuid back', () => {
    const bank = bankFor(sent())
    const next = sent()
    const counts = stampRecordItems(next, DECL, bank)
    expect(counts).toEqual({ stamped: 8, unknown: 0, unbankedSingles: 0 })
    expect(uuids(next)).toEqual({
      notes: ['U:brief.notes[0]'],
      sessions: ['U:sessions[0]', 'U:sessions[1]'],
      slots: [['U:sessions[0].slots[0]', 'U:sessions[0].slots[1]'], []],
      parts: ['U:parts[0]', 'U:parts[1]'],
      children: [['U:parts[0].$children[0]'], []],
    })
    // A single section with no list above it is matched by section, and is sent as it is.
    expect(next.brief).not.toHaveProperty('$uuid')
  })

  it('an item edited where it stands keeps its uuid — by place', () => {
    const bank = bankFor(sent())
    const next = sent([A(), { room: 'B, renamed' }])
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual(['U:sessions[0]', 'U:sessions[1]'])
  })

  it('an item inserted at the top is new, and the others keep theirs — by content', () => {
    const bank = bankFor(sent())
    const next = sent([{ room: 'New' }, A(), B()])
    const counts = stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual([undefined, 'U:sessions[0]', 'U:sessions[1]'])
    // The moved item's own list is found under the place it was banked at.
    expect(uuids(next).slots[1]).toEqual(['U:sessions[0].slots[0]', 'U:sessions[0].slots[1]'])
    expect(counts.unknown).toBe(1)
  })

  it('a reorder keeps every uuid with its item', () => {
    const bank = bankFor(sent())
    const next = sent([B(), A()])
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual(['U:sessions[1]', 'U:sessions[0]'])
    expect(uuids(next).slots[1]).toEqual(['U:sessions[0].slots[0]', 'U:sessions[0].slots[1]'])
  })

  it('an item whose own nested items changed keeps its uuid when it moves — found by its own fields', () => {
    // Measured live 2026-09-25 before the fingerprint left nested lists out: a tree's top level
    // reordered while a child was renamed, and the parent and its whole subtree came back new.
    const bank = bankFor(sent())
    const next = sent()
    next.parts = [{ label: 'p2' }, { label: 'p1', $children: [{ label: 'p1a, renamed' }] }]
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).parts).toEqual(['U:parts[1]', 'U:parts[0]'])
    expect(uuids(next).children[1]).toEqual(['U:parts[0].$children[0]'])
  })

  it('a deleted item is left out — its uuid claimed by nothing', () => {
    const bank = bankFor(sent())
    const next = sent([B()])
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual(['U:sessions[1]'])
  })

  it('two identical items each take one of the two banked', () => {
    const bank = bankFor(sent([B(), B()]))
    const next = sent([B(), B()])
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual(['U:sessions[0]', 'U:sessions[1]'])
  })

  it('with nothing left unchanged, items are matched by place — an edit and a replacement look alike', () => {
    const bank = bankFor(sent())
    const next = sent([{ room: 'New' }, { room: 'A, renamed', slots: [{ at: '9' }] }])
    stampRecordItems(next, DECL, bank)
    // No fingerprint matches, so each item takes the uuid banked at its own place: the store
    // updates both rows in place, and ends up holding exactly what the file says.
    expect(uuids(next).sessions).toEqual(['U:sessions[0]', 'U:sessions[1]'])
    // The item at place 1 took B's row, and B had no slots: its slot is new.
    expect(uuids(next).slots[1]).toEqual([undefined])
  })

  it('⛔ no uuid is stamped twice, whatever the bank says', () => {
    const bank = bankFor(sent())
    bank['sessions[1]'] = bank['sessions[0]'] // a bank that went wrong
    const next = sent()
    stampRecordItems(next, DECL, bank)
    const s = uuids(next).sessions
    expect(s[0]).toBe('U:sessions[0]')
    expect(s[1]).toBeUndefined()
  })

  it('CONTROL — with no bank every item goes as new', () => {
    const next = sent()
    expect(stampRecordItems(next, DECL, {})).toEqual({ stamped: 0, unknown: 8, unbankedSingles: 0 })
    expect(uuids(next).sessions).toEqual([undefined, undefined])
  })
})

describe('a record whose items were never banked — recovered from the stored document', () => {
  it('reads every list by shape, with no fingerprints, and the next send matches by place', () => {
    const stored = returnedFor(sent())
    stored.sessions[0].room = { en: 'A' } // a localized value is a map, not a section
    stored.brief.speaker = { schema: '@acme/speaker', entity: 'S1' } // nor is a reference
    const bank = storedRecordItems(stored)
    expect(bank).toEqual({
      'brief.notes[0]': 'U:brief.notes[0]',
      'sessions[0]': 'U:sessions[0]',
      'sessions[0].slots[0]': 'U:sessions[0].slots[0]',
      'sessions[0].slots[1]': 'U:sessions[0].slots[1]',
      'sessions[1]': 'U:sessions[1]',
      'parts[0]': 'U:parts[0]',
      'parts[0].$children[0]': 'U:parts[0].$children[0]',
      'parts[1]': 'U:parts[1]',
    })
    const next = sent([{ room: 'A, edited', slots: [{ at: '9' }, { at: '10' }] }, B()])
    stampRecordItems(next, DECL, bank)
    expect(uuids(next).sessions).toEqual(['U:sessions[0]', 'U:sessions[1]'])
  })
})

describe('a bank refingerprinted — the same items, another encoding', () => {
  it('keeps each uuid at its place and takes the new fingerprint', () => {
    const before = sent([{ room: 'A', slots: [{ at: { $ref: 'slot/nine' } }] }])
    const bank = bankFor(before)
    const after = sent([{ room: 'A', slots: [{ at: 'UUID-NINE' }] }])
    const reprinted = reprintRecordItems(bank, recordItemLists(after, DECL))
    expect(reprinted['sessions[0].slots[0]'].split(' ')[0]).toBe('U:sessions[0].slots[0]')
    expect(reprinted['sessions[0].slots[0]']).not.toBe(bank['sessions[0].slots[0]'])
    // Now the item moves in the next send, and is still found by content.
    const next = sent([B(), { room: 'A', slots: [{ at: 'UUID-NINE' }] }])
    stampRecordItems(next, DECL, reprinted)
    expect(uuids(next).sessions[1]).toBe('U:sessions[0]')
  })
})

// ── A single section under a list holds one item per item of the list ────────────────
// So a backend matches it by `$uuid`, as a list element: it is banked at its place under its
// item and stamped when its item keeps its uuid. A top-level single is still matched by section.

const CV = {
  name: '@acme/cv',
  sections: {
    brief: { brief: true, fields: { name: { type: 'string' } } },
    degrees: {
      multiple: true,
      fields: {
        title: { type: 'string' },
        thesis: {
          type: 'section',
          fields: {
            topic: { type: 'string' },
            committee: { type: 'section', fields: { chair: { type: 'string' } } },
          },
        },
      },
    },
  },
}
const PHD = () => ({ title: 'PhD', thesis: { topic: 'Engines', committee: { chair: 'Babbage' } } })
const MSC = () => ({ title: 'MSc', thesis: { topic: 'Looms' } })
const cv = (degrees = [PHD(), MSC()]) => ({ $id: 'cv/ada', $schema: '@acme/cv', brief: { name: 'Ada' }, degrees })

// What the backend returns: every item a uuid named after its place, a single section's too.
function returnedCv(doc) {
  const out = structuredClone(doc)
  out.$uuid = 'REC'
  out.brief.$uuid = 'U:brief'
  out.degrees.forEach((d, k) => {
    d.$uuid = `U:degrees[${k}]`
    if (d.thesis) d.thesis.$uuid = `U:degrees[${k}].thesis`
    if (d.thesis?.committee) d.thesis.committee.$uuid = `U:degrees[${k}].thesis.committee`
  })
  return out
}
const cvBank = (doc) => harvestRecordItems(recordItemLists(doc, CV), returnedCv(doc))
const theses = (doc) => doc.degrees.map((d) => d.thesis?.$uuid)

describe('a single section under a list — banked and stamped as a list element', () => {
  it('is banked at its place under its item, with no fingerprint; a top-level one is not', () => {
    expect(cvBank(cv())).toEqual({
      'degrees[0]': expect.stringMatching(/^U:degrees\[0\] [0-9a-f]{16}$/),
      'degrees[0].thesis': 'U:degrees[0].thesis',
      'degrees[0].thesis.committee': 'U:degrees[0].thesis.committee',
      'degrees[1]': expect.stringMatching(/^U:degrees\[1\] [0-9a-f]{16}$/),
      'degrees[1].thesis': 'U:degrees[1].thesis',
    })
  })

  it('an unchanged record takes every one back', () => {
    const next = cv()
    expect(stampRecordItems(next, CV, cvBank(cv()))).toEqual({ stamped: 5, unknown: 0, unbankedSingles: 0 })
    expect(theses(next)).toEqual(['U:degrees[0].thesis', 'U:degrees[1].thesis'])
    expect(next.degrees[0].thesis.committee.$uuid).toBe('U:degrees[0].thesis.committee')
    expect(next.brief).not.toHaveProperty('$uuid')
  })

  it('follows its item when the list is reordered', () => {
    const next = cv([MSC(), PHD()])
    stampRecordItems(next, CV, cvBank(cv()))
    expect(theses(next)).toEqual(['U:degrees[1].thesis', 'U:degrees[0].thesis'])
  })

  it('comes new with a new item, and asks for no recovery', () => {
    const next = cv([{ title: 'BSc', thesis: { topic: 'Gears' } }, PHD(), MSC()])
    const counts = stampRecordItems(next, CV, cvBank(cv()))
    expect(theses(next)).toEqual([undefined, 'U:degrees[0].thesis', 'U:degrees[1].thesis'])
    expect(counts.unbankedSingles).toBe(0)
  })

  it('under an item that kept its uuid, with none banked — a bank from before — is counted for recovery', () => {
    const lists = Object.entries(cvBank(cv())).filter(([place]) => place.endsWith(']'))
    const next = cv()
    expect(stampRecordItems(next, CV, Object.fromEntries(lists))).toEqual({ stamped: 2, unknown: 0, unbankedSingles: 3 })
    expect(theses(next)).toEqual([undefined, undefined])
  })

  it('is read from a stored document by shape, as the lists are', () => {
    expect(storedRecordItems(returnedCv(cv()))).toEqual({
      'degrees[0]': 'U:degrees[0]',
      'degrees[0].thesis': 'U:degrees[0].thesis',
      'degrees[0].thesis.committee': 'U:degrees[0].thesis.committee',
      'degrees[1]': 'U:degrees[1]',
      'degrees[1].thesis': 'U:degrees[1].thesis',
    })
  })

  it('keeps its uuid through a refingerprinted bank', () => {
    const reprinted = reprintRecordItems(cvBank(cv()), recordItemLists(cv(), CV))
    expect(reprinted['degrees[0].thesis']).toBe('U:degrees[0].thesis')
  })
})

// ── The package: a record the backend holds is sent with its items' uuids ────────────

describe('emitSyncPackages — record list items', () => {
  let ROOT, SITE
  const ORIGIN = 'http://backend.test'
  const w = (rel, body) => {
    const p = join(SITE, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  }
  beforeEach(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'uwx-items-'))
    SITE = join(ROOT, 'site')
    const fdn = join(ROOT, 'foundation')
    mkdirSync(join(fdn, 'dist', 'meta'), { recursive: true })
    writeFileSync(join(fdn, 'package.json'), JSON.stringify({ name: '@acme/marketing', version: '1.0.0' }))
    writeFileSync(
      join(fdn, 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/marketing', version: '1', role: 'foundation' },
        dataSchemas: {
          '@/talk': {
            name: 'talk',
            sections: {
              brief: { kind: 'single', brief: true, fields: { title: { type: 'string' } } },
              sessions: { kind: 'multi', fields: { room: { type: 'string' } } },
            },
          },
        },
      })
    )
    w('site.yml', 'name: Acme\nfoundation: "@acme/marketing"\n')
    w('package.json', { name: 's', dependencies: { '@acme/marketing': 'file:../foundation' } })
    w('pages/home/page.yml', 'title: Home\n')
    w('records/talk/opening.yml', '$uuid: OWN-TALK\nbrief:\n  title: Opening\nsessions:\n  - room: Hall A\n  - room: Hall B\n')
    w('sync.json', { version: 1, backends: { [ORIGIN]: { records: { 'OWN-TALK': 'MINT-TALK' } } } })
  })
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

  const talkIn = (pkg) => {
    for (const [name, buf] of readZip(pkg.records.buffer)) {
      if (!name.startsWith('entities/')) continue
      const doc = JSON.parse(buf.toString('utf8'))
      if (doc.$id === 'talk/opening') return doc
    }
    return null
  }

  it('stamps each item of a record the backend holds from the bank', async () => {
    const recordItemUuids = { 'MINT-TALK': { 'sessions[0]': 'I-A', 'sessions[1]': 'I-B' } }
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN, recordItemUuids })
    expect(pkg.refusals).toEqual([])
    expect(talkIn(pkg).sessions.map((s) => s.$uuid)).toEqual(['I-A', 'I-B'])
    expect(pkg.recordItemIdentity).toEqual({ stamped: 2, unknown: 0, unbanked: [] })
    // The lists as sent ride on the record's index entry, for the caller to bank.
    const entry = pkg.records.index.find((e) => e.id === 'talk/opening')
    expect(entry.lists.sessions).toHaveLength(2)
  })

  it('names a record the backend holds with items and no bank entry — the caller recovers it', async () => {
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(talkIn(pkg).sessions.every((s) => !('$uuid' in s))).toBe(true)
    expect(pkg.recordItemIdentity.unbanked).toEqual(['MINT-TALK'])
  })

  it('CONTROL — a record new to the backend needs nothing: every item is new', async () => {
    w('sync.json', { version: 1, backends: {} })
    const pkg = await emitSyncPackages(SITE, { backend: ORIGIN })
    expect(pkg.recordItemIdentity).toEqual({ stamped: 0, unknown: 0, unbanked: [] })
  })

  it('names a record whose single section under a list has no banked uuid — the caller recovers it', async () => {
    writeFileSync(
      join(ROOT, 'foundation', 'dist', 'meta', 'schema.json'),
      JSON.stringify({
        _self: { name: '@acme/marketing', version: '1', role: 'foundation' },
        dataSchemas: {
          '@/cv': {
            name: 'cv',
            sections: {
              brief: { kind: 'single', brief: true, fields: { name: { type: 'string' } } },
              degrees: {
                kind: 'multi',
                fields: { title: { type: 'string' }, thesis: { type: 'object', fields: { topic: { type: 'string' } } } },
              },
            },
          },
        },
      })
    )
    rmSync(join(SITE, 'records', 'talk'), { recursive: true, force: true })
    w('records/cv/ada.yml', '$uuid: OWN-CV\nbrief:\n  name: Ada\ndegrees:\n  - title: PhD\n    thesis:\n      topic: Engines\n')
    w('sync.json', { version: 1, backends: { [ORIGIN]: { records: { 'OWN-CV': 'MINT-CV' } } } })
    const cvIn = (pkg) => {
      for (const [name, buf] of readZip(pkg.records.buffer)) {
        if (!name.startsWith('entities/')) continue
        const doc = JSON.parse(buf.toString('utf8'))
        if (doc.$id === 'cv/ada') return doc
      }
      return null
    }
    // A bank from before: the degree, not its thesis.
    const before = await emitSyncPackages(SITE, { backend: ORIGIN, recordItemUuids: { 'MINT-CV': { 'degrees[0]': 'I-PHD' } } })
    expect(before.recordItemIdentity.unbanked).toEqual(['MINT-CV'])
    // Recovered, the thesis goes with its uuid and nothing is asked again.
    const after = await emitSyncPackages(SITE, {
      backend: ORIGIN,
      recordItemUuids: { 'MINT-CV': { 'degrees[0]': 'I-PHD', 'degrees[0].thesis': 'I-THESIS' } },
    })
    expect(after.recordItemIdentity.unbanked).toEqual([])
    expect(cvIn(after).degrees[0]).toMatchObject({ $uuid: 'I-PHD', thesis: { $uuid: 'I-THESIS', topic: { en: 'Engines' } } })
    expect(cvIn(after).brief).not.toHaveProperty('$uuid')
  })

  it('stamping moves no content hash', async () => {
    const bare = await emitSyncPackages(SITE, { backend: ORIGIN })
    const stamped = await emitSyncPackages(SITE, {
      backend: ORIGIN,
      recordItemUuids: { 'MINT-TALK': { 'sessions[0]': 'I-A', 'sessions[1]': 'I-B' } },
    })
    expect(stamped.hashes).toEqual(bare.hashes)
  })
})
