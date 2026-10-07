/**
 * `site.yml::services` — the owner's request, what a push states, and what a pull writes
 * (kb/framework/reference/site-services-request.md; the exchange with the backend:
 * kb/framework/plans/services-exchange.md).
 *
 * ⭐ The cases that matter most are the silent ones: a service this copy never saw
 * switched off by a push, a deleted line whose settings stay live, and a pull that fills
 * the file with `false` lines.
 */
import {
  readServicesRequest,
  runtimeServiceConfig,
  runtimeServicesConfig,
  servicesFromDocument,
  statedServices,
  heldServices,
  sameServiceRow,
  refuseRetiredServiceKeys,
  unreadableServices,
  refuseUnreadableServices,
  RENAMED_SERVICES
} from '../src/uwx/services-request.js'

describe('readServicesRequest — what the host is asked', () => {
  it('true asks on, false asks off, a map asks on with the host\'s settings', () => {
    expect(
      readServicesRequest({
        search: true,
        submit: false,
        backend: { grade: 'pro' },
        assistant: { enabled: false, model: 'x' }
      })
    ).toEqual([
      { name: 'search' },
      { name: 'submit', enabled: false },
      { name: 'backend', config: { grade: 'pro' } },
      { name: 'assistant', enabled: false, config: { model: 'x' } }
    ])
  })

  it('⭐ an address means the site brings its own — it rides as `endpoint`, and the host is asked to leave its own off', () => {
    expect(
      readServicesRequest({
        submit: ' https://forms.example.com/f/abc ',
        search: { provider: 'endpoint', endpoint: '/_search', include: { lists: false } }
      })
    ).toEqual([
      { name: 'submit', enabled: false, config: { endpoint: 'https://forms.example.com/f/abc' } },
      { name: 'search', enabled: false, config: { provider: 'endpoint', endpoint: '/_search', include: { lists: false } } }
    ])
  })

  it("⚠️ a `backend` address is said — it turns the host's off, and `/_api` was where the mock answered", () => {
    const said = []
    expect(
      readServicesRequest(
        { backend: '/_api', booking: 'https://book.example.com', submit: '/s' },
        { warn: (m) => said.push(m) }
      )
    ).toEqual([
      { name: 'backend', enabled: false, config: { endpoint: '/_api' } },
      { name: 'booking', enabled: false, config: { endpoint: 'https://book.example.com' } },
      { name: 'submit', enabled: false, config: { endpoint: '/s' } }
    ])
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/`services\.backend` is an address: it asks your host to leave its own `backend` off/)
    expect(said[0]).toMatch(/write `backend: true`; in `uniweb dev`, `\$devBackend` answers it/)
  })

  it('⭐ the row carries the whole entry — the options the page reads and the host\'s settings, in one `config`', () => {
    expect(
      readServicesRequest({
        search: { exclude: { routes: ['/legal'] } },
        tracking: { consent: 'required', emit: 'minimal', retentionDays: 30 }
      })
    ).toEqual([
      { name: 'search', config: { exclude: { routes: ['/legal'] } } },
      { name: 'tracking', config: { consent: 'required', emit: 'minimal', retentionDays: 30 } }
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
      { search: true, backend: { enabled: 'no' }, tracking: 7, records: '/_query' },
      { warn: (m) => said.push(m) }
    )
    expect(asks).toEqual([{ name: 'search' }])
    expect(said).toHaveLength(3)
    expect(said[0]).toMatch(/services\.backend\.enabled/)
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

  it("⛔ only backend's switch and address — its settings are for the host that provisions it", () => {
    expect(runtimeServiceConfig('backend', { grade: 'pro' })).toBeUndefined()
    expect(runtimeServiceConfig('backend', { endpoint: 'https://b.example/_api', grade: 'pro' })).toEqual({
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
  it('⭐ each row is the whole entry — `enabled` the switch, `config` everything else', () => {
    expect(
      servicesFromDocument({
        rows: [
          { $id: 'search', name: 'search', config: { exclude: { routes: ['/legal'] } } },
          { name: 'submit', enabled: false },
          { name: 'backend', config: { grade: 'pro' } },
          { name: 'assistant', enabled: false, config: { model: 'x' } },
          { name: 'tracking' }
        ],
        local: { submit: true }
      })
    ).toEqual({
      search: { exclude: { routes: ['/legal'] } },
      // Off, and named by the file: written, so the file says what the site has.
      submit: false,
      backend: { grade: 'pro' },
      // Off, with settings: the switch beside them.
      assistant: { enabled: false, model: 'x' },
      tracking: true
    })
  })

  it("⭐ an address with the host's own off is the site's own provider, written as it was", () => {
    expect(
      servicesFromDocument({
        rows: [
          { name: 'submit', enabled: false, config: { endpoint: 'https://forms.example.com/f' } },
          { name: 'search', enabled: false, config: { provider: 'endpoint', endpoint: '/_search' } }
        ]
      })
    ).toEqual({
      submit: 'https://forms.example.com/f',
      search: { provider: 'endpoint', endpoint: '/_search' }
    })
  })

  it("an address with the host's own on is dropped — the host's offer answers", () => {
    expect(
      servicesFromDocument({
        rows: [
          { name: 'submit', config: { endpoint: '/forms' } },
          { name: 'tracking', config: { endpoint: '/collect', emit: 'minimal' } }
        ]
      })
    ).toEqual({ submit: true, tracking: { emit: 'minimal' } })
  })

  it("⭐ keeps the author's credential — never sent, so a pull does not delete it", () => {
    expect(
      servicesFromDocument({
        rows: [
          { name: 'assistant', config: { system: 'Be brief.' } },
          { name: 'tracking' },
          { name: 'submit', enabled: false }
        ],
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

  it('CONTROL — everything but a credential is the row\'s, never the file\'s', () => {
    expect(
      servicesFromDocument({
        rows: [{ name: 'search', config: { exclude: { routes: ['/b'] } } }],
        local: { search: { exclude: { routes: ['/a'] }, include: { lists: false } } }
      })
    ).toEqual({ search: { exclude: { routes: ['/b'] } } })
  })

  it('⭐ an off service with no settings is written only where site.yml already names it', () => {
    // Off is the default, so a `false` line adds nothing — a deleted line stays deleted,
    // and a service switched off in the app the file never named adds no line. A file
    // that lists one the site switched off says so; left `true`, its next push would
    // switch it back on. [Diego, 2026-10-07]
    const rows = [{ name: 'search', enabled: false }, { name: 'assistant', enabled: false }, { name: 'tracking' }]
    expect(servicesFromDocument({ rows })).toEqual({ tracking: true })
    expect(servicesFromDocument({ rows, local: { search: true } })).toEqual({ search: false, tracking: true })
    // CONTROL — off WITH settings is written whatever the file names: it says something.
    expect(servicesFromDocument({ rows: [{ name: 'submit', enabled: false, config: { endpoint: '/f' } }] })).toEqual({
      submit: '/f'
    })
  })

  it('nothing to write is null', () => {
    expect(servicesFromDocument({ rows: [] })).toBeNull()
    expect(servicesFromDocument({})).toBeNull()
    expect(servicesFromDocument({ rows: [{ name: 'search', enabled: false }] })).toBeNull()
  })

  it('what it writes reads back as the same asks', () => {
    const rows = [
      { name: 'backend', enabled: false, config: { grade: 'pro' } },
      { name: 'search', config: { exclude: { routes: ['/x'] } } },
      { name: 'submit', enabled: false, config: { endpoint: '/s' } }
    ]
    expect(readServicesRequest(servicesFromDocument({ rows }))).toEqual(rows)
  })
})

describe('refuseRetiredServiceKeys', () => {
  it('names each retired key, and how to move it', () => {
    expect(() => refuseRetiredServiceKeys({ name: 'S', search: false, tracking: '/_t' })).toThrow(
      /`search:`, `tracking:` are retired — a service lives under `services:`/
    )
  })

  it('says what became of `api:` — `$devBackend` supplies the address in `uniweb dev`', () => {
    expect(() => refuseRetiredServiceKeys({ api: '/_api' })).toThrow(/`\$devBackend` now supplies it/)
    expect(() => refuseRetiredServiceKeys({ api: '/_api' })).toThrow(/is `backend: true` under `services:`/)
  })

  // ⛔ The block it prints is the one to paste, so it names each service as `services:`
  // does now — `api` would be refused there next.
  it('the block to move them into names the site\'s own backend `backend`', () => {
    expect(() => refuseRetiredServiceKeys({ api: '/_api', search: true })).toThrow(/services:\n {2}search: …\n {2}backend: …/)
  })

  it('⛔ `$devApi` is refused by that name, naming `$devBackend` — the key followed its service', () => {
    expect(() => refuseRetiredServiceKeys({ name: 'S', $devApi: './mock/api.js' }, 'site.yml')).toThrow(
      /^\[uniweb\] site\.yml: `\$devApi:` is now `\$devBackend:` — it names what answers the site's `backend` service/
    )
    expect(() => refuseRetiredServiceKeys({ name: 'S', $devBackend: './mock/api.js' })).not.toThrow()
  })

  it('a file with none passes', () => {
    expect(() => refuseRetiredServiceKeys({ name: 'S', services: { search: true } })).not.toThrow()
  })
})

describe('unreadableServices / refuseUnreadableServices — what neither lane can read', () => {
  it('true, false, an address and a map are read — and no services at all', () => {
    expect(
      unreadableServices({
        search: true,
        submit: false,
        assistant: 'https://ai.example.com/chat',
        tracking: { consent: 'required' },
        backend: { enabled: false, grade: 'pro' },
        records: true
      })
    ).toEqual([])
    expect(unreadableServices(undefined)).toEqual([])
    expect(() => refuseUnreadableServices({ name: 'S' })).not.toThrow()
  })

  it("⭐ YAML 1.1's words for a switch are text to js-yaml — each named, with what to write (F14)", () => {
    const found = unreadableServices({ search: 'yes', submit: 'Off', tracking: 'y', assistant: 'TRUE' })
    expect(found).toHaveLength(4)
    expect(found[0]).toMatch(/`services\.search` is the text `yes`, not a switch — YAML reads yes, no, on and off as words\. Write `search: true` to turn it on\./)
    expect(found[1]).toMatch(/Write `submit: false` to turn it off/)
    expect(found[2]).toMatch(/Write `tracking: true`/)
    expect(found[3]).toMatch(/`services\.assistant` is the text `TRUE`/)
  })

  it('an empty entry, a number, a list, a non-boolean `enabled`, and an address for `records`', () => {
    expect(unreadableServices({ a: null, b: '', c: 4, d: ['x'], e: { enabled: 1 }, records: { endpoint: '/q' } })).toEqual([
      '`services.a` is true, false, an address, or a map — not empty.',
      '`services.b` is empty — write true, false, an address, or a map.',
      '`services.c` is true, false, an address, or a map — not `4`.',
      '`services.d` is true, false, an address, or a map — not a list.',
      '`services.e.enabled` is true or false — not `1`.',
      '`services.records` has no address of its own — your host provides it. Remove `endpoint`.'
    ])
  })

  // ⛔ THE RENAME (2026-10-07): the site's own backend is the `backend` service. `api` is
  // not an alias — a host offers nothing by that name now, so the page would lose the
  // service silently; it stops here, in the build and the push, whatever its value.
  it('⛔ `services.api` is refused by that name, whatever it says, naming `backend`', () => {
    for (const value of [true, false, '/_api', { grade: 'pro' }]) {
      expect(unreadableServices({ api: value })).toEqual([
        "`services.api` is now `services.backend` — the site's own backend is the `backend` service. " +
          'Rename the entry; what it says stays. On a site you push, `uniweb pull` brings it renamed.'
      ])
    }
    expect(() => refuseUnreadableServices({ services: { api: true } }, 'site.yml')).toThrow(/^\[uniweb\] site\.yml: `services\.api` is now `services\.backend`/)
    expect(RENAMED_SERVICES).toEqual({ api: 'backend' })
  })

  it('CONTROL — the renamed service reads as any other', () => {
    expect(readServicesRequest({ backend: true })).toEqual([{ name: 'backend' }])
    expect(readServicesRequest({ api: true }, { warn: () => {} })).toBeNull()
  })

  it('refuses with the file named, one entry inline and several listed', () => {
    expect(() => refuseUnreadableServices({ services: { search: 'on' } }, 'site.yml')).toThrow(
      /^\[uniweb\] site\.yml: `services\.search` is the text `on`/
    )
    expect(() => refuseUnreadableServices({ services: { search: 'on', submit: 3 } })).toThrow(
      /cannot be read:\n {2}- `services\.search`[^\n]*\n {2}- `services\.submit`/
    )
    expect(() => refuseUnreadableServices({ services: [{ name: 'search' }] })).toThrow(/is a map of service names/)
  })
})

describe('statedServices — what a push states', () => {
  const asks = (services) => readServicesRequest(services)

  it("⭐ every service the file lists, as it says it — whole, with the held one's $uuid", () => {
    expect(
      statedServices(asks({ search: { exclude: { routes: ['/x'] } }, submit: false, backend: true }), { search: 'U-s' })
    ).toEqual([
      { name: 'search', config: { exclude: { routes: ['/x'] } }, $uuid: 'U-s' },
      { name: 'submit', enabled: false },
      { name: 'backend' }
    ])
  })

  it('⭐ a held service the file no longer lists is stated OFF, with no settings', () => {
    // Deleting the line turns it off and removes its settings — kept, an own provider
    // would stay live on the page and come back with the next pull.
    expect(statedServices(asks({ search: true }), { search: 'U-s', submit: 'U-f' })).toEqual([
      { name: 'search', $uuid: 'U-s' },
      { name: 'submit', enabled: false, $uuid: 'U-f' }
    ])
  })

  it('⛔ a service this copy never saw is not sent — the site keeps it', () => {
    const rows = statedServices(asks({ search: true }), {})
    expect(rows.map((r) => r.name)).toEqual(['search'])
  })

  it('nothing listed and nothing held is nothing to state; a malformed hold is ignored', () => {
    expect(statedServices(null, {})).toEqual([])
    expect(statedServices(null, [{ name: 'search' }])).toEqual([])
    expect(statedServices(null, { search: '' })).toEqual([])
  })
})

describe('heldServices — which services this copy holds after a push or a pull', () => {
  const written = [
    { $uuid: 'U-s', name: 'search' },
    { $uuid: 'U-a', name: 'backend', config: { grade: 'pro' } },
    { $uuid: 'U-new', name: 'assistant' },
    { name: 'tracking' }
  ]

  it('a pull holds every service the site has that carries a $uuid', () => {
    expect(heldServices({ written })).toEqual({ backend: 'U-a', assistant: 'U-new', search: 'U-s' })
  })

  it('⛔ a push holds what it stated and what was held before — never a service added on the site since', () => {
    // Held, the next push would state `assistant` off: switching off a service nobody
    // here has seen.
    expect(heldServices({ written, sent: [{ name: 'search' }], prior: { backend: 'U-a' } })).toEqual({
      backend: 'U-a',
      search: 'U-s'
    })
  })

  it('a service the site no longer has is no longer held', () => {
    expect(heldServices({ written: [{ $uuid: 'U-s', name: 'search' }], sent: [], prior: { search: 'U-s', submit: 'U-f' } })).toEqual({
      search: 'U-s'
    })
  })
})

describe('sameServiceRow — a service written as a push sent it', () => {
  it('compares the switch and the WHOLE config', () => {
    expect(sameServiceRow({ name: 'search' }, { $uuid: 'U', name: 'search', enabled: true })).toBe(true)
    // ⛔ On the keys we sent (`name`) these are equal — and they are not the same service.
    expect(sameServiceRow({ name: 'search' }, { name: 'search', enabled: false })).toBe(false)
    expect(sameServiceRow({ name: 'backend' }, { name: 'backend', config: { grade: 'pro' } })).toBe(false)
    expect(sameServiceRow({ name: 'backend', config: { grade: 'pro' } }, { name: 'backend', config: { grade: 'pro' } })).toBe(true)
  })
})
