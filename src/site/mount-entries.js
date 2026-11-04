/**
 * The `pages/<segment>` keys in a site.yml `paths:` group, unvalidated.
 *
 * Split out from resolveMounts so the dev server can learn which directories a
 * site mounts without re-running resolveMounts' validation — that would repeat
 * its warnings on every startup, and the watcher only needs paths. Every reader —
 * the collector, the watcher, a pull (`uwx/page-files.js`), the roots a push sends
 * and a pull merges (`uwx/site-dirs.js`) and `uniweb status` among them — shares this
 * one definition of what a mount key looks like, so the prefix can never mean one
 * thing to one of them and another to the next.
 *
 * A mount is a folder, `pages/docs: ../docs`, or an object saying more of it,
 * `pages/docs: { path: ../docs, writable: true }`: each reader here is handed the
 * folder, and `mountDeclarationsOf` the rest (`resolveMounts` refuses a malformed one).
 *
 * A leaf, with no imports, so a module that must stay light can ask it.
 *
 * @param {Object} pathsConfig - The paths: object from site.yml
 * @returns {Array<[string, string]>} [routeSegment, relativePath] pairs
 */
export function mountEntriesOf(pathsConfig) {
  return mountDeclarationsOf(pathsConfig).map(({ segment, path }) => [segment, path])
}

/**
 * Each mount with what its declaration says: its route `segment`, its folder's `path`, and whether
 * a pull may write into it (`writable`) — ⭐ a pull writes a mounted folder only where the site says
 * so; the string form only reads.
 *
 * @param {Object} pathsConfig - The paths: object from site.yml
 * @returns {Array<{ segment: string, path: string, writable: boolean, declared: unknown }>}
 */
export function mountDeclarationsOf(pathsConfig) {
  if (!pathsConfig || typeof pathsConfig !== 'object') return []
  return Object.entries(pathsConfig)
    .filter(([key]) => key.startsWith('pages/'))
    .map(([key, value]) => {
      const object = value !== null && typeof value === 'object' && !Array.isArray(value)
      return {
        segment: key.slice('pages/'.length),
        path: object ? value.path : value,
        writable: object && value.writable === true,
        declared: value,
      }
    })
}
