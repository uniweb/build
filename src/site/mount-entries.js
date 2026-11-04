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
 * A leaf, with no imports, so a module that must stay light can ask it.
 *
 * @param {Object} pathsConfig - The paths: object from site.yml
 * @returns {Array<[string, string]>} [routeSegment, relativePath] pairs
 */
export function mountEntriesOf(pathsConfig) {
  if (!pathsConfig || typeof pathsConfig !== 'object') return []
  return Object.entries(pathsConfig)
    .filter(([key]) => key.startsWith('pages/'))
    .map(([key, value]) => [key.slice('pages/'.length), value])
}
