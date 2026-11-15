/**
 * THE SITE AS PUBLISHED — what `uniweb dev --published` read from a published site, handed to the
 * one dev server it starts.
 *
 * A site's services — its own `backend`, its `records`, its forms — are its host's to answer once
 * the site is published, at addresses the host chooses. `uniweb dev --published` serves the working
 * copy, its foundation and pages with live reload, against those services. `uniweb dev` reads the
 * host's answer from the published page itself (`__DATA__`, `content.config.services`) and passes
 * it in `UNIWEB_PUBLISHED`, as JSON:
 *
 *   { site: 'https://…/',                     the published page the services were read from
 *     backend: 'https://…',                   the backend the site is published from
 *     base: '/' | null,                       that page's `config.base`
 *     services: { backend: '/_api', … } }     the host's block, as the page carries it
 *
 * The dev server then plays the host (`../dev/published-mount.js`): its payload carries that block
 * with each address replaced by one of its own, under `PUBLISHED_MOUNT`, and it forwards a request
 * for one of those to the published address. The page sees one origin, so a sign-in cookie is
 * first-party, as it is on the published site, and a query is answered by the site's records
 * service, the entries its public queries open included, as a visitor's is.
 *
 * ⭐ Read, never composed. A host owns its services' addresses and states them in the page it
 * serves (`@uniweb/core/services`), so one is resolved as the published page's runtime resolves it
 * (`resolveServiceUrl`, with that page's base) and against that page's address, and nothing here
 * knows a route.
 *
 * ⛔ Nothing keeps it. It lives as long as the dev server, as a preview does (`./preview.js`), and a
 * build handed it refuses it (`./config.js`), so a published site's addresses never reach a built
 * artifact.
 */
import { readEndpoint, resolveServiceUrl } from '@uniweb/core/services'

/** The variable `uniweb dev --published` sets for the dev server it starts. */
export const PUBLISHED_ENV = 'UNIWEB_PUBLISHED'

/** Where the dev server answers the published site's services: `/_published/<service>/…`. */
export const PUBLISHED_MOUNT = '/_published'

/**
 * The variable's value.
 *
 * @param {{ site: string, backend: string, base?: string|null, services: object }} published
 * @returns {string}
 */
export function encodePublished({ site, backend, base = null, services }) {
  return JSON.stringify({ site, backend, base: typeof base === 'string' ? base : null, services })
}

/**
 * What a dev server was handed, or null when it was handed nothing.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ site: string, backend: string, base: string|null, services: object }|null}
 * @throws {Error} when the variable is set and says nothing usable: a dev server told to use a
 *   published site's services must not start on its own mock instead
 */
export function readPublished(env = process.env) {
  const raw = env[PUBLISHED_ENV]
  if (!raw) return null
  let given = null
  try {
    given = JSON.parse(raw)
  } catch {
    // reported below
  }
  if (!isHttpUrl(given?.site) || !isHttpUrl(given?.backend) || !isPlainObject(given?.services)) {
    throw new Error(
      `${PUBLISHED_ENV} holds no published site (${JSON.stringify(raw).slice(0, 120)}). ` +
        'It is set by `uniweb dev --published`; run that rather than setting it.'
    )
  }
  return {
    site: new URL(given.site).href,
    backend: new URL(given.backend).origin,
    base: typeof given.base === 'string' ? given.base : null,
    services: given.services,
  }
}

/**
 * The services block the dev payload carries — the host's, each address replaced by one of the dev
 * server's — and the origin each service forwards to.
 *
 * An address keeps everything after its origin as written, a `{locale}` slot included, under
 * `/_published/<service>`: the published `records` at `/_query/{locale}` becomes
 * `/_published/records/_query/{locale}`, and a request for `/_published/records/_query/fr` goes to
 * `<its origin>/_query/fr`. A service the host names with no address is carried as it is: the host
 * answered, and offered none.
 *
 * @param {{ site: string, base?: string|null, services: object }} published - from `readPublished`
 * @returns {{ services: object, targets: Record<string, string> }} targets: service → origin
 */
export function localServices({ site, base = null, services }) {
  const local = {}
  const targets = {}
  for (const [name, value] of Object.entries(services)) {
    const endpoint = readEndpoint(value)
    if (!endpoint || !SERVICE_NAME.test(name)) {
      local[name] = value
      continue
    }
    const { origin, rest } = splitAddress(resolveServiceUrl(endpoint, base || ''), site)
    targets[name] = origin
    const address = `${PUBLISHED_MOUNT}/${name}${rest}`
    local[name] = typeof value === 'string' ? address : { ...value, endpoint: address }
  }
  return { services: local, targets }
}

// A segment of the dev server's own address, so only a name that is one.
const SERVICE_NAME = /^[A-Za-z0-9_-]+$/

/**
 * An address the runtime would ask, split into the origin it goes to and the rest, kept as written
 * so a `{locale}` slot survives: `new URL` would encode the braces.
 */
function splitAddress(address, site) {
  const absolute = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*)(.*)$/i.exec(address)
  if (absolute) {
    const [, head, tail] = absolute
    const origin = new URL(head.startsWith('//') ? `${new URL(site).protocol}${head}` : head).origin
    return { origin, rest: tail.startsWith('/') ? tail : `/${tail}` }
  }
  return { origin: new URL(site).origin, rest: address.startsWith('/') ? address : `/${address}` }
}

// ⛔ `new URL('localhost:8080')` parses — as the scheme `localhost:` — so a URL is http(s) or nothing.
function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
