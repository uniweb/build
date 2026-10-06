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
  runtimeServiceConfig,
  runtimeServicesConfig,
  servicesFromDocument,
  takeServices,
  refuseRetiredServiceKeys,
  satisfies,
  mergeServiceRows,
  reconcileServices,
  recordAfter
} from '../src/uwx/services-request.js'

describe('readServicesRequest — what the host is asked', () => {
  it('true asks on, false asks off, a map asks on with the host\'s settings', () => {
    expect(
      readServicesRequest({
        search: true,
        submit: false,
        api: { grade: 'pro' },
        assistant: { enabled: false, model: 'x' }
      })
    ).toEqual([
      { name: 'search' },
      { name: 'submit', enabled: false },
      { name: 'api', config: { grade: 'pro' } },
      { name: 'assistant', enabled: false, config: { model: 'x' } }
    ])
  })

  it('⭐ an address means the site brings its own — the host is asked to leave its own off', () => {
    expect(
      readServicesRequest({
        submit: 'https://forms.example.com/f/abc',
        search: { provider: 'endpoint', endpoint: '/_search', include: { lists: false } }
      })
    ).toEqual([
      { name: 'submit', enabled: false },
      { name: 'search', enabled: false }
    ])
  })

  it('⚠️ an address a push cannot carry is said — only the four with a settings slot travel', () => {
    const said = []
    expect(
      readServicesRequest(
        { api: '/_api', booking: 'https://book.example.com', submit: '/s' },
        { warn: (m) => said.push(m) }
      )
    ).toEqual([
      { name: 'api', enabled: false },
      { name: 'booking', enabled: false },
      { name: 'submit', enabled: false }
    ])
    expect(said).toHaveLength(2)
    expect(said[0]).toMatch(/`services\.api` is an address, which a push does not carry/)
    expect(said[0]).toMatch(/write `api: true`; `\$devApi` answers it/)
    expect(said[1]).toMatch(/`services\.booking` is an address/)
    expect(said[1]).not.toMatch(/devApi/)
  })

  it('the options the runtime reads are not the host\'s settings', () => {
    expect(
      readServicesRequest({
        search: { exclude: { routes: ['/legal'] } },
        tracking: { consent: 'required', emit: 'minimal', retentionDays: 30 }
      })
    ).toEqual([
      { name: 'search' },
      { name: 'tracking', config: { retentionDays: 30 } }
    ])
  })

  it('a service the framework does not know sends every key as the host\'s', () => {
    expect(readServicesRequest({ booking: { calendar: 'team' } })).toEqual([
      { name: 'booking', config: { calendar: 'team' } }
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
    expect(readServicesRequest({ search: 3 })).toBeNull()
  })

  it('a value it cannot read is skipped, said, and the rest kept', () => {
    const said = []
    const asks = readServicesRequest(
      { search: true, api: { enabled: 'no' }, tracking: 7, records: '/_query' },
      { warn: (m) => said.push(m) }
    )
    expect(asks).toEqual([{ name: 'search' }])
    expect(said).toHaveLength(3)
    expect(said[0]).toMatch(/services\.api\.enabled/)
    expect(said[2]).toMatch(/`services\.records` has no address of its own/)
  })

  it('⛔ a credential is never sent, and the owner is told where it belongs', () => {
    const said = []
    expect(
      readServicesRequest({ assistant: { system: 'Be helpful.', apiKey: 'sk-live' } }, { warn: (m) => said.push(m) })
    ).toEqual([{ name: 'assistant', config: { system: 'Be helpful.' } }])
    expect(said[0]).toMatch(/`apiKey` — a credential is never sent or published\. Set it in the app/)
  })

  it('a list is not the shape — it was `$services` until 2026-09-20', () => {
    const said = []
    expect(readServicesRequest([{ name: 'search' }], { warn: (m) => said.push(m) })).toBeNull()
    expect(said[0]).toMatch(/is a map of service names/)
  })
})

describe('runtimeServiceConfig — what the site\'s config carries', () => {
  it('false, an address, or the entry\'s options; true says nothing', () => {
    expect(runtimeServiceConfig('search', false)).toBe(false)
    expect(runtimeServiceConfig('submit', '/forms')).toBe('/forms')
    expect(runtimeServiceConfig('search', true)).toBeUndefined()
    expect(runtimeServiceConfig('search', { enabled: true })).toBeUndefined()
    expect(runtimeServiceConfig('search', { enabled: false, exclude: { routes: ['/x'] } })).toEqual({
      enabled: false,
      exclude: { routes: ['/x'] }
    })
  })

  it('⭐ the whole entry for the services a host also reads from the site — the assistant\'s persona', () => {
    expect(runtimeServiceConfig('assistant', { system: 'Be helpful.', model: 'x' })).toEqual({
      system: 'Be helpful.',
      model: 'x'
    })
  })

  it("⛔ only api's switch and address — its settings are for the host that provisions it", () => {
    expect(runtimeServiceConfig('api', { grade: 'pro' })).toBeUndefined()
    expect(runtimeServiceConfig('api', { endpoint: 'https://b.example/_api', grade: 'pro' })).toEqual({
      endpoint: 'https://b.example/_api'
    })
  })

  it('⛔ never a credential, and never records — the host alone provides it', () => {
    expect(runtimeServiceConfig('tracking', { endpoint: '/_t', token: 'secret' })).toEqual({ endpoint: '/_t' })
    expect(runtimeServiceConfig('records', false)).toBeUndefined()
  })

  it('runtimeServicesConfig gathers every entry the runtime has something for, and says what it dropped', () => {
    const said = []
    expect(
      runtimeServicesConfig(
        { search: true, submit: '/forms', tracking: { consent: 'required', key: 'k' } },
        { warn: (m) => said.push(m) }
      )
    ).toEqual({ submit: '/forms', tracking: { consent: 'required' } })
    expect(said[0]).toMatch(/`key`/)
  })
})

describe('servicesFromDocument — what pull writes', () => {
  it('the row decides on or off and carries the host\'s settings; the site tier carries the options', () => {
    expect(
      servicesFromDocument({
        rows: [
          { $id: 'search', name: 'search' },
          { name: 'submit', enabled: false },
          { name: 'api', config: { grade: 'pro' } },
          { name: 'assistant', enabled: false, config: { model: 'x' } }
        ],
        settings: { search: { exclude: { routes: ['/legal'] } }, tracking: { consent: 'required' } }
      })
    ).toEqual({
      search: { exclude: { routes: ['/legal'] } },
      tracking: { consent: 'required' },
      submit: false,
      api: { grade: 'pro' },
      assistant: { enabled: false, model: 'x' }
    })
  })

  it('⭐ an address with the host\'s own off is the site\'s own provider, written as it was', () => {
    expect(
      servicesFromDocument({
        rows: [{ name: 'submit', enabled: false }],
        settings: { submit: { endpoint: 'https://forms.example.com/f' } }
      })
    ).toEqual({ submit: { endpoint: 'https://forms.example.com/f' } })
  })

  it('an address with the host\'s own on is dropped — the host\'s offer answers', () => {
    expect(
      servicesFromDocument({ rows: [{ name: 'submit' }], settings: { submit: '/forms' } })
    ).toEqual({ submit: true })
  })

  it('⭐ keeps an address the wire cannot carry while the host\'s stays off — and drops it once it is on', () => {
    // `api` has no `settings` slot: the push sent only `enabled: false`.
    expect(
      servicesFromDocument({ rows: [{ name: 'api', enabled: false }], local: { api: 'https://own.example' } })
    ).toEqual({ api: 'https://own.example' })
    expect(
      servicesFromDocument({ rows: [{ name: 'booking', enabled: false }], local: { booking: { endpoint: '/b' } } })
    ).toEqual({ booking: { endpoint: '/b' } })
    expect(
      servicesFromDocument({ rows: [{ name: 'api' }], local: { api: 'https://own.example' } })
    ).toEqual({ api: true })
  })

  it('CONTROL — an address the wire carries is the document\'s, never the file\'s', () => {
    expect(
      servicesFromDocument({
        rows: [{ name: 'search', enabled: false }],
        settings: { search: { provider: 'endpoint', endpoint: '/s2' } },
        local: { search: { provider: 'endpoint', endpoint: '/s1' } }
      })
    ).toEqual({ search: { provider: 'endpoint', endpoint: '/s2' } })
  })

  it('⭐ keeps the author\'s credential — never sent, so a pull does not delete it', () => {
    expect(
      servicesFromDocument({
        rows: [{ name: 'assistant', config: { system: 'Be brief.' } }, { name: 'tracking' }, { name: 'submit', enabled: false }],
        settings: { assistant: { system: 'Be brief.' } },
        local: {
          assistant: { system: 'Be terse.', apiKey: 'sk-1' },
          tracking: { token: 't-1' },
          submit: { enabled: false, secret: 's-1' }
        }
      })
    ).toEqual({
      assistant: { system: 'Be brief.', apiKey: 'sk-1' },
      tracking: { token: 't-1' },
      submit: { enabled: false, secret: 's-1' }
    })
  })

  it('nothing to write is null', () => {
    expect(servicesFromDocument({ rows: [] })).toBeNull()
    expect(servicesFromDocument({})).toBeNull()
  })

  it('what it writes reads back as the same asks', () => {
    const rows = [{ name: 'api', enabled: false, config: { grade: 'pro' } }, { name: 'search' }]
    expect(readServicesRequest(servicesFromDocument({ rows }))).toEqual(rows)
  })
})

describe('takeServices — the offer to bring site.yml in line', () => {
  it("takes the site's switch and settings; the entry's options stay", () => {
    const stored = [{ name: 'search', enabled: false }, { name: 'api', config: { grade: 'pro' } }]
    expect(
      takeServices({ search: { exclude: { routes: ['/x'] } }, submit: true }, stored, ['search'])
    ).toEqual({ search: { enabled: false, exclude: { routes: ['/x'] } }, submit: true })
  })

  it("an own address goes when the site's host now provides the service", () => {
    expect(takeServices({ submit: '/forms' }, [{ name: 'submit' }], ['submit'])).toEqual({ submit: true })
  })

  it('a service the site holds no row for leaves the map; an emptied map is null', () => {
    expect(takeServices({ search: true }, [], ['search'])).toBeNull()
  })
})

describe('refuseRetiredServiceKeys', () => {
  it('names each retired key, and how to move it', () => {
    expect(() => refuseRetiredServiceKeys({ name: 'S', search: false, tracking: '/_t' })).toThrow(
      /`search:`, `tracking:` are retired — a service lives under `services:`/
    )
  })

  it('says what became of `api:` — `$devApi` supplies the address in `uniweb dev`', () => {
    expect(() => refuseRetiredServiceKeys({ api: '/_api' })).toThrow(/`\$devApi` now supplies it/)
  })

  it('a file with none passes', () => {
    expect(() => refuseRetiredServiceKeys({ name: 'S', services: { search: true } })).not.toThrow()
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
