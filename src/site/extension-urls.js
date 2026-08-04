/**
 * Base-path resolution for foundation / extension module URLs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE: a module URL that reaches the runtime is FINAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The runtime anchors a root-relative module URL to the document origin (which
 * host serves it) and does nothing else — no base prefixing. So when a site is
 * deployed under a subdirectory, the base must be applied HERE, by the producer
 * that knows it, and identically for the primary foundation and every extension.
 *
 * Why the producer and not the loader:
 *
 *  1. A module URL is a SERVE LOCATION, not a path under the site's mount
 *     point. A host may serve a site under one subpath and serve its
 *     foundation from an entirely different root. A loader that prefixed every
 *     root-relative module URL with the site's base would corrupt exactly that
 *     case. Serve locations are read, never constructed.
 *
 *  2. The loader's only available base was `import.meta.env.BASE_URL`, a
 *     BUILD-TIME constant of whichever bundle the runtime shipped in. The
 *     framework already ruled that the wrong authority for the sibling problem
 *     — `setup.js buildDefaultFetcher()` prefers the payload's
 *     `content.config.base` precisely because a host-delivered runtime cannot
 *     know from a build-time constant what subpath its host serves under.
 *
 * Until 2026-08-04 the base step lived in `loadExtensions()` in the runtime and
 * was applied to extensions but NOT to the primary foundation, so one string
 * resolved to two places depending on which slot it sat in. It was harmless
 * only by coincidence: on a bundled static site BASE_URL *is* the site's base,
 * and on a hosted site it is '/' so the step was inert. Two meanings on one
 * variable, agreeing by luck on the only two lanes that existed.
 *
 * Consumers of the resolved value, which is why this lives in one module:
 *   - the payload's `config.extensions` (content-collector) — what the browser loads
 *   - the `<link rel=modulepreload>` hints (site/config.js) — must match the
 *     payload exactly, or the preload warms a URL the runtime never requests
 *   - SSG prerender (prerender.js) maps back to a filesystem path, via
 *     `stripBasePath()` below
 */

/**
 * Root-relative means "starts at the origin root" — `/foo`. A protocol-relative
 * URL (`//cdn.example.com/foo`) is ABSOLUTE and must never be prefixed; the
 * runtime's own resolver treats it as absolute too.
 */
function isRootRelative(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function joinBase(base, url) {
  const prefix = base.endsWith('/') ? base : `${base}/`
  return prefix + url.slice(1)
}

/**
 * Apply a deployment base to a module source, if it is root-relative.
 *
 * Accepts the same union the runtime's loader does: a URL string, or a
 * `{ url, cssUrl }` object. Both fields are resolved — an explicit
 * root-relative `cssUrl` needs the base exactly as much as `url` does, and
 * missing it produces a silent 404 (the runtime tolerates a failed stylesheet
 * by design, so the only symptom is an unstyled foundation).
 *
 * Anything that is not a root-relative URL — an absolute URL, a
 * protocol-relative URL, a relative path, a registry ref like `@org/name@1.2.3`
 * — passes through untouched.
 *
 * @param {string|Object} source - URL string or {url, cssUrl} object
 * @param {string} [base] - Deployment base path ('/' or absent means no-op)
 * @returns {string|Object} The source with the base applied where applicable
 */
export function resolveModuleUrl(source, base) {
  if (!base || base === '/') return source

  if (typeof source === 'string') {
    return isRootRelative(source) ? joinBase(base, source) : source
  }

  if (source && typeof source === 'object') {
    if (!isRootRelative(source.url) && !isRootRelative(source.cssUrl)) return source
    const out = { ...source }
    if (isRootRelative(out.url)) out.url = joinBase(base, out.url)
    if (isRootRelative(out.cssUrl)) out.cssUrl = joinBase(base, out.cssUrl)
    return out
  }

  return source
}

/**
 * Map every entry of a site's `extensions:` list through {@link resolveModuleUrl}.
 * Returns the input untouched when there is nothing to do, so a payload built
 * without a base is byte-identical to before.
 *
 * @param {Array<string|Object>} [extensions]
 * @param {string} [base]
 * @returns {Array<string|Object>|undefined}
 */
export function resolveExtensionUrls(extensions, base) {
  if (!Array.isArray(extensions) || extensions.length === 0) return extensions
  if (!base || base === '/') return extensions
  return extensions.map((entry) => resolveModuleUrl(entry, base))
}

/**
 * Remove a deployment base from a URL, for consumers that need to map a served
 * URL back onto the build tree — SSG prerender resolves `/docs/effects/entry.js`
 * against `dist/`, where the file is at `effects/entry.js`.
 *
 * A URL that does not carry the base is returned unchanged, so this is safe
 * against a payload produced before the base was applied at build time.
 *
 * @param {string} url
 * @param {string} [base]
 * @returns {string}
 */
export function stripBasePath(url, base) {
  if (!base || base === '/' || typeof url !== 'string') return url
  const prefix = base.endsWith('/') ? base : `${base}/`
  return url.startsWith(prefix) ? `/${url.slice(prefix.length)}` : url
}
