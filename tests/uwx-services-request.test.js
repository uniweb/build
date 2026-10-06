/**
 * `site.yml::services` — the owner's request, and the three-way decision of what to
 * send (kb/framework/reference/site-services-request.md).
 *
 * ⭐ The cases that matter most are the two silent failures: a stale ask re-sent over a
 * decision the owner made in the app, and a partial list that drops the site's other
 * rows. Every `reconcileServices` case is one row of the spec's table.
 */
import {
  readServicesRequest,
  servicesRequestFromRows,
  takeServices,
  satisfies,
  mergeServiceRows,
  reconcileServices,
  recordAfter
} from '../src/uwx/services-request.js'

describe('readServicesRequest — the grammar', () => {
  it('true asks on, false asks off, a map carries the settings', () => {
    expect(
      readServicesRequest({ search: true, submit: false, api: { grade: 'pro' }, assistant: { enabled: false, model: 'x' } })
    ).toEqual([
      { name: 'search' },
      { name: 'submit', enabled: false },
      { name: 'api', config: { grade: 'pro' } },
      { name: 'assistant', enabled: false, config: { model: 'x' } }
    ])
  })

  it('`enabled: true` is the default spelled out, and an empty map asks on', () => {
    expect(readServicesRequest({ search: { enabled: true }, submit: {} })).toEqual([
      { name: 'search' },
      { name: 'submit' }
    ])
  })

  it('nothing asked is null — no key, an empty map, nothing usable', () => {
    expect(readServicesRequest(undefined)).toBeNull()
    expect(readServicesRequest(null)).toBeNull()
    expect(readServicesRequest({})).toBeNull()
    expect(readServicesRequest({ search: 'yes' })).toBeNull()
  })

  it('a value it cannot read is skipped, said, and the rest kept', () => {
    const said = []
    const asks = readServicesRequest(
      { submit: '/forms', search: true, api: { enabled: 'no' }, records: 3 },
      { warn: (m) => said.push(m) }
    )
    expect(asks).toEqual([{ name: 'search' }])
    expect(said).toHaveLength(3)
    // An address is named for where it belongs — the site's own `submit:` key.
    expect(said[0]).toMatch(/top-level `submit:` key/)
    expect(said[1]).toMatch(/services\.api\.enabled/)
  })

  it('a list is not the shape — it was `$services` until 2026-09-20', () => {
    const said = []
    expect(readServicesRequest([{ name: 'search' }], { warn: (m) => said.push(m) })).toBeNull()
    expect(said[0]).toMatch(/is a map of service names/)
  })
})

describe('servicesRequestFromRows — what pull writes', () => {
  it('a row is true, false, or its settings — with enabled: false beside them when off', () => {
    expect(
      servicesRequestFromRows([
        { $id: 'search', name: 'search' },
        { name: 'submit', enabled: false },
        { name: 'tracking', enabled: true },
        { name: 'api', config: { grade: 'pro' } },
        { name: 'assistant', enabled: false, config: { model: 'x' } },
        { name: 'records', config: {} }
      ])
    ).toEqual({
      search: true,
      submit: false,
      tracking: true,
      api: { grade: 'pro' },
      assistant: { enabled: false, model: 'x' },
      records: true
    })
  })

  it('nothing to write is null', () => {
    expect(servicesRequestFromRows([])).toBeNull()
    expect(servicesRequestFromRows(undefined)).toBeNull()
  })

  it('what it writes reads back as the same asks', () => {
    const rows = [{ name: 'api', enabled: false, config: { grade: 'pro' } }, { name: 'search' }]
    expect(readServicesRequest(servicesRequestFromRows(rows))).toEqual(rows)
  })
})

describe('takeServices — the offer to bring site.yml in line', () => {
  it('takes the named services from the site, leaving the others as the owner wrote them', () => {
    const stored = [{ name: 'search', enabled: false }, { name: 'api', config: { grade: 'pro' } }]
    expect(takeServices({ search: true, submit: true }, stored, ['search'])).toEqual({
      search: false,
      submit: true
    })
  })

  it('a service the site holds no row for leaves the map; an emptied map is null', () => {
    expect(takeServices({ search: true }, [], ['search'])).toBeNull()
  })
})

describe('satisfies', () => {
  it('the same switch, and every setting the ask names', () => {
    const row = { name: 'api', config: { grade: 'pro', auth: { providers: ['google'] } } }
    expect(satisfies(row, { name: 'api' })).toBe(true)
    expect(satisfies(row, { name: 'api', config: { grade: 'pro' } })).toBe(true)
    expect(satisfies(row, { name: 'api', config: { grade: 'starter' } })).toBe(false)
    expect(satisfies(row, { name: 'api', enabled: false })).toBe(false)
  })

  it('an absent row satisfies nothing — the site has said nothing about it', () => {
    expect(satisfies(undefined, { name: 'search' })).toBe(false)
  })

  it('setting order is not a difference', () => {
    expect(
      satisfies({ name: 'a', config: { x: { p: 1, q: 2 } } }, { name: 'a', config: { x: { q: 2, p: 1 } } })
    ).toBe(true)
  })
})

describe('mergeServiceRows — the full list sent', () => {
  const STORED = [
    { $id: 'api', name: 'api', enabled: true, config: { grade: 'starter', auth: { providers: ['google'] } }, since: 3 },
    { name: 'search' }
  ]

  it('⭐ every stored row and setting survives an ask about one service', () => {
    expect(mergeServiceRows(STORED, [{ name: 'search', enabled: false }])).toEqual([
      { name: 'api', config: { grade: 'starter', auth: { providers: ['google'] } }, since: 3 },
      { name: 'search', enabled: false }
    ])
  })

  it('an ask\'s settings go over the stored ones, key by key', () => {
    expect(mergeServiceRows(STORED, [{ name: 'api', config: { grade: 'pro' } }])[0]).toEqual({
      name: 'api',
      config: { grade: 'pro', auth: { providers: ['google'] } },
      since: 3
    })
  })

  it('an ask for on clears a stored off; a new service is added', () => {
    expect(mergeServiceRows([{ name: 'submit', enabled: false }], [{ name: 'submit' }, { name: 'tracking' }])).toEqual([
      { name: 'submit' },
      { name: 'tracking' }
    ])
  })

  it('with nothing stored, the asks are the list', () => {
    expect(mergeServiceRows(undefined, [{ name: 'search' }])).toEqual([{ name: 'search' }])
  })
})

describe('reconcileServices — who moved', () => {
  const ON = { name: 'search' }
  const OFF = { name: 'search', enabled: false }

  it('neither moved → nothing', () => {
    expect(reconcileServices({ asks: [ON], record: [ON], stored: [ON] })).toMatchObject({
      send: [],
      adopt: [],
      conflict: []
    })
  })

  it('the file moved → send', () => {
    expect(reconcileServices({ asks: [OFF], record: [ON], stored: [ON] }).send).toEqual(['search'])
  })

  it('⭐ the site moved → adopt, never send — the decision made in the app stands', () => {
    const r = reconcileServices({ asks: [ON], record: [ON], stored: [OFF] })
    expect(r.adopt).toEqual(['search'])
    expect(r.send).toEqual([])
  })

  it('⛔ both moved, differently → conflict', () => {
    const r = reconcileServices({
      asks: [{ name: 'api', config: { grade: 'pro' } }],
      record: [{ name: 'api', config: { grade: 'starter' } }],
      stored: [{ name: 'api', config: { grade: 'team' } }]
    })
    expect(r.conflict).toEqual(['api'])
  })

  it('the site already gives what is asked → nothing, whoever moved', () => {
    expect(reconcileServices({ asks: [OFF], record: [ON], stored: [OFF] })).toMatchObject({
      send: [],
      adopt: [],
      conflict: []
    })
  })

  it('a setting the file does not name moving on the site is not the file\'s business', () => {
    const r = reconcileServices({
      asks: [{ name: 'api', config: { grade: 'pro' } }],
      record: [{ name: 'api', config: { grade: 'pro', seats: 1 } }],
      stored: [{ name: 'api', config: { grade: 'pro', seats: 5 } }]
    })
    expect(r).toMatchObject({ send: [], adopt: [], conflict: [] })
  })

  it('a service new to the file and to the site → send', () => {
    expect(reconcileServices({ asks: [ON], record: [], stored: [] }).send).toEqual(['search'])
  })

  describe('no record — a project that never pulled', () => {
    it('a service the site holds nothing for → send', () => {
      expect(reconcileServices({ asks: [ON], stored: [] }).send).toEqual(['search'])
    })

    it('one it holds differently → conflict: there is no agreement to tell who moved', () => {
      expect(reconcileServices({ asks: [ON], stored: [OFF] }).conflict).toEqual(['search'])
    })
  })

  describe('the site unreadable', () => {
    it('what changed against the record is sent over it', () => {
      expect(reconcileServices({ asks: [OFF], record: [ON] }).send).toEqual(['search'])
      expect(reconcileServices({ asks: [ON], record: [ON] }).send).toEqual([])
    })

    it('⛔ with no record either, an existing site gets nothing — a partial list would drop its rows', () => {
      expect(reconcileServices({ asks: [ON] })).toMatchObject({ send: [], unreadable: true })
    })

    it('a site not created yet has nothing stored — the file is sent', () => {
      expect(reconcileServices({ asks: [ON], siteKnown: false })).toMatchObject({
        send: ['search'],
        unreadable: false
      })
    })
  })
})

describe('recordAfter — the agreement a push leaves', () => {
  it('what was sent, without the payload-local $id and with `enabled` only when off', () => {
    expect(recordAfter({ agreed: [{ $id: 'search', name: 'search', enabled: true }] })).toEqual([{ name: 'search' }])
  })

  it('⛔ an open service keeps the earlier agreement, so the next run still sees the site moved', () => {
    const record = [{ name: 'search' }, { name: 'api', config: { grade: 'starter' } }]
    const agreed = [{ name: 'search', enabled: false }, { name: 'api', config: { grade: 'team' } }]
    expect(recordAfter({ record, agreed, open: ['api'] })).toEqual([
      { name: 'search', enabled: false },
      { name: 'api', config: { grade: 'starter' } }
    ])
    // …and with no earlier agreement for it, the row stays out — still undecided.
    expect(recordAfter({ record: [], agreed, open: ['api'] })).toEqual([{ name: 'search', enabled: false }])
  })

  it('nothing agreed is nothing to record', () => {
    expect(recordAfter({ record: [{ name: 'search' }] })).toBeUndefined()
  })
})
