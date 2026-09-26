/**
 * A PREVIEW OF A SITE A BACKEND HOLDS — what `uniweb dev` read from that backend, handed to the one
 * dev server it starts.
 *
 * A clone names its foundation by catalog ref (`@acme/fnd@1.2.0`) and keeps the media URLs the
 * backend serves, so two things its dev server needs are the backend's to say. `uniweb dev` asks the
 * backend the site is on, through the site, and passes what it learned in `UNIWEB_PREVIEW`, as JSON:
 *
 *   { backend: 'https://…',                              the backend the site is on
 *     foundation: { ref, url, cssUrl } }                 where it serves the version site.yml names
 *
 * ⭐ It resolves the declared foundation; it never substitutes one. The answer names the ref it is
 * for, and `detectFoundationType` honors it for that ref alone — which is what separates it from the
 * `UNIWEB_FOUNDATION_REF` override `config.js` retired, a way for a site to be rendered by code its
 * own `site.yml` did not name.
 *
 * ⭐ And a media URL the clone kept is the backend's own. A pull keeps any serve URL it cannot map
 * back to an author's file (`uwx/asset-map.js::restoreAssetRefs`, *"the URL that works"*), and a
 * root-relative one works on the origin that served the document holding it. So the dev server
 * fetches from `backend` what the content names and the site does not have (`config.js`) — it
 * resolves the URL it was given against the origin it came from, and composes no route.
 *
 * ⛔ Nothing keeps it. A serve location is decided at publish and read from the response that
 * carries it, so it lives as long as the process that asked: `site.yml` keeps the ref, and no push,
 * pull or build sees a URL from here. A build handed one refuses it (`config.js`), so a preview's
 * answer never reaches a built artifact.
 *
 * ⚠️ And it may not be known. Whether a backend tells the CLI where a version is served is the
 * backend's to decide; `uniweb dev` says so and starts nothing when it is not told.
 */

/** The variable `uniweb dev` sets for the dev server it starts. */
export const PREVIEW_ENV = 'UNIWEB_PREVIEW'

/**
 * The variable's value.
 *
 * @param {{ backend: string, foundation: { ref: string, url: string, cssUrl?: string|null } }} preview
 * @returns {string}
 */
export function encodePreview({ backend, foundation }) {
  const { ref, url, cssUrl = null } = foundation
  return JSON.stringify({ backend, foundation: { ref, url, cssUrl: cssUrl || null } })
}

/**
 * What a dev server was handed, or null when it was handed nothing.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ backend: string, foundation: { ref: string, url: string, cssUrl: string|null } }|null}
 * @throws {Error} when the variable is set and says nothing usable — a preview that cannot read its
 *   answer must not start as if it had none
 */
export function readPreview(env = process.env) {
  const raw = env[PREVIEW_ENV]
  if (!raw) return null
  let given = null
  try {
    given = JSON.parse(raw)
  } catch {
    // reported below
  }
  const f = given?.foundation
  if (!isHttpOrigin(given?.backend) || typeof f?.ref !== 'string' || typeof f.url !== 'string' || !f.url) {
    throw new Error(
      `${PREVIEW_ENV} holds no preview (${JSON.stringify(raw).slice(0, 120)}). ` +
        'It is set by `uniweb dev`; run that rather than setting it.'
    )
  }
  return {
    backend: new URL(given.backend).origin,
    foundation: { ref: f.ref, url: f.url, cssUrl: typeof f.cssUrl === 'string' ? f.cssUrl : null }
  }
}

// ⛔ `new URL('localhost:8080')` parses — as the scheme `localhost:` — and its origin is the string
// "null". An origin is http(s), or it is nothing.
function isHttpOrigin(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}
